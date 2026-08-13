import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, findSubagentFiles, computeSessionUsage } from "../scripts/lib/compute-codex-usage.mjs";

function tokenCountLine(usage) {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } });
}

function sessionMetaLine(id, cwd, extra = {}) {
  return JSON.stringify({ type: "session_meta", payload: { id, cwd, ...extra } });
}

async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "convotokens-codex-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readSession keeps only the latest cumulative snapshot but counts every turn", async () => {
  await withFixture((dir) => {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        sessionMetaLine("s1", "/tmp/example"),
        tokenCountLine({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 127 }),
        tokenCountLine({ input_tokens: 300, cached_input_tokens: 120, output_tokens: 15, reasoning_output_tokens: 4, total_tokens: 439 }),
      ].join("\n") + "\n",
    );

    const result = readSession(file);
    assert.equal(result.turnCount, 2);
    assert.equal(result.usage.total_tokens, 439); // latest snapshot, not summed
  });
});

test("folds delegated subagent rollouts into bySource/byAgentType with turn counts", async () => {
  await withFixture((dir) => {
    mkdirSync(dir, { recursive: true });
    const mainFile = join(dir, "main.jsonl");
    writeFileSync(
      mainFile,
      [
        sessionMetaLine("parent-1", "/tmp/example"),
        tokenCountLine({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100 }),
      ].join("\n") + "\n",
    );

    const subFile = join(dir, "sub.jsonl");
    writeFileSync(
      subFile,
      [
        sessionMetaLine("child-1", "/tmp/example", { source: { subagent: { agent_role: "Explore", thread_spawn: { parent_thread_id: "parent-1" } } } }),
        tokenCountLine({ input_tokens: 20, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 20 }),
        tokenCountLine({ input_tokens: 40, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 40 }),
      ].join("\n") + "\n",
    );

    const children = findSubagentFiles(mainFile, "parent-1");
    assert.deepEqual(children, [subFile]);

    const usage = computeSessionUsage(mainFile, "parent-1");
    assert.equal(usage.subagentFileCount, 1);
    assert.equal(usage.total_tokens, 140); // 100 main + 40 latest subagent snapshot
    assert.equal(usage.turns, 3); // 1 main turn + 2 subagent turns
    assert.equal(usage.bySource.main.turns, 1);
    assert.equal(usage.bySource.subagent.turns, 2);
    assert.equal(usage.byAgentType.Explore.turns, 2);
    assert.equal(usage.byAgentType.Explore.total_tokens, 40);
  });
});

test("computeSessionUsage with no subagents reports turns from the main session only", async () => {
  await withFixture((dir) => {
    const file = join(dir, "solo.jsonl");
    writeFileSync(
      file,
      [
        sessionMetaLine("solo-1", "/tmp/example"),
        tokenCountLine({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 5 }),
      ].join("\n") + "\n",
    );

    const usage = computeSessionUsage(file, "solo-1");
    assert.equal(usage.turns, 1);
    assert.equal(usage.subagentFileCount, 0);
  });
});
