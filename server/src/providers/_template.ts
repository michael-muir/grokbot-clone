// Template for a new provider. Copy to `<name>.ts`, rename the class, and fill in the TODOs.
// Not registered anywhere. Steps are in server/README.md, "Adding a provider".
//
// The rules a provider must follow (checked by test/contract/provider-contract.ts):
//   - run() always resolves with a RunOutcome. Catch backend errors and return { status: "failed", error }.
//   - Emit a `session` event with an id the backend can resume, and return the same id in the outcome.
//   - Stream text as `text_delta` events, then end each block with a `text` event (same blockId, full text).
//   - Every `tool_start` gets exactly one `tool_end` with the same toolUseId.
//   - Ask before any tool that writes, runs commands or reaches the network: await cb.requestApproval().
//     A denial is not a failure: report the tool as not ok and let the model carry on.
//   - When req.signal aborts, stop within 2 seconds and return { status: "interrupted" }.
//   - Never emit after run() returns.
import type { AgentProvider, ProviderId, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";

export class TemplateProvider implements AgentProvider {
  // TODO: add your id to the ProviderId union in ../types.ts and use it here as a literal.
  readonly id: ProviderId;

  constructor(id: ProviderId) {
    this.id = id;
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    // TODO: resume req.sessionId if the backend supports it, otherwise start a new session.
    const sessionId = req.sessionId ?? `template-${req.botId}-${Date.now()}`;
    cb.emit({ type: "session", sessionId });

    try {
      // TODO: start the backend with req.prompt, req.model, req.instructions and cwd = req.workspaceDir,
      // passing req.signal so it stops when the user interrupts. Then map its events:
      //
      //   text chunk  -> cb.emit({ type: "text_delta", blockId, text: chunk })
      //   text done   -> cb.emit({ type: "text", blockId, text: fullText })
      //   tool call   -> cb.emit({ type: "tool_start", toolUseId, tool, summary: "Running npm test" })
      //                  const decision = await cb.requestApproval({ tool, summary, input }, req.signal);
      //                  run it only if decision.allow, then
      //                  cb.emit({ type: "tool_end", toolUseId, ok })
      //   finished    -> return { status: "finished", sessionId, costUsd }
      if (req.signal.aborted) return { status: "interrupted", sessionId };
      return { status: "failed", sessionId, error: "The template provider does nothing yet." };
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId };
      return { status: "failed", sessionId, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
