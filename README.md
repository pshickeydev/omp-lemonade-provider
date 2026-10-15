# omp-lemonade-provider

An [omp](https://github.com/can1357/oh-my-pi) extension that registers a
`lemonade` provider with capability-aware model discovery for
[Lemonade Server](https://github.com/lemonade-sdk/lemonade) (AMD's local LLM
runtime).

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
- `context_length` / `max_context_window` → context window (falls back to
  128000 when the server reports neither)

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

The server URL defaults to `http://localhost:13305`. Override with an
environment variable (e.g. in `~/.bashrc`) to point at another instance:

```bash
export LEMONADE_BASE_URL="http://192.168.1.37:13305"
```

## Unlabeled reasoning models

Lemonade derives its `reasoning` label from registry metadata, not from the
GGUF chat template, so thinking models can be served without it. These are
tracked in `extra-reasoning.local.json` (gitignored — the list is
machine-local, never committed):

```json
{
  "extraReasoning": {
    "Some-Model-That-Reasons": true
  }
}
```

See `extra-reasoning.example.json` for the shape. A missing file (fresh
checkout) degrades to label-only detection; a corrupt file warns once and also
degrades. Models with the server `reasoning` label always keep their ladder.

## Updating the list: `/lemonade-probe`

Inside an omp session, run:

```
/lemonade-probe
```

It probes each chat model that lacks the `reasoning` label and isn't already
listed, with a small completion request (`"What is 17*23? Think briefly then
answer."`, `max_tokens: 512` — trivial prompts don't elicit reasoning on all
models), and appends models whose response carries `reasoning_content` to
`extra-reasoning.local.json`. Probes run sequentially with a 120 s budget each;
cold models JIT-load on first probe and can take minutes. After it reports
additions, run `omp models refresh lemonade` (or restart omp) to apply.

## Verification

- `omp models find lemonade` — roster with thinking ladders on reasoners
- `omp -p --model lemonade/<id> --thinking high "Reply with exactly: ok"`

## Notes and limitations

- The provider sends a placeholder `Authorization: Bearer
  LEMONADE_API_KEY_PLACEHOLDER` header: omp extensions require a credential
  field for custom providers, and lemonade is keyless, so the header is
  harmless.
- Effort levels route through OpenAI `reasoning_effort`; lemonade forwards
  values other than `"none"` verbatim to llama.cpp, so graded effects are
  chat-template-dependent per model.
- `maxTokens` is fixed at 32768 for all models; output caps reported by the
  server are not read.
- Thinking levels are selected via `--thinking` / `/thinking`; the
  `lemonade/<id>:high` selector suffix does not resolve for
  extension-registered models.
- The durable fix for unlabeled reasoners is upstream: lemonade already
  auto-detects tool-calling/vision from GGUF metadata (`gguf_capabilities.h`)
  but not reasoning — an issue/PR there would retire the local JSON file.
