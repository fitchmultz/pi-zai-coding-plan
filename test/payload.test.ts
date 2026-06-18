import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeZaiPayload,
  resolveGlm52Effort,
  buildZaiModels,
  supportsReasoningEffort,
} from "../extensions/zai-coding-plan.ts";

// --- resolveGlm52Effort -----------------------------------------------------

test("resolveGlm52Effort: off/minimal/none -> null (disabled)", () => {
  for (const v of ["off", "none", "minimal", "disabled", undefined, null]) {
    assert.equal(resolveGlm52Effort(v as any), null, `expected null for ${v}`);
  }
});

test("resolveGlm52Effort: low/medium/high -> high", () => {
  for (const v of ["low", "medium", "high"]) {
    assert.equal(resolveGlm52Effort(v), "high", `expected high for ${v}`);
  }
});

test("resolveGlm52Effort: xhigh/max -> max", () => {
  assert.equal(resolveGlm52Effort("xhigh"), "max");
  assert.equal(resolveGlm52Effort("max"), "max");
});

// --- model catalog ----------------------------------------------------------

test("buildZaiModels: Coding Plan /models catalog with correct context windows and output caps", () => {
  const models = buildZaiModels();
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(models.length, 8);
  assert.equal(byId["glm-4.5"].contextWindow, 131_072);
  assert.equal(byId["glm-4.5"].maxTokens, 98_304);
  assert.equal(byId["glm-4.5-air"].maxTokens, 98_304);
  assert.equal(byId["glm-4.6"].contextWindow, 200_000);
  assert.equal(byId["glm-5.2"].contextWindow, 1_000_000);
  assert.equal(byId["glm-5.2"].maxTokens, 131_072);
  assert.equal(byId["glm-5-turbo"].contextWindow, 200_000);
  assert.equal(byId["glm-4.7"].contextWindow, 204_800);
  for (const m of models) {
    assert.deepEqual(m.input, ["text"], `${m.id} text-only input`);
    assert.equal(m.reasoning, true, `${m.id} reasoning`);
    assert.equal(m.compat.thinkingFormat, "zai");
    assert.equal(m.compat.maxTokensField, "max_tokens");
    assert.equal(m.compat.supportsStrictMode, false);
  }
});

test("buildZaiModels: live-confirmed effort aliases expose off/high/xhigh", () => {
  const models = buildZaiModels();
  for (const m of models) {
    assert.equal(m.compat.supportsReasoningEffort, supportsReasoningEffort(m.id), `${m.id} effort support`);
  }
  for (const id of ["glm-5", "glm-5.1", "glm-5.2"]) {
    const model = models.find((m) => m.id === id)!;
    assert.deepEqual(model.thinkingLevelMap, {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max",
    });
  }
  const turbo = models.find((m) => m.id === "glm-5-turbo")!;
  assert.deepEqual(turbo.thinkingLevelMap, {
    minimal: null,
    low: null,
    medium: null,
    xhigh: null,
  });
});

// --- payload normalization --------------------------------------------------

test("normalizeZaiPayload: max_completion_tokens -> max_tokens, strict removed", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    max_completion_tokens: 4096,
    tools: [{ type: "function", function: { name: "x", strict: true } }],
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  assert.equal(out.max_tokens, 4096);
  assert.equal(out.max_completion_tokens, undefined);
  assert.equal(out.tools[0].function.strict, undefined);
});

test("normalizeZaiPayload: glm-5.2 default (max) keeps enabled/max", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    stream: true,
    tools: [{ type: "function", function: { name: "t" } }],
  });
  assert.equal(out.thinking.type, "enabled");
  assert.equal(out.thinking.clear_thinking, false);
  assert.equal(out.reasoning_effort, "max");
  assert.equal(out.tool_stream, true);
});

test("normalizeZaiPayload: explicit off is respected (no forced max)", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    thinking: { type: "disabled" },
  });
  assert.deepEqual(out.thinking, { type: "disabled" });
  assert.equal(out.reasoning_effort, undefined);
});

test("normalizeZaiPayload: medium alias normalizes to high", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.equal(out.thinking.type, "enabled");
  assert.equal(out.reasoning_effort, "high");
});

test("normalizeZaiPayload: minimal -> disabled even if built-in enabled it", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    thinking: { type: "enabled" },
    reasoning_effort: "minimal",
  });
  assert.deepEqual(out.thinking, { type: "disabled" });
  assert.equal(out.reasoning_effort, undefined);
});

test("normalizeZaiPayload: non-effort model gets thinking on/off, no reasoning_effort", () => {
  const out = normalizeZaiPayload("glm-5-turbo", {
    model: "glm-5-turbo",
    thinking: { type: "enabled" },
    reasoning_effort: "high", // should be stripped for non-effort models
  });
  assert.equal(out.thinking.type, "enabled");
  assert.equal(out.reasoning_effort, undefined);
});

test("normalizeZaiPayload: live-confirmed aliases keep reasoning_effort", () => {
  for (const model of ["glm-5", "glm-5.1", "glm-5.2"]) {
    const out = normalizeZaiPayload(model, {
      model,
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    assert.equal(out.thinking.type, "enabled");
    assert.equal(out.reasoning_effort, "max", `${model} keeps max`);
  }
});

test("normalizeZaiPayload: reasoning-effort override wins", () => {
  const off = normalizeZaiPayload(
    "glm-5.2",
    { model: "glm-5.2", thinking: { type: "enabled" }, reasoning_effort: "max" },
    { reasoningEffortOverride: "off" },
  );
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.reasoning_effort, undefined);

  const high = normalizeZaiPayload(
    "glm-5.2",
    { model: "glm-5.2", thinking: { type: "disabled" } },
    { reasoningEffortOverride: "high" },
  );
  assert.equal(high.thinking.type, "enabled");
  assert.equal(high.reasoning_effort, "high");
});

test("normalizeZaiPayload: tool_stream flag off removes tool_stream", () => {
  const out = normalizeZaiPayload(
    "glm-5.2",
    { model: "glm-5.2", stream: true, tools: [{ type: "function", function: { name: "t" } }], thinking: { type: "enabled" } },
    { toolStream: false },
  );
  assert.equal(out.tool_stream, undefined);
});

test("normalizeZaiPayload: preserve-thinking off sets clear_thinking", () => {
  const out = normalizeZaiPayload(
    "glm-5.2",
    { model: "glm-5.2", thinking: { type: "enabled" }, reasoning_effort: "max" },
    { preserveThinking: false },
  );
  assert.equal(out.thinking.clear_thinking, true);
});

test("normalizeZaiPayload: preserve-thinking default sets clear_thinking false", () => {
  const out = normalizeZaiPayload("glm-5.2", {
    model: "glm-5.2",
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  assert.equal(out.thinking.clear_thinking, false);
});

test("normalizeZaiPayload: json/do_sample/request_id/user_id flags", () => {
  const out = normalizeZaiPayload(
    "glm-5.2",
    { model: "glm-5.2", thinking: { type: "enabled" }, reasoning_effort: "max" },
    { json: true, doSample: false, requestId: "req-123456", userId: "user-123456" },
  );
  assert.deepEqual(out.response_format, { type: "json_object" });
  assert.equal(out.do_sample, false);
  assert.equal(out.request_id, "req-123456");
  assert.equal(out.user_id, "user-123456");
});

test("normalizeZaiPayload: ensures max_tokens default when absent", () => {
  const out = normalizeZaiPayload("glm-5.2", { model: "glm-5.2", thinking: { type: "disabled" } });
  assert.equal(out.max_tokens, 131_072);
});
