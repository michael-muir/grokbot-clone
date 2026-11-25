// Provider contract: the rules every AgentProvider must follow, as a reusable node:test suite.
//
// Each provider test file calls describeProviderContract() with a harness that arranges the backend's behavior
// for each scenario (a real backend can't simply be told "call a tool now"). See docs/specs/1-provider-contract-tests.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import type {
  AgentProvider,
  ApprovalDecision,
  ApprovalRequest,
  ProviderEvent,
  RunCallbacks,
  RunOutcome,
  RunRequest,
} from "../../src/types.ts";

export type ContractScenario = "reply" | "tool" | "slow" | "fail";

export interface ContractHarness {
  /** A provider wired so that the given scenario happens on its next run. */
  create(scenario: ContractScenario): AgentProvider;
  /** The prompt to send for a scenario. Defaults to a plain greeting. */
  prompt?(scenario: ContractScenario): string;
}

/** How long a provider may take to stop after its run is aborted. */
export const INTERRUPT_LIMIT_MS = 2000;

/** Records everything a provider does through its callbacks, and flags rule violations as they happen. */
export class Recorder implements RunCallbacks {
  readonly events: ProviderEvent[] = [];
  readonly approvals: ApprovalRequest[] = [];
  readonly violations: string[] = [];
  resolved = false;
  private readonly decide: (req: ApprovalRequest) => ApprovalDecision;
  private readonly onEvent?: (ev: ProviderEvent) => void;

  constructor(decide: (req: ApprovalRequest) => ApprovalDecision, onEvent?: (ev: ProviderEvent) => void) {
    this.decide = decide;
    this.onEvent = onEvent;
  }

  emit(event: ProviderEvent): void {
    if (this.resolved) this.violations.push(`"${event.type}" event emitted after run() resolved`);
    this.events.push(event);
    this.onEvent?.(event);
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.resolved) this.violations.push("approval requested after run() resolved");
    this.approvals.push(request);
    if (signal.aborted) return { allow: false, reason: "The run was stopped." };
    return this.decide(request);
  }

  ofType<T extends ProviderEvent["type"]>(type: T): Extract<ProviderEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<ProviderEvent, { type: T }> => e.type === type);
  }
}

/**
 * Checks the order rules for text blocks and tool calls. Returns one message per violation.
 * An interrupted run may leave blocks and tools open (the gateway closes them), so those checks are skipped.
 */
export function sequenceViolations(events: ProviderEvent[], interrupted = false): string[] {
  const out: string[] = [];
  const streamed = new Set<string>();
  const finalized = new Set<string>();
  const openTools = new Set<string>();
  const closedTools = new Set<string>();

  for (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        if (finalized.has(ev.blockId)) out.push(`text_delta for block ${ev.blockId} after its final text`);
        streamed.add(ev.blockId);
        break;
      case "text":
        finalized.add(ev.blockId);
        break;
      case "tool_start":
        if (openTools.has(ev.toolUseId) || closedTools.has(ev.toolUseId)) {
          out.push(`tool_start for ${ev.toolUseId} more than once`);
        }
        openTools.add(ev.toolUseId);
        break;
      case "tool_end":
        if (!openTools.has(ev.toolUseId)) out.push(`tool_end for ${ev.toolUseId} without an open tool_start`);
        openTools.delete(ev.toolUseId);
        closedTools.add(ev.toolUseId);
        break;
      case "session":
        if (!ev.sessionId) out.push("session event with an empty sessionId");
        break;
    }
  }
  if (interrupted) return out;
  for (const id of streamed) if (!finalized.has(id)) out.push(`streamed block ${id} never got its final text`);
  for (const id of openTools) out.push(`tool_start for ${id} never got a tool_end`);
  return out;
}

interface RunOptions {
  decide?: (req: ApprovalRequest) => ApprovalDecision;
  /** Abort the run as soon as the first text_delta arrives. */
  interrupt?: boolean;
  sessionId?: string;
}

interface RunResult {
  outcome: RunOutcome | undefined;
  rejected: unknown;
  rec: Recorder;
  /** Milliseconds from abort to run() resolving, when the run was interrupted. */
  stopMs?: number;
}

const allowAll = (): ApprovalDecision => ({ allow: true });

export async function runScenario(
  harness: ContractHarness,
  scenario: ContractScenario,
  opts: RunOptions = {},
): Promise<RunResult> {
  const provider = harness.create(scenario);
  const controller = new AbortController();
  let abortedAt: number | undefined;
  const rec = new Recorder(opts.decide ?? allowAll, (ev) => {
    if (opts.interrupt && ev.type === "text_delta" && !controller.signal.aborted) {
      abortedAt = Date.now();
      controller.abort();
    }
  });
  const req: RunRequest = {
    botId: "contract-bot",
    botName: "Contract",
    prompt: harness.prompt?.(scenario) ?? "Hello there",
    sessionId: opts.sessionId,
    workspaceDir: tmpdir(),
    instructions: "You are a test bot.",
    signal: controller.signal,
  };

  let outcome: RunOutcome | undefined;
  let rejected: unknown;
  try {
    outcome = await provider.run(req, rec);
  } catch (err) {
    rejected = err;
  }
  const stopMs = abortedAt === undefined ? undefined : Date.now() - abortedAt;
  rec.resolved = true;
  // Give stray timers or unawaited work a chance to emit, so late events are caught.
  await new Promise((r) => setTimeout(r, 50));
  return { outcome, rejected, rec, stopMs };
}

function assertClean(r: RunResult): RunOutcome {
  assert.equal(r.rejected, undefined, `run() must resolve, not reject: ${String(r.rejected)}`);
  assert.ok(r.outcome, "run() resolved without an outcome");
  const interrupted = r.outcome.status === "interrupted";
  assert.deepEqual([...r.rec.violations, ...sequenceViolations(r.rec.events, interrupted)], []);
  return r.outcome;
}

function assertSession(r: RunResult, outcome: RunOutcome): void {
  const sessions = r.rec.ofType("session");
  assert.ok(sessions.length > 0, "a session event is emitted");
  assert.equal(outcome.sessionId, sessions.at(-1)?.sessionId, "outcome.sessionId matches the session event");
}

/** Registers the contract tests for one provider. */
export function describeProviderContract(name: string, harness: ContractHarness): void {
  describe(`provider contract: ${name}`, () => {
    test("a reply streams text, ends every block with its final text, and finishes", async () => {
      const r = await runScenario(harness, "reply");
      const outcome = assertClean(r);
      assert.equal(outcome.status, "finished");
      assertSession(r, outcome);
      const text = r.rec.ofType("text");
      assert.ok(text.length > 0, "at least one final text event");
      assert.ok(
        text.every((t) => t.text.trim()),
        "final text is not empty",
      );
    });

    test("an approved tool call runs and the run finishes", async () => {
      const r = await runScenario(harness, "tool", { decide: () => ({ allow: true }) });
      const outcome = assertClean(r);
      assert.equal(outcome.status, "finished");
      assert.equal(r.rec.approvals.length, 1, "one approval requested");
      assert.ok(r.rec.approvals[0]?.tool, "the approval names the tool");
      const ends = r.rec.ofType("tool_end");
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.ok, true);
    });

    test("a denied tool call is reported as not ok, and the run still finishes", async () => {
      const r = await runScenario(harness, "tool", { decide: () => ({ allow: false, reason: "Not now" }) });
      const outcome = assertClean(r);
      assert.equal(outcome.status, "finished");
      const ends = r.rec.ofType("tool_end");
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.ok, false);
    });

    test(`an aborted run ends as interrupted within ${INTERRUPT_LIMIT_MS} ms`, async () => {
      const r = await runScenario(harness, "slow", { interrupt: true });
      const outcome = assertClean(r);
      assert.equal(outcome.status, "interrupted");
      assert.ok(r.stopMs !== undefined, "the run was aborted mid-stream");
      assert.ok(r.stopMs <= INTERRUPT_LIMIT_MS, `stopped in ${r.stopMs} ms`);
    });

    test("a backend failure ends as failed with an error message, without throwing", async () => {
      const r = await runScenario(harness, "fail");
      const outcome = assertClean(r);
      assert.equal(outcome.status, "failed");
      assert.ok(outcome.error?.trim(), "the failure has an error message");
    });

    test("a session id in the request is resumed", async () => {
      const r = await runScenario(harness, "reply", { sessionId: "resume-me" });
      const outcome = assertClean(r);
      assert.equal(outcome.status, "finished");
      assert.equal(r.rec.ofType("session").at(-1)?.sessionId, "resume-me");
      assert.equal(outcome.sessionId, "resume-me");
    });
  });
}
