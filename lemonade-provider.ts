// omp extension: lemonade-server provider with capability-aware discovery.
//
// Registers a "lemonade" provider whose fetchDynamicModels maps lemonade's
// /v1/models `labels` onto omp model metadata: the `reasoning` label onto a
// thinking effort ladder (off => reasoning_effort:"none"), `vision` onto
// image input, `chat` onto the roster filter, and the reported-or-derived
// output cap onto maxTokens. Models that reason without the `reasoning` label
// are tracked in the gitignored extra-reasoning.local.json next to this file;
// run /lemonade-probe inside omp to populate it. Install, configuration, and
// limitations: see README.md.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Trailing slashes in the override would produce `//v1/...` request paths.
const LEMONADE_BASE_URL = (process.env.LEMONADE_BASE_URL ?? "http://localhost:13305").replace(/\/+$/, "");

// Per-probe wall-clock budget. Generous because probing a cold model
// JIT-loads its GGUF first (observed 90s+ on a 30GB box); models that
// exceed it are skipped, not force-loaded.
const PROBE_TIMEOUT_MS = 120_000;

// Output cap when the server reports none, the ceiling for a derived cap, and
// the input room a derived cap leaves behind.
//
// lemonade publishes a completion cap (`max_output_tokens` plus the
// `max_completion_tokens` alias) only for cloud-recipe models, where it copies
// the upstream provider's limits. Local llama.cpp/FLM models report nothing:
// GGUF metadata carries only the trained context, llama.cpp starts at
// n_predict:-1, and the server injects no default, so a local model's real
// ceiling is its window minus the prompt. Hence: prefer the reported cap,
// otherwise leave the prompt some headroom so a small-window model never
// advertises an output cap that fills its own window, and keep the default
// ceiling so a 256K-window model cannot turn a runaway generation into hours of
// local decoding.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const MIN_MAX_OUTPUT_TOKENS = 1_024;
const INPUT_HEADROOM_TOKENS = 8_192;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

function resolveMaxTokens(entry: LemonadeModelEntry, contextWindow: number): number {
  const reported = positiveInt(entry.max_output_tokens) ?? positiveInt(entry.max_completion_tokens);
  const derived = Math.max(
    MIN_MAX_OUTPUT_TOKENS,
    Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow - INPUT_HEADROOM_TOKENS),
  );
  // Never advertise more than the window, even for windows below the floor.
  return Math.max(1, Math.min(reported ?? derived, contextWindow));
}

interface LemonadeModelEntry {
  id: string;
  labels?: string[];
  context_length?: number;
  max_context_window?: number;
  // Emitted together, and only for `cloud`-recipe models (see resolveMaxTokens).
  max_output_tokens?: number;
  max_completion_tokens?: number;
}

interface ExtraReasoningFile {
  extraReasoning?: Record<string, true>;
}

// Missing file is the normal fresh-checkout path: label-only detection.
// A corrupt file warns once and also degrades to label-only detection.
function loadExtraReasoning(dir: string, warn: (message: string) => void): Record<string, true> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "extra-reasoning.local.json"), "utf8"));
    // Narrow the parsed shape instead of casting; a malformed file degrades
    // to label-only detection. Values are filtered to `true` so hand-edited
    // `false` entries drop out instead of being probed forever.
    if (parsed !== null && typeof parsed === "object" && "extraReasoning" in parsed) {
      const map = parsed.extraReasoning; // unknown, guarded by `in` above
      if (map !== null && typeof map === "object") {
        const filtered = Object.entries(map).filter(([, value]) => value === true);
        // The filter guarantees every value is `true`.
        return Object.fromEntries(filtered) as Record<string, true>;
      }
    }
    return {};
  } catch (error: unknown) {
    const isMissingFile =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    // Corrupt or unreadable file: warn; a missing file is the normal
    // fresh-checkout path and stays silent.
    if (!isMissingFile) {
      warn(`lemonade-provider: failed to read extra-reasoning.local.json: ${String(error)}`);
    }
    return {};
  }
}

// Element boundary check for /v1/models: `id` is the only field read
// unconditionally.
const isModelEntry = (value: unknown): value is LemonadeModelEntry =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";

type ModelListResult =
  | { ok: true; entries: LemonadeModelEntry[]; validCatalog: boolean }
  | { ok: false; error: string };

// Shared /v1/models read for discovery and /lemonade-probe; never throws so
// callers keep their own logging surface (pi.logger vs ctx.ui.notify).
async function fetchModelList(): Promise<ModelListResult> {
  try {
    const response = await fetch(`${LEMONADE_BASE_URL}/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, error: `/v1/models returned HTTP ${response.status}` };
    }
    const payload: unknown = await response.json();
    // Runtime-narrow the wire shape; per-entry fields stay optional and are
    // read with ?. downstream.
    if (payload === null || typeof payload !== "object" || !("data" in payload)) {
      // No `data` array: malformed/unexpected catalog. Mark invalid so the
      // caller does not treat an empty list as a real, model-free server.
      return { ok: true, entries: [], validCatalog: false };
    }
    const data = payload.data;
    return {
      ok: true,
      entries: Array.isArray(data) ? data.filter(isModelEntry) : [],
      // A present `data` array — even an empty one — is a trustworthy read, so
      // pruning is safe. A missing or non-array one is not.
      validCatalog: Array.isArray(data),
    };
  } catch (error: unknown) {
    return { ok: false, error: `cannot reach ${LEMONADE_BASE_URL}: ${String(error)}` };
  }
}

const isChat = (m: LemonadeModelEntry): boolean => m.labels?.includes("chat") ?? false;

// Narrow a chat-completion payload to "first choice emitted non-empty
// reasoning_content" without an unchecked cast; OpenAI-compatible servers
// return { choices: [{ message: { reasoning_content?: string } }] }.
function carriesReasoningContent(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("choices" in payload)) return false;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return false;
  const first = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return false;
  const message = first.message;
  if (typeof message !== "object" || message === null || !("reasoning_content" in message)) return false;
  return typeof message.reasoning_content === "string" && message.reasoning_content !== "";
}

// Whether a probe completion emitted any output at all. The "no reasoning
// content" verdict is only trustworthy when this is true: lemonade relays
// some backend failures (e.g. a context-size 400 from llama.cpp) as HTTP
// 200 with zero delta parts, so a payload with neither content nor
// reasoning_content is an unknown outcome, not a negative probe result.
function completionEmittedContent(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("choices" in payload)) return false;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return false;
  const first = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return false;
  const message = first.message;
  if (typeof message !== "object" || message === null) return false;
  if ("content" in message && typeof message.content === "string" && message.content !== "") {
    return true;
  }
  return (
    "reasoning_content" in message &&
    typeof message.reasoning_content === "string" &&
    message.reasoning_content !== ""
  );
}

export default function lemonadeProvider(pi: ExtensionAPI) {
  // extra-reasoning.local.json lives beside the real source file (realpath
  // follows the ~/.omp/agent/extensions install symlink), so it stays in the
  // repo checkout rather than the symlink directory.
  const dir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const extraReasoning = loadExtraReasoning(dir, (message) => pi.logger?.warn?.(message));

  pi.registerProvider("lemonade", {
    baseUrl: `${LEMONADE_BASE_URL}/v1`,
    api: "openai-completions",
    // lemonade is keyless locally; the apiKey field satisfies the custom-provider
    // requirement without sending a real credential. auth: none is the models.yml
    // spelling; extensions use an apiKey placeholder instead.
    apiKey: "LEMONADE_API_KEY_PLACEHOLDER",
    fetchDynamicModels: async () => {
      const result = await fetchModelList();
      if (!result.ok) {
        pi.logger?.warn?.(`lemonade-provider: ${result.error}`);
        return [];
      }

      return result.entries
        .filter(isChat)
        .map((m) => {
          // `context_length` is the effective window: the loaded ctx_size, else
          // the configured one, else the static maximum (server.cpp
          // resolve_context_length). Lemonade auto-tunes ctx_size to the memory
          // left for the KV cache and omp's own openai-compat discovery maps the
          // same field, so this is the value the server will actually serve;
          // max_context_window is only the model's ceiling, and 128000 the last
          // resort when the server reports neither field.
          const context =
            positiveInt(m.context_length) ?? positiveInt(m.max_context_window) ?? 128000;
          // The "reasoning" label is authoritative when present, but models in
          // extra-reasoning.local.json were probed to emit reasoning_content
          // without it. Both accept reasoning_effort:"none" as a hard off, so
          // the ladder and the off->none mapping apply to them. Unknown future
          // models default to the server label only; probe them with
          // /lemonade-probe.
          const isReasoning =
            (m.labels?.includes("reasoning") ?? false) || extraReasoning[m.id] === true;
          return {
            id: m.id,
            name: m.id,
            api: "openai-completions" as const,
            reasoning: isReasoning,
            input: ["text" as const, ...(m.labels?.includes("vision") ? (["image"] as const) : [])],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: context,
            maxTokens: resolveMaxTokens(m, context),
            // reasoningDisableMode "none-effort" makes thinking-off send
            // reasoning_effort:"none", the hard reasoning-off lemonade
            // (llama.cpp-backed) understands; graded levels forward verbatim.
            ...(isReasoning
              ? {
                  thinking: {
                    mode: "effort" as const,
                    efforts: ["low", "medium", "high"] as const,
                    defaultLevel: "medium" as const,
                  },
                  compat: { reasoningDisableMode: "none-effort" as const },
                }
              : {}),
          };
        });
    },
  });

  // /lemonade-probe: behavioral detection for a different lemonade instance.
  // Sequentially probes chat models that lack the "reasoning" label (and are
  // not already in the local list) with a tiny completion request; models whose
  // response carries reasoning_content are added to extra-reasoning.local.json.
  // Cold models JIT-load on first probe, so this can take a while; failures are
  // skipped, never fatal. Run `omp models refresh lemonade` afterwards.
  pi.registerCommand("lemonade-probe", {
    description: "Probe lemonade chat models for unlabeled reasoning support and update the local list",
    handler: async (_args, ctx) => {
      ctx.ui.notify("lemonade-probe: fetching model list...", "info");
      const result = await fetchModelList();
      if (!result.ok) {
        ctx.ui.notify(`lemonade-probe: ${result.error}`, "error");
        return;
      }
      const entries = result.entries;

      // A malformed /v1/models (no data array) yields an empty, untrustworthy
      // list. Refuse to prune rather than wiping the local list on a bad read;
      // a genuinely empty catalog (empty array) is trustworthy and prunes.
      if (!result.validCatalog) {
        ctx.ui.notify(
          "lemonade-probe: /v1/models response had no data array; pruned nothing and have nothing to probe.",
          "warning",
        );
        return;
      }

      // Drop stale keys: a model removed from the server drops out of the
      // /v1/models catalog, so any local entry whose ID is now absent is dead
      // weight. Prune first so removal is tracked even when nothing new is to
      // be probed.
      const staleIds = Object.keys(extraReasoning).filter((id) =>
        !entries.some((m) => m.id === id),
      );
      for (const id of staleIds) delete extraReasoning[id];

      const unlabeled = entries.filter(
        (m) =>
          isChat(m) &&
          !(m.labels?.includes("reasoning") ?? false) &&
          extraReasoning[m.id] !== true,
      );

      if (unlabeled.length === 0 && staleIds.length === 0) {
        ctx.ui.notify("lemonade-probe: nothing new to probe and no stale entries to remove.", "info");
        return;
      }

      const discovered: string[] = [];
      if (unlabeled.length > 0) {
        if (staleIds.length > 0) {
          ctx.ui.notify(
            `lemonade-probe: removed ${staleIds.length} stale model(s) no longer on the server.`,
            "info",
          );
        }
        ctx.ui.notify(
          `lemonade-probe: probing ${unlabeled.length} model(s) sequentially — cold models load on first use and can take minutes each.`,
          "info",
        );
        for (const model of unlabeled) {
          try {
            const response = await fetch(`${LEMONADE_BASE_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: model.id,
                messages: [
                  { role: "user", content: "What is 17*23? Think briefly then answer." },
                ],
                max_tokens: 512,
              }),
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            if (!response.ok) {
              ctx.ui.notify(`  ${model.id}: HTTP ${response.status}, skipping`, "warning");
              continue;
            }
            const payload: unknown = await response.json();
            if (carriesReasoningContent(payload)) {
              discovered.push(model.id);
              extraReasoning[model.id] = true;
              ctx.ui.notify(`  ${model.id}: reasoning detected`, "info");
            } else if (completionEmittedContent(payload)) {
              ctx.ui.notify(`  ${model.id}: no reasoning content`, "info");
            } else {
              // HTTP 200 but no output: lemonade may be masking a backend
              // error, so the probe result is unknown, not "no reasoning".
              ctx.ui.notify(
                `  ${model.id}: HTTP 200 with empty completion (lemonade may be masking an upstream error), skipping`,
                "warning",
              );
            }
          } catch (error: unknown) {
            ctx.ui.notify(`  ${model.id}: probe failed (${String(error)}), skipping`, "warning");
          }
        }
      }

      if (discovered.length > 0 || staleIds.length > 0) {
        const file: ExtraReasoningFile = { extraReasoning };
        const path = join(dir, "extra-reasoning.local.json");
        writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
        ctx.ui.notify(
          `lemonade-probe: wrote ${path} — added ${discovered.length}, removed ${staleIds.length} stale model(s). Run \`omp models refresh lemonade\` (or restart omp) to apply.`,
          "info",
        );
      } else {
        ctx.ui.notify("lemonade-probe: no new reasoning models found.", "info");
      }
    },
  });
}
