/**
 * Per-answer run log (M6, written from M2 because the loop is what produces the numbers).
 * One JSON file per answer. quality/check.mjs reads these and grades honesty from them:
 *   A1  every failed toolCall carries a non-empty error string
 *   A2  a run in runs/ terminated "done" (see the folder rule below)
 *   A3  no tool called >3x consecutively
 *   B1/B2/B3  tokens / wallClockSec / costUsd under the declared budgets
 *
 * Note the field types the checker expects: `tokens` here is a TOTAL number (in+out), not the
 * {in,out} object the DoneEvent carries. `wallClockSec` and `costUsd` are numbers. Get these
 * shapes wrong and B1/B2/B3 silently skip instead of protecting you.
 *
 * The folder rule (the crux): quality/check.mjs reads runs/*.json NON-recursively and A2 fails
 * any run there that is not "done". A capped or errored run is honest, not "done" — so it goes
 * in runs/failing/ (which the checker ignores, and which is exactly where M13's deliberate
 * failing trajectories are meant to live). We never relabel a cap as done to slip past A2;
 * we file it where the grader expects a non-done run. done → runs/, everything else → failing/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import type { Depth, Terminated } from '@lumina/contract';

export interface RunLogToolCall {
  name: string;
  ok: boolean;
  error?: string;
}

export interface RunLog {
  requestId: string;
  query: string;
  depth: Depth;
  terminated: Terminated;
  model: string;
  /** TOTAL tokens (in+out) — the scalar B1 checks, not the {in,out} object. */
  tokens: number;
  wallClockSec: number;
  costUsd: number;
  ttftMs: number;
  latencyMs: number;
  searchCached: boolean;
  toolCalls: RunLogToolCall[];
}

export function writeRunLog(run: RunLog): void {
  const dir = run.terminated === 'done' ? env.runsDir : join(env.runsDir, 'failing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${run.requestId}.json`), JSON.stringify(run, null, 2));
}
