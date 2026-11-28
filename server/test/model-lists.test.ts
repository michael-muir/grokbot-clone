// Model lists (#96): recent lists for the picker, shared loads, no kept failures, fresh on request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelLists } from "../src/model-lists.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import type { AgentProvider, ProviderId, RunOutcome } from "../src/types.ts";

/** A provider whose model list counts its loads and can be told to fail or wait. */
class Lister implements AgentProvider {
  readonly id: ProviderId;
  loads = 0;
  fail = false;
  configured = true;
  gate: Promise<void> = Promise.resolve();

  constructor(id: ProviderId) {
    this.id = id;
  }
  info() {
    return { label: this.id, local: false, configured: this.configured };
  }
  async run(): Promise<RunOutcome> {
    return { status: "finished" };
  }
  async listModels(_signal: AbortSignal, baseUrl?: string): Promise<string[]> {
    this.loads++;
    await this.gate;
    if (this.fail) throw new Error("not signed in");
    return [`model-${this.loads}${baseUrl ? `@${baseUrl}` : ""}`];
  }
}

function setup() {
  const cursor = new Lister("cursor");
  const codex = new Lister("codex");
  let clock = 0;
  const lists = new ModelLists(
    new Map<ProviderId, AgentProvider>([
      ["cursor", cursor],
      ["codex", codex],
    ]) as ProviderRegistry,
    1000,
    () => clock,
  );
  return { cursor, codex, lists, tick: (ms: number) => (clock += ms) };
}

test("model lists: a recent list serves the picker; a test or Refresh asks again", async () => {
  const { cursor, lists, tick } = setup();
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-1"]);
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-1"], "from the cache");
  assert.equal(cursor.loads, 1);
  assert.deepEqual(await lists.get("cursor"), ["model-2"], "without cached: asked again");
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-2"], "and that fresh list is kept");
  tick(1001);
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-3"], "too old: asked again");
  assert.deepEqual(await lists.get("cursor", { cached: true, baseUrl: "http://x" }), ["model-4@http://x"]);
});

test("model lists: asks during a load share it, and a failure isn't kept", async () => {
  const { cursor, lists } = setup();
  let open: () => void = () => {};
  cursor.gate = new Promise((r) => {
    open = r;
  });
  const both = Promise.all([lists.get("cursor", { cached: true }), lists.get("cursor")]);
  open();
  assert.deepEqual(await both, [["model-1"], ["model-1"]]);
  assert.equal(cursor.loads, 1, "one load for both");

  cursor.fail = true;
  await assert.rejects(lists.get("cursor"), /not signed in/);
  cursor.fail = false;
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-1"], "the last good list stays");
  lists.forget("cursor");
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-3"], "forgotten: asked again");
});

test("model lists: warming loads set-up providers in the background and only logs failures", async () => {
  const { cursor, codex, lists } = setup();
  codex.configured = false;
  cursor.fail = true;
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => warned.push(line);
  try {
    lists.warm(["cursor", "codex"]);
    await new Promise((r) => setImmediate(r));
    assert.equal(cursor.loads, 1);
    assert.equal(codex.loads, 0, "not set up: left alone");
    assert.match(warned.join("\n"), /cursor models/);
  } finally {
    console.warn = warn;
  }
});

test("model lists: a load from before a key change never comes back as the current list", async () => {
  const { cursor, lists } = setup();
  let open: () => void = () => {};
  cursor.gate = new Promise((r) => {
    open = r;
  });
  const old = lists.get("cursor", { cached: true });
  lists.forget("cursor"); // the key changed while the old list was loading
  cursor.gate = Promise.resolve();
  const fresh = lists.get("cursor", { cached: true });
  assert.notEqual(fresh, old, "a new ask doesn't join the old load");
  open();
  await old;
  assert.deepEqual(await fresh, ["model-2"]);
  assert.deepEqual(await lists.get("cursor", { cached: true }), ["model-2"], "the old list wasn't stored");
});
