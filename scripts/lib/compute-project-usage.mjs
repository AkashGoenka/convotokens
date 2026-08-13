/**
 * Pure aggregation over an already-resolved list of sessions — kept separate
 * from project-usage.mjs's filesystem discovery (homedir-rooted, hard to
 * unit test) so the summing logic itself is testable with temp fixtures.
 */
import { emptyTotals as emptyClaudeTotals, computeUsage } from "./compute-usage.mjs";
import { emptyTotals as emptyCodexTotals, computeSessionUsage } from "./compute-codex-usage.mjs";

export async function sumClaudeSessions(files) {
  const overall = { ...emptyClaudeTotals() };
  let total = 0;
  for (const file of files) {
    const result = await computeUsage(file);
    for (const key of Object.keys(overall)) overall[key] += result.overall[key] || 0;
    total += result.overall.total;
  }
  return { sessionCount: files.length, overall: { ...overall, total } };
}

export function sumCodexSessions(sessions) {
  const overall = { ...emptyCodexTotals() };
  let counted = 0;
  for (const { file, meta } of sessions) {
    const usage = computeSessionUsage(file, meta.id);
    if (!usage) continue;
    counted++;
    for (const key of Object.keys(overall)) overall[key] += usage[key] || 0;
  }
  return { sessionCount: counted, overall };
}
