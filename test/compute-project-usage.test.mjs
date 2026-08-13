import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sumClaudeSessions, sumCodexSessions } from "../scripts/lib/compute-project-usage.mjs";

async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "convotokens-project-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sumClaudeSessions sums total tokens and turns across multiple session files", async () => {
  await withFixture(async (dir) => {
    const usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const sessionA = join(dir, "a.jsonl");
    writeFileSync(sessionA, JSON.stringify({ type: "assistant", message: { id: "m1", usage, model: "claude-sonnet-5" } }) + "\n");
    const sessionB = join(dir, "b.jsonl");
    writeFileSync(
      sessionB,
      [
        JSON.stringify({ type: "assistant", message: { id: "m2", usage, model: "claude-sonnet-5" } }),
        JSON.stringify({ type: "assistant", message: { id: "m3", usage, model: "claude-sonnet-5" } }),
      ].join("\n") + "\n",
    );

    const result = await sumClaudeSessions([sessionA, sessionB]);
    assert.equal(result.sessionCount, 2);
    assert.equal(result.overall.total, 30);
    assert.equal(result.overall.turns, 3);
  });
});

test("sumClaudeSessions returns zeroed totals for an empty session list", async () => {
  const result = await sumClaudeSessions([]);
  assert.equal(result.sessionCount, 0);
  assert.equal(result.overall.total, 0);
  assert.equal(result.overall.turns, 0);
});

test("sumCodexSessions sums latest snapshots and turns across multiple sessions", async () => {
  await withFixture(async (dir) => {
    const tokenCount = (usage) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } });
    const sessionA = join(dir, "a.jsonl");
    writeFileSync(
      sessionA,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/tmp/example" } }),
        tokenCount({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 }),
      ].join("\n") + "\n",
    );
    const sessionB = join(dir, "b.jsonl");
    writeFileSync(
      sessionB,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "s2", cwd: "/tmp/example" } }),
        tokenCount({ input_tokens: 20, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 20 }),
        tokenCount({ input_tokens: 25, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 25 }),
      ].join("\n") + "\n",
    );

    const result = sumCodexSessions([
      { file: sessionA, meta: { id: "s1" } },
      { file: sessionB, meta: { id: "s2" } },
    ]);
    assert.equal(result.sessionCount, 2);
    assert.equal(result.overall.total_tokens, 35); // 10 + latest snapshot (25) of session B
    assert.equal(result.overall.turns, 3); // 1 turn in A + 2 turns in B
  });
});
