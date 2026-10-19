// omp extension: lemonade-server provider with capability-aware discovery.
//
// Registers one provider per lemonade server: "lemonade" for the local
// instance (LEMONADE_BASE_URL, default http://localhost:13305) plus
// "lemonade-<name>" for each entry of LEMONADE_LAN_SERVERS (0 or more, e.g.
// "office=http://192.168.1.37:13305,kitchen=192.168.1.50"). Key-protected
// servers authenticate with `Authorization: Bearer <key>`: lemonade gates its
// regular API endpoints on a server-side LEMONADE_API_KEY. This extension
// reads its credential from LEMONADE_API_KEY (LEMONADE_ADMIN_API_KEY as
// fallback) for the local server and LEMONADE_LAN_<NAME>_API_KEY per LAN
// server. Each provider's fetchDynamicModels maps that server's /v1/models
// `labels` onto omp model
// metadata: the `reasoning` label onto a thinking effort ladder (off =>
// reasoning_effort:"none"), `vision` onto image input, `chat` onto the roster
// filter, and the reported-or-derived output cap onto maxTokens. One provider
// per server keeps each discovery fetch inside omp's 15 s dynamic-model
// timeout and namespaces model IDs (`lemonade-office/<id>`), so two servers
// hosting the same model never collide. Models that reason without the
// `reasoning` label are tracked per server in the gitignored
// extra-reasoning.local.json next to this file; run /lemonade-probe inside omp
// to populate it. Install, configuration, and limitations: see README.md.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// lemonade's default listen port; appended to LAN entries that give only a
// host (or host-less URL) so `office=192.168.1.37` works.
const DEFAULT_LEMONADE_PORT = 13305;

// The local server's fixed key in extra-reasoning.local.json and in
// /lemonade-probe selection. Its provider is the unsuffixed "lemonade".
const LOCAL_SERVER_NAME = "local";

// Read an API key from the environment; unset or blank means keyless.
const readEnvKey = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
};

// Env var holding LAN server `name`'s key: `office` ->
// LEMONADE_LAN_OFFICE_API_KEY. The LEMONADE_LAN_ prefix keeps these names
// out of two collision paths: `admin` would otherwise derive
// LEMONADE_ADMIN_API_KEY, the var the local fallback reads (a LAN `admin`
// entry and the local server silently sharing one key), and lemonade itself
// owns LEMONADE_<PROVIDER>_API_KEY for cloud providers (e.g. an `office`
// cloud recipe on a lemond sharing this environment). `-` maps to `_` so the
// name stays a POSIX-shell identifier; `a-b` and `a_b` collapse onto the same
// variable.
const lanKeyEnvName = (name: string): string =>
  `LEMONADE_LAN_${name.toUpperCase().replace(/-/g, "_")}_API_KEY`;

interface LemonadeServer {
  /** Key in extra-reasoning.local.json and /lemonade-probe argument. */
  name: string;
  /** omp provider name: `lemonade` (local) or `lemonade-<name>` (LAN). */
  provider: string;
  baseUrl: string;
  /** Client credential sent as `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  /** Env var to set when this server rejects an unauthenticated request. */
  keyEnvHint: string;
}

// Normalize a configured URL: a bare host gets http:// and the lemonade
// default port (`kitchen=192.168.1.50` -> `http://192.168.1.50:13305`), while
// an explicit scheme keeps its own default port (`https://lemon.lan` stays on
// 443 — bolting :13305 onto a TLS-proxied entry would break it). Trailing
// slashes are stripped so request paths never become `//v1/...`. Returns
// undefined for anything that is not an http(s) URL even after the repairs.
function normalizeBaseUrl(raw: string): string | undefined {
  let candidate = raw.trim();
  if (candidate === "") return undefined;
  const bareHost = !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  if (bareHost) candidate = `http://${candidate}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (bareHost && !url.port) url.port = String(DEFAULT_LEMONADE_PORT);
    const path = url.pathname.replace(/\/+$/, "");
    return url.origin + path;
  } catch {
    return undefined;
  }
}

// LEMONADE_LAN_SERVERS: comma- or whitespace-separated `name=url` pairs.
// Names become provider suffixes and probe selectors, so they are lowercased
// and restricted to [a-z][a-z0-9_-] (no `/`, `:`, or space can leak into a
// `provider/model` spec). A key-protected server's key is read from
// LEMONADE_LAN_<NAME>_API_KEY. Bad pairs warn and skip; duplicate names keep
// the first.
function parseLanServers(warn: (message: string) => void): LemonadeServer[] {
  const servers: LemonadeServer[] = [];
  const raw = process.env.LEMONADE_LAN_SERVERS?.trim();
  if (!raw) return servers;
  for (const pair of raw.split(/[\s,]+/)) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      warn(`lemonade-provider: ignoring LEMONADE_LAN_SERVERS entry "${pair}" (expected name=url).`);
      continue;
    }
    const name = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      warn(`lemonade-provider: ignoring LEMONADE_LAN_SERVERS name "${name}" (must match [a-z][a-z0-9_-]*).`);
      continue;
    }
    if (name === LOCAL_SERVER_NAME) {
      warn(`lemonade-provider: "${LOCAL_SERVER_NAME}" names the local server; configure it via LEMONADE_BASE_URL.`);
      continue;
    }
    const baseUrl = normalizeBaseUrl(value);
    if (baseUrl === undefined) {
      warn(`lemonade-provider: ignoring LEMONADE_LAN_SERVERS entry "${pair}" (not an http(s) URL).`);
      continue;
    }
    if (servers.some((s) => s.name === name)) {
      warn(`lemonade-provider: ignoring duplicate LEMONADE_LAN_SERVERS name "${name}".`);
      continue;
    }
    servers.push({
      name,
      provider: `lemonade-${name}`,
      baseUrl,
      apiKey: readEnvKey(lanKeyEnvName(name)),
      keyEnvHint: lanKeyEnvName(name),
    });
  }
  return servers;
}

// The local base URL keeps the legacy lenient behavior (only trailing-slash
// stripping) if the override is set to something URL-parseable repairs
// cannot handle; otherwise the same normalization LAN entries get applies.
const localOverride = process.env.LEMONADE_BASE_URL;
const LOCAL_BASE_URL =
  localOverride === undefined
    ? `http://localhost:${DEFAULT_LEMONADE_PORT}`
    : (normalizeBaseUrl(localOverride) ?? localOverride.trim().replace(/\/+$/, ""));

// Key for the local server. Lemonade's own clients prefer
// LEMONADE_ADMIN_API_KEY, but this extension only touches regular API
// endpoints, so it prefers the least-privileged LEMONADE_API_KEY and falls
// back to the admin key only when the standard key is unset.
const LOCAL_API_KEY =
  readEnvKey("LEMONADE_API_KEY") ?? readEnvKey("LEMONADE_ADMIN_API_KEY");

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

// server name -> model id -> true. The local server's bucket is keyed "local".
type ExtraReasoningBuckets = Record<string, Record<string, true>>;

interface ExtraReasoningFile {
  servers?: Record<string, unknown>;
  // Legacy flat map (single-server era); read only when `servers` is absent
  // and migrated into the "local" bucket. Never written back.
  extraReasoning?: Record<string, unknown>;
}

// Values are filtered to `true` so hand-edited `false` entries drop out
// instead of being probed forever.
const filterTrue = (map: unknown): Record<string, true> | undefined => {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return undefined;
  return Object.fromEntries(
    Object.entries(map).filter(([, value]) => value === true),
  ) as Record<string, true>;
};

// Missing file is the normal fresh-checkout path: label-only detection.
// A corrupt file warns once and also degrades to label-only detection.
function loadExtraReasoning(dir: string, warn: (message: string) => void): ExtraReasoningBuckets {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "extra-reasoning.local.json"), "utf8"));
    // Narrow the parsed shape instead of casting; a malformed file degrades
    // to label-only detection.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const file = parsed as ExtraReasoningFile;
    const buckets: ExtraReasoningBuckets = {};
    if ("servers" in file && file.servers !== null && typeof file.servers === "object") {
      for (const [name, map] of Object.entries(file.servers)) {
        const filtered = filterTrue(map);
        if (filtered) buckets[name] = filtered;
      }
      return buckets;
    }
    // Legacy single-server format: everything was the local server.
    if ("extraReasoning" in file) {
      const local = filterTrue(file.extraReasoning);
      if (local && Object.keys(local).length > 0) buckets[LOCAL_SERVER_NAME] = local;
    }
    return buckets;
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
async function fetchModelList(
  baseUrl: string,
  apiKey?: string,
  keyHint?: string,
): Promise<ModelListResult> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // A keyless request against a gated server is the common
      // misconfiguration; name the env var instead of logging a bare 401.
      const gated =
        !apiKey && (response.status === 401 || response.status === 403) && keyHint
          ? ` — server requires an API key; set ${keyHint}`
          : "";
      return { ok: false, error: `/v1/models returned HTTP ${response.status}${gated}` };
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
    return { ok: false, error: `cannot reach ${baseUrl}: ${String(error)}` };
  }
}

const isChat = (m: LemonadeModelEntry): boolean => m.labels?.includes("chat") ?? false;
const hasReasoningLabel = (m: LemonadeModelEntry): boolean => m.labels?.includes("reasoning") ?? false;

// Map one lemonade catalog entry onto omp model metadata, with `bucket` the
// extra-reasoning set for the server that reported it.
function mapModel(m: LemonadeModelEntry, bucket: Record<string, true>) {
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
  const isReasoning = hasReasoningLabel(m) || bucket[m.id] === true;
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
}

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
  const warn = (message: string) => pi.logger?.warn?.(message);
  const servers: LemonadeServer[] = [
    {
      name: LOCAL_SERVER_NAME,
      provider: "lemonade",
      baseUrl: LOCAL_BASE_URL,
      apiKey: LOCAL_API_KEY,
      keyEnvHint: "LEMONADE_API_KEY (or LEMONADE_ADMIN_API_KEY)",
    },
    ...parseLanServers(warn),
  ];

  // extra-reasoning.local.json lives beside the real source file (realpath
  // follows the ~/.omp/agent/extensions install symlink), so it stays in the
  // repo checkout rather than the symlink directory.
  const dir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const buckets: ExtraReasoningBuckets = loadExtraReasoning(dir, warn);

  for (const server of servers) {
    pi.registerProvider(server.provider, {
      baseUrl: `${server.baseUrl}/v1`,
      api: "openai-completions",
      // omp extensions require a credential field for custom providers.
      // Keyless servers (the common case) get a harmless placeholder that
      // lemonade ignores; a configured key is passed literally — per omp's
      // extension docs a registered apiKey overrides any stored /login
      // credential, and the openai-completions transport sends it as
      // `Authorization: Bearer <key>`.
      apiKey: server.apiKey ?? "LEMONADE_API_KEY_PLACEHOLDER",
      fetchDynamicModels: async () => {
        const result = await fetchModelList(server.baseUrl, server.apiKey, server.keyEnvHint);
        if (!result.ok) {
          warn(`[${server.name}] ${result.error}`);
          return [];
        }
        const bucket = buckets[server.name] ?? {};
        return result.entries.filter(isChat).map((m) => mapModel(m, bucket));
      },
    });
  }

  // /lemonade-probe [name ...]: behavioral detection for unlabeled reasoners.
  // With no argument it walks every configured server; with names it probes
  // only those (`local` plus the LAN names). Per server it sequentially probes
  // chat models that lack the "reasoning" label (and are not already listed
  // for that server) with a tiny completion request; models whose response
  // carries reasoning_content are added to that server's bucket in
  // extra-reasoning.local.json, and entries for models no longer on that
  // server are pruned. Cold models JIT-load on first probe, so this can take a
  // while; failures are skipped, never fatal. Run
  // `omp models refresh <provider>` afterwards.
  pi.registerCommand("lemonade-probe", {
    description:
      "Probe lemonade chat servers' models for unlabeled reasoning support and update the per-server lists",
    handler: async (args, ctx) => {
      const selection = (args ?? "")
        .trim()
        .split(/[\s,]+/)
        .filter((token) => token !== "")
        .map((token) => token.toLowerCase());

      let targets: LemonadeServer[];
      if (selection.length === 0) {
        targets = servers;
      } else {
        const byName = new Map(servers.map((s) => [s.name, s]));
        const unknown = selection.filter((name) => !byName.has(name));
        if (unknown.length > 0) {
          ctx.ui.notify(
            `lemonade-probe: unknown server(s): ${unknown.join(", ")} — known: ${servers.map((s) => s.name).join(", ")}.`,
            "error",
          );
          return;
        }
        targets = [...new Set(selection)].map((name) => byName.get(name)!);
      }

      let addedTotal = 0;
      let removedTotal = 0;
      const touchedProviders = new Set<string>();

      for (const server of targets) {
        ctx.ui.notify(`lemonade-probe [${server.name}]: fetching model list...`, "info");
        const result = await fetchModelList(server.baseUrl, server.apiKey, server.keyEnvHint);
        if (!result.ok) {
          // Unreachable server: skip it entirely — its bucket is neither
          // pruned (that would empty it on a transient failure) nor probed.
          ctx.ui.notify(`lemonade-probe [${server.name}]: ${result.error}`, "warning");
          continue;
        }

        // A malformed /v1/models (no data array) yields an empty, untrustworthy
        // list. Refuse to prune rather than wiping the local list on a bad read;
        // a genuinely empty catalog (empty array) is trustworthy and prunes.
        if (!result.validCatalog) {
          ctx.ui.notify(
            `lemonade-probe [${server.name}]: /v1/models response had no data array; pruned nothing and have nothing to probe.`,
            "warning",
          );
          continue;
        }

        const bucket = (buckets[server.name] ??= {});

        // Drop stale keys: a model removed from the server drops out of the
        // /v1/models catalog, so any local entry whose ID is now absent is
        // dead weight. Prune first so removal is tracked even when nothing
        // new is to be probed. Only this server's bucket is touched: the same
        // model ID on another server keeps its own verdict.
        const staleIds = Object.keys(bucket).filter((id) =>
          !result.entries.some((m) => m.id === id),
        );
        for (const id of staleIds) delete bucket[id];
        if (staleIds.length > 0) {
          removedTotal += staleIds.length;
          touchedProviders.add(server.provider);
          ctx.ui.notify(
            `lemonade-probe [${server.name}]: removed ${staleIds.length} stale model(s) no longer on the server.`,
            "info",
          );
        }

        const unlabeled = result.entries.filter(
          (m) => isChat(m) && !hasReasoningLabel(m) && bucket[m.id] !== true,
        );

        if (unlabeled.length === 0) {
          if (staleIds.length === 0) {
            ctx.ui.notify(`lemonade-probe [${server.name}]: nothing new to probe and no stale entries to remove.`, "info");
          }
          continue;
        }

        ctx.ui.notify(
          `lemonade-probe [${server.name}]: probing ${unlabeled.length} model(s) sequentially — cold models load on first use and can take minutes each.`,
          "info",
        );
        for (const model of unlabeled) {
          try {
            const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
              },
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
              ctx.ui.notify(`  [${server.name}] ${model.id}: HTTP ${response.status}, skipping`, "warning");
              continue;
            }
            const payload: unknown = await response.json();
            if (carriesReasoningContent(payload)) {
              bucket[model.id] = true;
              addedTotal += 1;
              touchedProviders.add(server.provider);
              ctx.ui.notify(`  [${server.name}] ${model.id}: reasoning detected`, "info");
            } else if (completionEmittedContent(payload)) {
              ctx.ui.notify(`  [${server.name}] ${model.id}: no reasoning content`, "info");
            } else {
              // HTTP 200 but no output: lemonade may be masking a backend
              // error, so the probe result is unknown, not "no reasoning".
              ctx.ui.notify(
                `  [${server.name}] ${model.id}: HTTP 200 with empty completion (lemonade may be masking an upstream error), skipping`,
                "warning",
              );
            }
          } catch (error: unknown) {
            ctx.ui.notify(`  [${server.name}] ${model.id}: probe failed (${String(error)}), skipping`, "warning");
          }
        }
      }

      // Buckets for servers not configured in this environment (a LAN entry
      // removed from LEMONADE_LAN_SERVERS, or an env-less shell) can never be
      // pruned: there is no catalog to check them against. Report instead of
      // delete — the next run with the server configured prunes them properly,
      // and an env-less shell must not destroy a still-valid bucket.
      const orphaned = Object.keys(buckets).filter(
        (name) => !servers.some((s) => s.name === name),
      );
      if (orphaned.length > 0) {
        ctx.ui.notify(
          `lemonade-probe: buckets exist for servers not configured here: ${orphaned.join(", ")} — re-add the server and run /lemonade-probe to prune, or delete the bucket by hand.`,
          "info",
        );
      }

      if (addedTotal > 0 || removedTotal > 0) {
        // Drop emptied buckets so the file stays tidy.
        for (const name of Object.keys(buckets)) {
          if (Object.keys(buckets[name]!).length === 0) delete buckets[name];
        }
        const file = { servers: buckets };
        const path = join(dir, "extra-reasoning.local.json");
        writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
        const refresh = [...touchedProviders].map((p) => `omp models refresh ${p}`).join(" / ");
        ctx.ui.notify(
          `lemonade-probe: wrote ${path} — added ${addedTotal}, removed ${removedTotal} stale model(s). Run \`${refresh}\` (or restart omp) to apply.`,
          "info",
        );
      } else {
        ctx.ui.notify("lemonade-probe: no new reasoning models found.", "info");
      }
    },
  });
}
