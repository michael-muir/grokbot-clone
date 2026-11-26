// IPC contract tests: main refuses unknown calls and arguments of the wrong shape or number.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall, checkStreamOpen } from "../src/shared/ipc.ts";

test("known calls with the right arguments pass, paired with their name", () => {
  assert.deepEqual(checkCall("listBots", []), { name: "listBots", args: [] });
  assert.deepEqual(checkCall("sendMessage", ["nova", "hi"]), { name: "sendMessage", args: ["nova", "hi"] });
  assert.deepEqual(checkCall("updateBot", ["nova", { provider: "ollama", model: "qwen" }]), {
    name: "updateBot",
    args: ["nova", { provider: "ollama", model: "qwen" }],
  });
  assert.equal(typeof checkCall("answerApproval", ["nova", "e1", { allow: false, reason: "no" }]), "object");
  assert.equal(typeof checkCall("testProvider", ["gemini"]), "object");
  assert.equal(typeof checkCall("testProvider", ["ollama", "http://box:11434"]), "object");
  assert.equal(typeof checkCall("transcript", ["nova", -1]), "object");
});

test("unknown names, including inherited object keys, are refused", () => {
  assert.match(String(checkCall("deleteEverything", [])), /Unknown call/);
  assert.match(String(checkCall("toString", [])), /Unknown call/);
  assert.match(String(checkCall("__proto__", [])), /Unknown call/);
  assert.match(String(checkCall(42, [])), /Unknown call/);
});

test("wrong argument types or counts are refused", () => {
  const refused = (name: string, args: unknown) => assert.match(String(checkCall(name, args)), /Bad arguments/);
  refused("listBots", ["extra"]);
  refused("listBots", "not an array");
  refused("sendMessage", ["nova"]);
  refused("sendMessage", ["nova", "   "]);
  refused("sendMessage", ["", "hi"]);
  refused("sendMessage", ["nova", 5]);
  refused("updateBot", ["nova", { provider: "gpt" }]);
  refused("updateBot", ["nova", { sessionId: "steal" }]);
  refused("updateBot", ["nova", null]);
  refused("answerApproval", ["nova", "e1", { allow: "yes" }]);
  refused("answerApproval", ["nova", "e1", { allow: false }]);
  refused("transcript", ["nova", 1.5]);
  refused("transcript", ["nova", -2]);
  refused("setKey", ["nobody", "k"]);
  refused("setKey", ["openai", ""]);
  refused("listModels", ["openai", "extra"]);
});

test("stream open messages are checked", () => {
  assert.deepEqual(checkStreamOpen({ id: "s1", topic: "transcript", botId: "nova", since: 4 }), {
    id: "s1",
    topic: "transcript",
    botId: "nova",
    since: 4,
  });
  assert.equal(checkStreamOpen({ id: "s1", topic: "transcript", botId: "nova", since: "4" }), undefined);
  assert.equal(checkStreamOpen({ id: "", topic: "transcript", botId: "nova", since: -1 }), undefined);
  assert.equal(checkStreamOpen({ id: "s1", botId: "nova", since: 4 }), undefined, "the topic is required");
  // Activity takes no other fields; anything extra is dropped.
  assert.deepEqual(checkStreamOpen({ id: "s2", topic: "activity", botId: "x" }), { id: "s2", topic: "activity" });
  assert.equal(checkStreamOpen({ id: "s2", topic: "everything" }), undefined);
  assert.equal(checkStreamOpen(null), undefined);
});
