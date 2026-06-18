/**
 * pi extension: Z.AI Coding Plan provider override.
 *
 * Registers the Z.AI Coding Plan endpoint (https://api.z.ai/api/coding/paas/v4)
 * as the built-in `zai` provider using the OpenAI Chat Completions transport,
 * with Coding-Plan-correct thinking/reasoning, payload normalization, and
 * practical CLI toggles. Built-in `openai-completions` already parses
 * `reasoning_content`, streamed tool-call deltas, `usage.cached_tokens`, and
 * `finish_reason`, so no custom streamSimple is needed.
 *
 * All payload/thinking mapping logic lives in pure, exported functions so it
 * can be unit-tested without spinning up pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export type JsonObject = Record<string, any>;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const MAX_OUTPUT_TOKENS = 131_072;
const GLM_45_MAX_OUTPUT_TOKENS = 98_304;
const REASONING_EFFORT_MODEL_IDS = new Set(["glm-5", "glm-5.1", "glm-5.2"]);

/**
 * Z.AI Coding Plan OpenAI-compat settings.
 * `thinkingFormat: "zai"` makes the built-in provider emit
 * `thinking: { type }` and (for GLM-5.2) `reasoning_effort`.
 */
const zaiCompatBase = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
  thinkingFormat: "zai",
  zaiToolStream: true,
} as const;

// ---------------------------------------------------------------------------
// Thinking / reasoning mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Pi thinking level (or payload reasoning_effort) -> GLM-5.2 effort.
 *
 * Z.AI docs (api-reference/llm/chat-completion + guides/overview/concept-param):
 *   none/minimal -> skip thinking (disabled)
 *   low/medium   -> "high"
 *   high         -> "high"
 *   xhigh/max    -> "max"
 *
 * Returns null to mean "thinking disabled" (no reasoning_effort).
 */
export function resolveGlm52Effort(
  value: string | undefined | null,
): "high" | "max" | null {
  if (value === undefined || value === null) return null;
  const v = String(value).toLowerCase();
  if (v === "off" || v === "none" || v === "minimal" || v === "disabled") {
    return null;
  }
  if (v === "xhigh" || v === "max") return "max";
  // low, medium, high, and any unrecognized -> high
  return "high";
}

export interface ZaiFlags {
  /** `--zai-reasoning-effort`: hard override (off|minimal|low|medium|high|xhigh|max|none). */
  reasoningEffortOverride?: string;
  /** `--zai-tool-stream`: send tool_stream when streaming tools. Default true. */
  toolStream?: boolean;
  /** `--zai-preserve-thinking`: Coding Plan preserves reasoning by default. Default true. */
  preserveThinking?: boolean;
  /** `--zai-json`: response_format json_object. Default false. */
  json?: boolean;
  /** `--zai-do-sample`: sampling toggle. Default true (Z.AI default). */
  doSample?: boolean;
  /** `--zai-request-id`: 6-64 char request id. */
  requestId?: string;
  /** `--zai-user-id`: 6-128 char user id. */
  userId?: string;
}

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True for Z.AI Coding Plan models served by this extension. */
export function isZaiCodingModel(model: any): boolean {
  return model?.provider === "zai";
}

/** Exact GLM-5.2 model id. */
export function isGlm52(modelId: unknown): boolean {
  return typeof modelId === "string" && modelId.toLowerCase() === "glm-5.2";
}

/**
 * Live Coding Plan endpoint behavior: `glm-5` and `glm-5.1` currently route to
 * `glm-5.2`, so `reasoning_effort` works for those aliases too.
 */
export function supportsReasoningEffort(modelId: unknown): boolean {
  return typeof modelId === "string" && REASONING_EFFORT_MODEL_IDS.has(modelId.toLowerCase());
}

/**
 * Normalize a Z.AI Coding Plan request payload before it is sent.
 *
 * Handles (per Z.AI Coding Plan docs):
 *  - max_tokens / max_completion_tokens
 *  - tools[].function.strict removal
 *  - tool_stream management (flag-gated)
 *  - thinking.type shape, reasoning_effort where supported (high/max), off/minimal respect
 *  - preserved thinking (thinking.clear_thinking) defaulting to Coding Plan omit
 *  - optional JSON mode, do_sample, request_id, user_id
 *
 * Pure: returns a new payload object. `modelId` selects GLM-5.2 behavior.
 */
export function normalizeZaiPayload(
  modelId: string,
  payload: JsonObject,
  flags: ZaiFlags = {},
): JsonObject {
  const next: JsonObject = { ...payload };

  // 1. max_tokens: prefer max_tokens, drop max_completion_tokens.
  if (next.max_completion_tokens !== undefined) {
    if (next.max_tokens === undefined) {
      next.max_tokens = next.max_completion_tokens;
    }
    delete next.max_completion_tokens;
  }
  if (next.max_tokens === undefined) {
    // ponytail: Coding Plan cap; provider already sets this when configured, but
    // enforce a sane default if a caller path omits it.
    next.max_tokens = MAX_OUTPUT_TOKENS;
  }

  // 2. tools: strip unsupported `strict`; manage tool_stream.
  if (Array.isArray(next.tools)) {
    for (const tool of next.tools) {
      if (isObject(tool?.function)) delete tool.function.strict;
      if (tool && "strict" in tool) delete tool.strict;
    }
  }
  const wantToolStream = flags.toolStream !== false; // default true
  const shouldStreamTools = next.stream === true && Array.isArray(next.tools) && next.tools.length > 0;
  if (wantToolStream && shouldStreamTools) {
    next.tool_stream = true;
  } else {
    // Docs: tool_stream only applies when streaming tool calls. Drop it otherwise
    // (the built-in sets it unconditionally for zai, so normalize here).
    delete next.tool_stream;
  }

  // 3. thinking + reasoning_effort.
  //    Built-in zai logic already set thinking.type from the Pi thinking level.
  //    Override flag takes precedence; otherwise normalize what's present.
  const effortOverride = flags.reasoningEffortOverride;
  const supportsEffort = supportsReasoningEffort(modelId);
  const thinking = isObject(next.thinking) ? { ...next.thinking } : {};

  if (effortOverride !== undefined && effortOverride !== "") {
    const resolved = resolveGlm52Effort(effortOverride);
    if (resolved === null) {
      thinking.type = "disabled";
      delete next.reasoning_effort;
    } else {
      thinking.type = "enabled";
      if (supportsEffort) next.reasoning_effort = resolved;
      else delete next.reasoning_effort;
    }
  } else {
    // Derive intent from what the built-in produced.
    const currentType = typeof thinking.type === "string" ? thinking.type : undefined;
    const currentEffort = typeof next.reasoning_effort === "string" ? next.reasoning_effort : undefined;
    const enabled = currentType === "enabled" || (!currentType && currentEffort);

    if (enabled) {
      // minimal/none should skip thinking even though the built-in enabled it.
      const resolved = resolveGlm52Effort(currentEffort ?? "high");
      if (resolved === null) {
        thinking.type = "disabled";
        delete next.reasoning_effort;
      } else {
        thinking.type = "enabled";
        if (supportsEffort) {
          next.reasoning_effort = resolved;
        } else {
          // Non-5.2 models: thinking on/off only, no reasoning_effort.
          delete next.reasoning_effort;
        }
      }
    } else {
      // Explicit off (or default-off path). Respect disabled.
      thinking.type = "disabled";
      delete next.reasoning_effort;
    }
  }
  // Clean up stray aliases other layers may have left behind.
  delete next.enable_thinking;
  delete next.reasoning_level;
  delete next.thinking_level;
  next.thinking = thinking;

  // 4. Preserved / interleaved thinking.
  //    Live probe: omit behaves like clear_thinking=true. Preserve requires false.
  if ((isObject(next.thinking) ? next.thinking.type : undefined) !== "disabled") {
    next.thinking = {
      ...(isObject(next.thinking) ? next.thinking : {}),
      clear_thinking: flags.preserveThinking === false ? true : false,
    };
  }

  // 5. Optional JSON mode.
  if (flags.json) {
    next.response_format = { type: "json_object" };
  }

  // 6. Optional sampling / request metadata.
  if (typeof flags.doSample === "boolean") {
    next.do_sample = flags.doSample;
  }
  if (flags.requestId) next.request_id = flags.requestId;
  if (flags.userId) next.user_id = flags.userId;

  return next;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/**
 * Hide duplicate/no-op thinking levels from Pi's cycling UI.
 *
 * Z.AI exposes only meaningful levels to Pi: aliases/no-ops are hidden.
 *
 * Live probes show `glm-5` and `glm-5.1` currently route to `glm-5.2`, so they
 * get the same off/high/xhigh surface. Other models expose off/high only.
 */
const effortThinkingLevelMap = {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max",
} as const;

const thinkingOnOffOnlyMap = {
  minimal: null,
  low: null,
  medium: null,
  xhigh: null,
} as const;

interface ModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

const MODEL_SPECS: ModelSpec[] = [
  { id: "glm-4.5", name: "GLM-4.5", contextWindow: 131_072, maxTokens: GLM_45_MAX_OUTPUT_TOKENS },
  { id: "glm-4.5-air", name: "GLM-4.5-Air", contextWindow: 131_072, maxTokens: GLM_45_MAX_OUTPUT_TOKENS },
  { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000, maxTokens: MAX_OUTPUT_TOKENS },
  { id: "glm-4.7", name: "GLM-4.7", contextWindow: 204_800, maxTokens: MAX_OUTPUT_TOKENS },
  { id: "glm-5", name: "GLM-5", contextWindow: 200_000, maxTokens: MAX_OUTPUT_TOKENS },
  { id: "glm-5-turbo", name: "GLM-5-Turbo", contextWindow: 200_000, maxTokens: MAX_OUTPUT_TOKENS },
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxTokens: MAX_OUTPUT_TOKENS },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxTokens: MAX_OUTPUT_TOKENS },
];

export function buildZaiModels() {
  return MODEL_SPECS.map((spec) => {
    const effort = supportsReasoningEffort(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      reasoning: true,
      thinkingLevelMap: effort ? effortThinkingLevelMap : thinkingOnOffOnlyMap,
      input: ["text" as const],
      cost: ZERO_COST,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      compat: { ...zaiCompatBase, supportsReasoningEffort: effort },
    };
  });
}

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function readFlags(getFlag: (n: string) => boolean | string | undefined): ZaiFlags {
  const str = (n: string): string | undefined => {
    const v = getFlag(n);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const bool = (n: string): boolean | undefined => {
    const v = getFlag(n);
    return typeof v === "boolean" ? v : undefined;
  };
  return {
    reasoningEffortOverride: str("zai-reasoning-effort"),
    toolStream: bool("zai-tool-stream"),
    preserveThinking: bool("zai-preserve-thinking"),
    json: bool("zai-json"),
    doSample: bool("zai-do-sample"),
    requestId: str("zai-request-id"),
    userId: str("zai-user-id"),
  };
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function zaiCodingPlan(pi: ExtensionAPI): void {
  // --- Flags (defaults are safe / Coding-Plan-correct) ---
  pi.registerFlag("zai-reasoning-effort", {
    type: "string",
    default: "",
    description: "Override Z.AI reasoning effort (off|minimal|low|medium|high|xhigh|max|none).",
  });
  pi.registerFlag("zai-tool-stream", {
    type: "boolean",
    default: true,
    description: "Send tool_stream=true when streaming tool calls.",
  });
  pi.registerFlag("zai-preserve-thinking", {
    type: "boolean",
    default: true,
    description: "Preserve reasoning_content across turns (Coding Plan default). Disable to clear thinking each turn.",
  });
  pi.registerFlag("zai-json", {
    type: "boolean",
    default: false,
    description: "Request JSON object output (response_format json_object).",
  });
  pi.registerFlag("zai-do-sample", {
    type: "boolean",
    default: true,
    description: "Enable sampling (do_sample). Disable for greedy decoding.",
  });
  pi.registerFlag("zai-request-id", {
    type: "string",
    default: "",
    description: "Set request_id (6-64 chars) on every request.",
  });
  pi.registerFlag("zai-user-id", {
    type: "string",
    default: "",
    description: "Set user_id (6-128 chars) on every request.",
  });

  // --- Provider override ---
  pi.registerProvider("zai", {
    name: "Z.AI Coding Plan",
    baseUrl: ZAI_CODING_BASE_URL,
    apiKey: "$ZAI_API_KEY",
    api: "openai-completions",
    models: buildZaiModels(),
  });

  // --- Payload normalization (replaces the outgoing payload) ---
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (!isObject(payload) || !isZaiCodingModel(ctx.model)) return undefined;
    const modelId = typeof payload.model === "string" ? payload.model : ctx.model?.id;
    if (typeof modelId !== "string") return undefined;
    return normalizeZaiPayload(modelId, payload, readFlags((n) => pi.getFlag(n)));
  });

  // --- Terse status command ---
  pi.registerCommand("zai-status", {
    description: "Show active Z.AI Coding Plan model, thinking level, and flags.",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const level = pi.getThinkingLevel();
      const lines: string[] = [];
      if (model && isZaiCodingModel(model)) {
        lines.push(`provider: zai (Z.AI Coding Plan)`);
        lines.push(`model: ${model.id}`);
        lines.push(`reasoning_effort supported: ${supportsReasoningEffort(model.id) ? "yes" : "no"}`);
      } else {
        lines.push(`provider: ${model?.provider ?? "(none)"}`);
        lines.push(`model: ${model?.id ?? "(none)"}`);
      }
      lines.push(`thinking level: ${level}`);
      const f = readFlags((n) => pi.getFlag(n));
      lines.push(
        `flags: reasoning=${f.reasoningEffortOverride ? "override=" + f.reasoningEffortOverride : "auto"}, ` +
          `tool_stream=${f.toolStream !== false}, preserve_thinking=${f.preserveThinking !== false}, ` +
          `json=${!!f.json}, do_sample=${f.doSample !== false}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
