# #1 Provider contract test suite and provider template

Issue: #1 · Milestone: Phase 1 · Requirements: PR-1 · Stories: US-6

## Goal

Every provider behaves the same way toward the gateway, enforced by one shared test suite that runs offline. A
template makes adding a provider a one-file change.

## Scope

- In: a reusable contract suite, run against `fake` and `claude`; a way to drive the Claude adapter offline; a
  provider template; docs.
- Out: new providers (#2, #3, #4, #25, #26 each run this suite when they land); changing the `ProviderEvent`
  shapes.

## Design

### Contract suite

`server/test/contract/provider-contract.ts` exports `describeProviderContract(name, harness)`. It registers one
`node:test` suite per provider. The harness tells the suite how to make the provider behave for each scenario,
because a real backend can't be told "now call a tool" directly:

```ts
type ContractScenario = "reply" | "tool" | "slow" | "fail";

interface ContractHarness {
  /** A provider wired so that the given scenario happens on its next run. */
  create(scenario: ContractScenario): AgentProvider;
  /** The prompt to send for the scenario (the fake provider reads commands from the prompt). */
  prompt?(scenario: ContractScenario): string;
}
```

| Scenario | Backend behavior arranged by the harness |
| --- | --- |
| `reply` | Streams a text reply and finishes |
| `tool` | Calls one tool that needs approval, then replies |
| `slow` | Streams slowly enough to be interrupted |
| `fail` | The backend reports an error |

### Rules every provider must follow

Checked by a recorder that wraps `RunCallbacks` and validates the event sequence:

1. `run()` resolves with a `RunOutcome`; it never rejects.
2. A `session` event is emitted, and the outcome's `sessionId` matches it.
3. A reply produces text: at least one `text_delta` or `text`, and in a run that isn't interrupted every streamed
   block ends with a `text` event for the same `blockId`. No `text_delta` for a block after its `text`.
4. Every `tool_start` has at most one later `tool_end` with the same `toolUseId`, and no `tool_end` comes without
   a start. In a run that isn't interrupted, every tool is ended. (On interrupt the gateway closes open blocks and
   tools itself.)
5. Approval allowed → `tool_end` `ok: true`, outcome `finished`.
6. Approval denied → `tool_end` `ok: false`, outcome `finished`, and the denial doesn't fail the run.
7. Abort during a run → outcome `interrupted` within 2 seconds.
8. No events are emitted after `run()` resolves.
9. A backend failure → outcome `failed` with a non-empty `error`.
10. A `sessionId` in the request is resumed: the `session` event carries it (when the backend returns the same
    id).

### Driving Claude offline

`ClaudeProvider` takes an optional query function in its constructor (default: the SDK's `query`). The test
harness passes a scripted function that yields recorded-shape SDK messages (`system/init`, `stream_event`
deltas, `assistant`, `user` tool results, `result`) and calls `options.canUseTool` for the tool scenario. No
network, no API key. Production code is unchanged apart from the constructor parameter.

### Template

`server/src/providers/_template.ts`: a commented skeleton showing where to map backend events to
`ProviderEvent`s, how to ask for approvals, and how to honor the abort signal. Not registered.

## Interfaces

- `new ClaudeProvider(queryFn?: typeof query)`
- `describeProviderContract(name: string, harness: ContractHarness): void` (test-only)

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| `npm test` runs the contract suite offline | `providers.contract.test.ts` runs for `fake` and `claude` with no network or key |
| A new provider passes by implementing one file | Template + README "Adding a provider" steps; the suite takes any `AgentProvider` |

Also: a deliberately broken provider (emits after resolving, unmatched `tool_end`) fails the recorder's checks,
so the rules can't silently pass.

## Risks and open questions

- The scripted Claude messages must stay close to the real SDK shapes. They fill in only the fields the adapter
  reads and are cast to `SDKMessage`, so an SDK upgrade that renames those fields won't show up as a type error.
  Re-check the script against the SDK types when upgrading the SDK.
