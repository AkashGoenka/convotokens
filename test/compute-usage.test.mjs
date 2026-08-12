import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeUsage } from "../scripts/lib/compute-usage.mjs";

function usageLine(id, usage, extra = {}) {
  return JSON.stringify({ type: "assistant", message: { id, usage, model: "claude-sonnet-5", ...extra } });
}

async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "convotokens-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("dedupes assistant lines by message.id", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    writeFileSync(
      transcript,
      [usageLine("m1", usage), usageLine("m1", usage), usageLine("m2", usage)].join("\n") + "\n",
    );

    const result = await computeUsage(transcript);
    assert.equal(result.rawAssistantLines, 3);
    assert.equal(result.uniqueAssistantMessages, 2);
    assert.equal(result.overall.total, 30); // 2 unique turns * 15 tokens
  });
});

test("folds subagent sidecar files into overall total and reports bySource/byAgentType", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    const sessionDir = join(dir, "sess", "subagents");
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(transcript, usageLine("main-1", { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");

    writeFileSync(
      join(sessionDir, "agent-1.jsonl"),
      usageLine("sub-1", { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n",
    );
    writeFileSync(join(sessionDir, "agent-1.meta.json"), JSON.stringify({ agentType: "Explore" }));

    writeFileSync(
      join(sessionDir, "agent-2.jsonl"),
      usageLine("sub-2", { input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n",
    );
    writeFileSync(join(sessionDir, "agent-2.meta.json"), JSON.stringify({ agentType: "general-purpose" }));

    const result = await computeUsage(transcript);
    assert.equal(result.subagentFileCount, 2);
    assert.equal(result.overall.total, 150);
    assert.equal(result.bySource.main.total, 100);
    assert.equal(result.bySource.subagent.total, 50);
    assert.equal(result.byAgentType.Explore.total, 20);
    assert.equal(result.byAgentType["general-purpose"].total, 30);
  });
});

test("handles nested subagent sidecar dirs and a missing/malformed meta.json as unknown", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    const nested = join(dir, "sess", "subagents", "workflows", "wf-1");
    mkdirSync(nested, { recursive: true });

    writeFileSync(transcript, usageLine("main-1", { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");
    writeFileSync(
      join(nested, "agent-1.jsonl"),
      usageLine("sub-1", { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n",
    );
    // no agent-1.meta.json written

    const result = await computeUsage(transcript);
    assert.equal(result.subagentFileCount, 1);
    assert.equal(result.byAgentType.unknown.total, 5);
  });
});

test("reports tokens since last compact separately from the lifetime total", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    const usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const lines = [
      usageLine("pre-1", usage),
      usageLine("pre-2", usage),
      JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 42 } }),
      usageLine("post-1", usage),
    ];
    writeFileSync(transcript, lines.join("\n") + "\n");

    const result = await computeUsage(transcript);
    assert.equal(result.overall.total, 30); // lifetime: pre-1 + pre-2 + post-1
    assert.equal(result.compact.boundaryCount, 1);
    assert.equal(result.compact.lastPostTokens, 42);
    assert.equal(result.compact.sinceLastCompact.total, 10); // only post-1
  });
});

test("with no compact_boundary record, compact.sinceLastCompact is null and boundaryCount is 0", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    writeFileSync(transcript, usageLine("m1", { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");

    const result = await computeUsage(transcript);
    assert.equal(result.compact.boundaryCount, 0);
    assert.equal(result.compact.sinceLastCompact, null);
    assert.equal(result.subagentFileCount, 0);
    assert.deepEqual(result.byAgentType, {});
  });
});

test("skips malformed JSON lines without throwing", async () => {
  await withFixture(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    writeFileSync(
      transcript,
      ["not json", usageLine("m1", { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })].join("\n") + "\n",
    );

    const result = await computeUsage(transcript);
    assert.equal(result.malformedLines, 1);
    assert.equal(result.overall.total, 1);
  });
});
