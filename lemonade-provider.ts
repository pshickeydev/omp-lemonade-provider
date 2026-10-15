// omp extension: lemonade-server provider with capability-aware discovery.
//
// Registers a "lemonade" provider whose fetchDynamicModels reads the
// server's /v1/models list (including lemonade-specific `labels`) and maps
// the "reasoning" label onto omp thinking metadata, so the effort ladder
// (low/medium/high) is served automatically for reasoning models instead
// of requiring per-model modelOverrides entries.
//
// Installed as a symlink from ~/.omp/agent/extensions/lemonade-provider.ts.
// The server URL defaults to localhost; point LEMONADE_BASE_URL at another
// lemonade instance (e.g. the LAN box) to use it.
//
// Models that reason without lemonade's "reasoning" label are tracked in
// extra-reasoning.local.json next to this file (gitignored — see
// extra-reasoning.example.json for the format). On a fresh checkout the
// file is absent and detection degrades to label-only. Run /lemonade-probe
// inside omp to probe the current server and populate the file.
//
// Note: `apiKey` is a placeholder. lemonade is keyless, and omp extensions
// require a credential field for custom providers, so every request carries
// a harmless `Authorization: Bearer LEMONADE_API_KEY_PLACEHOLDER` header.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const LEMONADE_BASE_URL = process.env.LEMONADE_BASE_URL ?? "http://localhost:13305";

// Per-probe wall-clock budget. Generous because probing a cold model
// JIT-loads its GGUF first (observed 90s+ on a 30GB box); models that
// exceed it are skipped, not force-loaded.
const PROBE_TIMEOUT_MS = 120_000;

interface LemonadeModelEntry {
  id: string;
  labels?: string[];
  context_length?: number;
  max_context_window?: number;
  suggested?: boolean;
}

interface ExtraReasoningFile {
  extraReasoning?: Record<string, true>;
}

// extra-reasoning.local.json lives beside the real source file (realpath
// follows the ~/.omp/agent/extensions install symlink), so it stays in the
// repo checkout rather than the symlink directory.

// Missing file is the normal fresh-checkout path: label-only detection.
// A corrupt file warns once and also degrades to label-only detection.
function loadExtraReasoning(dir: string, warn: (message: string) => void): Record<string, true> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "extra-reasoning.local.json"), "utf8"));
    // Narrow the parsed shape instead of casting; a malformed file degrades
    // to label-only detection.
    if (parsed !== null && typeof parsed === "object" && "extraReasoning" in parsed) {
      const map = (parsed as { extraReasoning: unknown }).extraReasoning;
      if (map !== null && typeof map === "object") return map as Record<string, true>;
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

export default function lemonadeProvider(pi: ExtensionAPI) {
  const dir = realpathSync(dirname(import.meta.url.replace(/^file:\/\//, "")));
  const extraReasoning = loadExtraReasoning(dir, (message) => pi.logger?.warn?.(message));

  pi.registerProvider("lemonade", {
    baseUrl: `${LEMONADE_BASE_URL}/v1`,
    api: "openai-completions",
    // lemonade is keyless locally; the apiKey field satisfies the custom-provider
    // requirement without sending a real credential. auth: none is the models.yml
    // spelling; extensions use an apiKey placeholder instead.
    apiKey: "LEMONADE_API_KEY_PLACEHOLDER",
    fetchDynamicModels: async () => {
      const response = await fetch(`${LEMONADE_BASE_URL}/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      }).catch((error: unknown) => {
        pi.logger?.warn?.(`lemonade-provider: model fetch failed: ${String(error)}`);
        return null;
      });
      if (!response || !response.ok) {
        if (response) {
          pi.logger?.warn?.(
            `lemonade-provider: /v1/models returned HTTP ${response.status}`,
          );
        }
        return [];
      }
      const payload = (await response.json()) as { data?: LemonadeModelEntry[] };
      const entries = payload.data ?? [];

      return entries
        .filter((m) => Array.isArray(m.labels) && m.labels.includes("chat"))
        .map((m) => {
          const context = m.max_context_window ?? m.context_length ?? 128000;
          // The "reasoning" label is authoritative when present, but models in
          // extra-reasoning.local.json were probed to emit reasoning_content
          // without it. All of them accept reasoning_effort:"none" as a hard
          // off, so the ladder and the minimal->none mapping apply to them.
          // Unknown future models default to the server label only; probe
          // them with /lemonade-probe.
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
            maxTokens: 32768,
            // reasoningEffortMap maps minimal to "none" because lemonade
            // (llama.cpp-backed) treats reasoning_effort:"none" as a hard
            // reasoning-off request.
            ...(isReasoning
              ? {
                  thinking: {
                    mode: "effort" as const,
                    efforts: ["low", "medium", "high"] as const,
                    defaultLevel: "medium" as const,
                  },
                  compat: { reasoningEffortMap: { minimal: "none" } },
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
      let entries: LemonadeModelEntry[];
      try {
        const response = await fetch(`${LEMONADE_BASE_URL}/v1/models`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          ctx.ui.notify(`lemonade-probe: /v1/models returned HTTP ${response.status}`, "error");
          return;
        }
        entries = (((await response.json()) as { data?: LemonadeModelEntry[] }).data ?? []);
      } catch (error: unknown) {
        ctx.ui.notify(`lemonade-probe: cannot reach ${LEMONADE_BASE_URL}: ${String(error)}`, "error");
        return;
      }

      const unlabeled = entries.filter(
        (m) =>
          m.labels?.includes("chat") &&
          !(m.labels?.includes("reasoning") ?? false) &&
          extraReasoning[m.id] !== true,
      );
      if (unlabeled.length === 0) {
        ctx.ui.notify("lemonade-probe: no new unlabeled chat models to probe.", "info");
        return;
      }

      ctx.ui.notify(
        `lemonade-probe: probing ${unlabeled.length} model(s) sequentially — cold models load on first use and can take minutes each.`,
        "info",
      );

      const discovered: string[] = [];
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
            ctx.ui.notify(`  ${model.id}: HTTP ${response.status}, skipping`, "warn");
            continue;
          }
          const message = (
            (await response.json()) as {
              choices?: { message?: { reasoning_content?: string } }[];
            }
          ).choices?.[0]?.message;
          if (message?.reasoning_content) {
            discovered.push(model.id);
            extraReasoning[model.id] = true;
            ctx.ui.notify(`  ${model.id}: reasoning detected`, "info");
          } else {
            ctx.ui.notify(`  ${model.id}: no reasoning content`, "info");
          }
        } catch (error: unknown) {
          ctx.ui.notify(`  ${model.id}: probe failed (${String(error)}), skipping`, "warn");
        }
      }

      if (discovered.length > 0) {
        const file: ExtraReasoningFile = { extraReasoning: extraReasoning };
        const path = join(dir, "extra-reasoning.local.json");
        writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
        ctx.ui.notify(
          `lemonade-probe: added ${discovered.length} model(s) to ${path}. Run \`omp models refresh lemonade\` (or restart omp) to apply.`,
          "info",
        );
      } else {
        ctx.ui.notify("lemonade-probe: no new reasoning models found.", "info");
      }
    },
  });
}
