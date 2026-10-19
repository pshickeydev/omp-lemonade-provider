# omp-lemonade-provider

An [omp](https://github.com/can1357/oh-my-pi) extension that registers a
`lemonade` provider with capability-aware model discovery for
[Lemonade Server](https://github.com/lemonade-sdk/lemonade) (AMD's local LLM
runtime), simultaneously for a local server plus any number of servers on the
LAN.

## What it does

omp's built-in `openai-models-list` discovery reads only model IDs and context
limits — it ignores lemonade's `labels` array. This extension reads
`GET /v1/models` including `labels` and derives:

- `reasoning` label → thinking metadata (`low|medium|high` effort ladder,
  `defaultLevel: medium`); thinking `off` sends `reasoning_effort: "none"`
  (`compat.reasoningDisableMode: "none-effort"`), which lemonade
  (llama.cpp-backed) treats as a hard reasoning-off request
- `vision` label → image input
- `chat` label → chat roster filter (non-chat entries are excluded)
- `context_length` → the effective context window: the loaded `ctx_size`, else
  the configured one, else `max_context_window`, else 128000
- `max_output_tokens` / `max_completion_tokens` → output cap, when the server
  reports one; otherwise derived from the context window (see
  [Output cap](#output-cap))

Models that emit `reasoning_content` without the `reasoning` label (common on
custom fine-tunes — verified on 4 of 6 models on one instance) are tracked in a
machine-local file; see below.

## Install

Symlink the extension into omp's agent extensions directory:

```bash
ln -s "$(pwd)/lemonade-provider.ts" ~/.omp/agent/extensions/lemonade-provider.ts
```

omp follows the symlink and resolves the repo directory at runtime, so the
companion `extra-reasoning.local.json` lives beside the source here, not in
`~/.omp`.

## Configuration

The local server defaults to `http://localhost:13305`; override with an
environment variable (e.g. in `~/.bashrc`):

```bash
export LEMONADE_BASE_URL="http://localhost:13305"
```

Add LAN servers — 0 or more — as comma-separated `name=url` pairs:

```bash
export LEMONADE_LAN_SERVERS="office=http://192.168.1.37:13305,kitchen=192.168.1.50"
```

Each entry registers its own provider: `lemonade` for the local server,
`lemonade-<name>` for each LAN entry, so models are selected as
`lemonade/<id>`, `lemonade-office/<id>`, … and identically named models on
different servers never collide. Names must match `[a-z][a-z0-9_-]*` (they
become provider suffixes and `/lemonade-probe` selectors). A bare host gets
`http://` and the lemonade default port `13305`, so `kitchen=192.168.1.50`
works; a URL that names its own scheme keeps that scheme's default port
(`https://lemon.lan` stays on 443), so give an explicit `:port` to override.
Malformed or duplicate entries warn and are skipped. Each provider's
discovery probes only its own server, so one down
server degrades its own roster, not the others'.

### API keys (optional)

Keyless servers — the default — need nothing. When the server process runs
with lemonade's `LEMONADE_API_KEY`, its regular endpoints (`/v1`, `/api`,
`/v0`) reject any request without a matching `Authorization: Bearer` token
([configuration guide](https://lemonade-server.ai/docs/guide/configuration/)).
Give this extension the same credential via the environment:

```bash
export LEMONADE_API_KEY="s3cret"              # local server
export LEMONADE_LAN_OFFICE_API_KEY="s3cret"   # the `office` LAN entry
```

LAN key variables are `LEMONADE_LAN_<NAME>_API_KEY` with the server name
uppercased and `-` mapped to `_` (`rack-2` → `LEMONADE_LAN_RACK_2_API_KEY`).
The `LEMONADE_LAN_` prefix is deliberate: an unprefixed `admin` entry would
derive `LEMONADE_ADMIN_API_KEY` — the local server's admin-fallback variable —
and silently share one key; lemonade also owns `LEMONADE_<PROVIDER>_API_KEY`
for cloud providers. For the local server `LEMONADE_ADMIN_API_KEY` is
accepted as a fallback when
`LEMONADE_API_KEY` is unset — lemonade's own clients prefer the admin key,
but this extension only touches regular endpoints, so it prefers the
least-privileged standard key. The key rides on every request the extension
itself makes — discovery (`GET /v1/models`) and `/lemonade-probe` completions
— and is handed to omp as the provider credential, so chat completions carry
it too. A missing key surfaces as a `/v1/models returned HTTP 401 — server
requires an API key; set <VAR>` warning naming the variable to set; a wrong
key returns a bare 401 and an empty roster. Over plain `http://` the bearer
token is
visible on the wire: put LAN servers behind TLS (`https://` base URLs) when
the key matters.

## Unlabeled reasoning models

Lemonade derives its `reasoning` label from registry metadata, not from the
GGUF chat template, so thinking models can be served without it. These are
tracked per server in `extra-reasoning.local.json` (gitignored — the lists
are machine-local, never committed), keyed by server name (`local` plus the
LAN names):

```json
{
  "servers": {
    "local": {
      "Some-Model-That-Reasons": true
    },
    "office": {
      "Another-Model-That-Reasons": true
    }
  }
}
```

A model's verdict is per server: the same model ID served by two machines with
different builds gets probed (and can differ) on each.

See `extra-reasoning.example.json` for the shape. A missing file (fresh
checkout) degrades to label-only detection; a corrupt file warns once and also
degrades. A legacy flat `{"extraReasoning": {...}}` file (single-server era)
is read as the `local` server's list; it is migrated to the `servers` shape
the next time `/lemonade-probe` writes the file. Models with the server
`reasoning` label always keep their ladder.

## Updating the lists: `/lemonade-probe`

Inside an omp session, run:

```
/lemonade-probe                 # all servers: local + every LAN entry
/lemonade-probe office          # only the `office` server
/lemonade-probe local kitchen   # any combination
```

For each selected server it probes every chat model that lacks the
`reasoning` label and isn't already listed for that server, with a small
completion request (`"What is 17*23? Think briefly then answer."`,
`max_tokens: 512` — trivial prompts don't elicit reasoning on all models), and
appends models whose response carries `reasoning_content` to that server's
bucket in `extra-reasoning.local.json`. Probes run sequentially with a 120 s
budget each; cold models JIT-load on first probe and can take minutes. It also
drops entries in a probed server's bucket for models no longer on that server
(gone from its `/v1/models`), so the lists do not accumulate dead entries —
it rewrites the file whenever it adds or removes something. An unreachable or
malformed server is reported and skipped: its bucket is neither pruned nor
probed, so a transient failure can never wipe it. A bucket belonging to a
server that is no longer configured in the current environment (e.g. a LAN
entry dropped from `LEMONADE_LAN_SERVERS`) can never be pruned — it is
reported so, and kept until that server returns or you delete it by hand.
After it reports additions,
run `omp models refresh <provider>` (e.g. `omp models refresh
lemonade-office`, or `lemonade` for the local server) to apply.

## Output cap

omp needs a per-model output cap (`maxTokens`), and lemonade reports one only
for `cloud`-recipe models: the server writes `max_output_tokens` plus its
OpenAI alias `max_completion_tokens` from the limits it parsed out of the
upstream provider's model entry, and omits both when the value is zero. Local
llama.cpp / FLM models report nothing — GGUF metadata carries only the trained
context, llama.cpp starts without a generation cap (`n_predict: -1`), the router
injects no default, and `POST /api/show` answers `num_ctx -1`. Their ceiling is
the runtime window minus the prompt.

Discovery therefore takes the first of:

1. `max_output_tokens`, then `max_completion_tokens` — any positive integer,
   clamped to the context window;
2. `contextWindow - 8192`, capped at 32768 and floored at 1024.

Both rules measure against the effective window, so pinning a smaller
`ctx_size` in lemonade lowers the cap with it. The 32768 ceiling keeps a
256K-window model from turning a runaway generation into hours of local
decoding; the headroom stops a small-window model from advertising an output
cap that fills its own window (the 32K-context `BugTraceAI-CORE-Fast`:
32768 → 24576). Overshooting is harmless either way: llama.cpp truncates at
the window instead of rejecting the request (verified — `max_tokens:
1000000` on a 262144-token model returns a normal `stop`), and omp re-fits
every request's cap to the room actually left
(`fitOutputTokensToContextWindow`).

## Verification

- `omp models find lemonade` — roster with thinking ladders on reasoners
- `omp models find lemonade-<name>` — the same for a LAN server's roster
- `omp -p --model lemonade/<id> --thinking high "Reply with exactly: ok"`
- `omp -p --model lemonade-<name>/<id> "Reply with exactly: ok"`

## Notes and limitations

- When no key is configured, the provider sends a placeholder
  `Authorization: Bearer LEMONADE_API_KEY_PLACEHOLDER` header: omp extensions
  require a credential field for custom providers, and a keyless lemonade
  ignores the header. With a key configured (see
  [API keys](#api-keys-optional)) the real key replaces the placeholder on
  every request, including this extension's own discovery and probe fetches.
- Effort levels route through OpenAI `reasoning_effort`; lemonade forwards
  values other than `"none"` verbatim to llama.cpp, so graded effects are
  chat-template-dependent per model.
- See [Output cap](#output-cap) for how `maxTokens` is chosen and why most
  lemonade models report no cap at all.
- Because the window follows the effective `context_length`, a model's
  advertised window (and its derived cap) can move between refreshes: lemonade
  auto-tunes `ctx_size` to the memory left for the KV cache, so loading other
  models or editing `ctx_size` changes what one refresh reports. Re-run
  `omp models refresh lemonade` after such a change.
- A prompt that exceeds the server's loaded `ctx_size` can come back as
  **HTTP 200 with an empty completion**, not a 400: lemonade relays backend
  `exceed_context_size_error` rejections through its SSE stream with the
  status code lost (observed: a 310K-token prompt against `--ctx-size
  262144`). omp's openai-completions transport can only see the 200, so
  the session shows an empty assistant reply (if the relayed stream also
  carries a benign finish chunk, omp's empty-completion retry may first
  burn its replays on the deterministic failure). The advertised
  `contextWindow` is the one lever keeping omp's compaction under the
  server limit, so on an unexplained empty response first check for a stale
  window (the preceding bullet) and re-run `omp models refresh lemonade`;
  `/lemonade-probe` likewise reports empty completions as unknown outcomes,
  never as "no reasoning content". Restoring the lost status code is an
  upstream lemonade fix.
- Thinking levels are selected via `--thinking` / `/thinking`; the
  `lemonade/<id>:high` selector suffix does not resolve for
  extension-registered models.
- The durable fix for unlabeled reasoners is upstream: lemonade already
  auto-detects tool-calling/vision from GGUF metadata (`gguf_capabilities.h`)
  but not reasoning — an issue/PR there would retire the local JSON file.
