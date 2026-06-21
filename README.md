# pi-zai-coding-plan

> **Deprecated / archived.** This extension is no longer needed with pi 0.79.9+
> because pi now ships built-in Z.AI Coding Plan support for the `zai` provider,
> including the Coding Plan endpoint, OpenAI Chat Completions transport,
> Z.AI thinking format, `tool_stream`, and GLM-5.2 `reasoning_effort` handling.
>
> Use pi's built-in provider instead:
>
> ```bash
> export ZAI_API_KEY=...
> pi --model zai/glm-5.2:high
> ```
>
> This repository is kept only as a historical reference. Do not install it for
> normal use; it may override newer built-in Z.AI model metadata.

A formerly useful [pi](https://pi.dev) extension that overrode the built-in `zai`
provider with the [Z.AI Coding Plan](https://docs.z.ai/guides/coding/overview)
endpoint, models, and OpenAI Chat Completions-compatible request handling.

## Historical install

Do **not** install this extension unless you are intentionally testing old behavior.
Pi 0.79.9+ does not need it.

```bash
# historical only
pi install /Users/mitchfultz/Projects/AI/pi-zai-coding-plan

# historical only
pi -e /Users/mitchfultz/Projects/AI/pi-zai-coding-plan
```

For pi's built-in provider, set your Coding Plan key:

```bash
export ZAI_API_KEY=...
```

The extension registers the `zai` provider against
`https://api.z.ai/api/coding/paas/v4` with `apiKey: "$ZAI_API_KEY"` and
`api: "openai-completions"`, and a friendly provider name `Z.AI Coding Plan`.

> The pre-existing single-file shim at `~/.pi/agent/extensions/zai-coding-plan.ts`
> is intentionally left in place and is **not** edited by this package. Remove or
> disable it if both are loaded, to avoid double registration.

## Models

All models are text-in / text-out, reasoning-capable, zero cost (Coding Plan uses
plan quota, not balance). The catalog matches live `/models` from the Coding Plan
endpoint.

| Model | Context | Max output | `reasoning_effort` |
|-------|--------:|-----------:|:------------------:|
| `glm-4.5` | 131,072 | 98,304 | no |
| `glm-4.5-air` | 131,072 | 98,304 | no |
| `glm-4.6` | 200,000 | 131,072 | no |
| `glm-4.7` | 204,800 | 131,072 | no |
| `glm-5` | 200,000 | 131,072 | yes, live-routes to `glm-5.2` |
| `glm-5-turbo` | 200,000 | 131,072 | no |
| `glm-5.1` | 200,000 | 131,072 | yes, live-routes to `glm-5.2` |
| `glm-5.2` | 1,000,000 | 131,072 | yes |

Docs only promise `reasoning_effort` for GLM-5.2. Live probes show the Coding Plan
endpoint currently routes `glm-5` and `glm-5.1` requests to `glm-5.2`, so this
extension exposes the GLM-5.2 thinking surface for those aliases too.

## Thinking and reasoning

Pi's native thinking controls drive everything, but duplicate/no-op levels are
hidden from Pi's thinking cycle:

```bash
pi --model zai/glm-5.2 --thinking off        # thinking disabled
pi --model zai/glm-5.2 --thinking high       # reasoning_effort high
pi --model zai/glm-5.2 --thinking xhigh      # reasoning_effort max
```

Visible levels:

| Model | Visible Pi levels |
|-------|-------------------|
| `glm-5`, `glm-5.1`, `glm-5.2` | `off`, `high`, `xhigh` |
| other Coding Plan models | `off`, `high` |

`minimal` duplicates off, and `low`/`medium` duplicate high in Z.AI's documented
mapping, so this package marks them unsupported to avoid a misleading cycle UI.
Pi keeps the most recently used thinking level across model switches and clamps it
to the nearest supported level for the selected model. Examples:

- current `xhigh` + switch to `glm-5.2` -> stays `xhigh` (`reasoning_effort=max`)
- current `xhigh` + switch to `glm-5.1` -> stays `xhigh` because it live-routes to `glm-5.2`
- current `xhigh` + switch to `glm-5-turbo` -> snaps to `high`
- current `medium` + switch to any Z.AI Coding Plan model -> snaps to `high`
- current `off` -> stays `off`

Non-effort models send only `thinking.type` (`enabled`/`disabled`) and never
`reasoning_effort`.

## Flags

| Flag | Default | Effect |
|------|---------|--------|
| `--zai-reasoning-effort` | *(unset)* | Hard override: `off\|minimal\|low\|medium\|high\|xhigh\|max\|none` |
| `--zai-tool-stream` | `true` | Send `tool_stream=true` when streaming tool calls |
| `--zai-preserve-thinking` | `true` | Preserve `reasoning_content` across turns by setting `thinking.clear_thinking=false`. Disable to set `true` |
| `--zai-json` | `false` | Request JSON output (`response_format: {type:"json_object"}`) |
| `--zai-do-sample` | `true` | Sampling toggle (`do_sample`) |
| `--zai-request-id` | *(unset)* | Set `request_id` (6–64 chars) |
| `--zai-user-id` | *(unset)* | Set `user_id` (6–128 chars) |

## Payload normalization

`before_provider_request` rewrites the outgoing request to be Coding-Plan-correct:

- Ensures `max_tokens`, removes `max_completion_tokens`.
- Strips unsupported `strict` from `tools[].function`.
- Manages `tool_stream` (flag-gated) when streaming tools.
- Sets the Z.AI `thinking.type` shape; normalizes `reasoning_effort` to `high`/`max`
  for live-confirmed effort models; never forces max over explicit `off`.
- Sets `thinking.clear_thinking=false` by default to preserve previous reasoning.
  Live probes showed omitting this field behaves like `true`.
- Optional JSON mode, `do_sample`, `request_id`, `user_id`.

## Commands

- `/zai-status` — terse summary of the active Z.AI model, thinking level, and flags.

## Validation

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test (pure payload/thinking mapping unit tests)
pi --no-extensions -e ./extensions/zai-coding-plan.ts --list-models 'zai/glm'
```

## Live probe evidence

Direct Coding Plan API probes confirmed:

- `/models` returns `glm-4.5`, `glm-4.5-air`, `glm-4.6`, `glm-4.7`, `glm-5`,
  `glm-5-turbo`, `glm-5.1`, `glm-5.2`.
- `glm-5` and `glm-5.1` currently return `model: "glm-5.2"` in responses.
- `tool_stream=true` streamed `delta.tool_calls[*].function.arguments` and finished
  with `finish_reason: "tool_calls"`.
- `response_format: {type:"json_object"}`, `do_sample`, `request_id`, and `user_id`
  are accepted.
- `thinking.clear_thinking=false` is required to include previous
  `reasoning_content`; omitting it matched `clear_thinking=true` in prompt-token use.

## Known limitations

- Response parsing (streamed `reasoning_content`, tool-call deltas, cached-token
  usage, `finish_reason` error codes) depends on pi core's `openai-completions`
  provider and cannot be changed from this extension. Z.AI's documented
  `finish_reason` values include `sensitive`, `model_context_window_exceeded`, and
  `network_error`; abnormal streaming termination may omit business error codes.
- Preserved-thinking replay correctness depends on the caller sending unmodified,
  correctly ordered historical `reasoning_content`; pi handles this in core.
- `--thinking medium` still works as a CLI input, but Pi clamps it to `high` because
  `medium` is hidden from the model's supported thinking levels.
