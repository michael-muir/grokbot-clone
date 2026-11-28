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
  assert.deepEqual(checkCall("sendMessage", ["nova", "hi", "n-1"]), {
    name: "sendMessage",
    args: ["nova", "hi", "n-1"],
  });
  refused("sendMessage", ["nova", "hi", ""]);
  refused("sendMessage", ["nova", "hi", "x".repeat(101)]);
  assert.deepEqual(checkCall("sendMessage", ["nova", "hi", "n-1", "root-1"]), {
    name: "sendMessage",
    args: ["nova", "hi", "n-1", "root-1"],
  });
  refused("sendMessage", ["nova", "hi", "n-1", ""]);
  refused("sendMessage", ["nova", "hi", "n-1", 7]);
  refused("sendMessage", ["nova", "hi", "n-1", "root-1", "extra"]);
  assert.deepEqual(checkCall("startFresh", ["nova"]), { name: "startFresh", args: ["nova"] });
  refused("startFresh", []);
  refused("startFresh", ["nova", "extra"]);
  assert.deepEqual(checkCall("rollBack", ["nova", "e-1"]), { name: "rollBack", args: ["nova", "e-1"] });
  refused("rollBack", ["nova"]);
  assert.deepEqual(checkCall("react", ["nova", "e-1", "👍", true]), {
    name: "react",
    args: ["nova", "e-1", "👍", true],
  });
  refused("react", ["nova", "e-1", "👍"]);
  refused("react", ["nova", "e-1", "👍", "yes"]);
  refused("react", ["nova", "e-1", "x".repeat(17), true]);
  assert.deepEqual(checkCall("rate", ["nova", "e-1", null]), { name: "rate", args: ["nova", "e-1", null] });
  assert.deepEqual(checkCall("rate", ["nova", "e-1", "down"]), { name: "rate", args: ["nova", "e-1", "down"] });
  refused("rate", ["nova", "e-1", "meh"]);
  refused("rate", ["nova", "e-1"]);
  refused("rollBack", ["nova", ""]);
  assert.deepEqual(checkCall("answerChoice", ["nova", "card-1", "red"]), {
    name: "answerChoice",
    args: ["nova", "card-1", "red"],
  });
  refused("answerChoice", ["nova", "card-1", 3]);
  refused("answerChoice", ["nova", "card-1", "x".repeat(1001)]);
  refused("sendMessage", ["nova", 5]);
  refused("updateBot", ["nova", { provider: "gpt" }]);
  refused("updateBot", ["nova", { sessionId: "steal" }]);
  refused("updateBot", ["nova", null]);
  refused("updateBot", ["nova", { pinned: "yes" }]);
  refused("updateBot", ["nova", { avatar: { shape: "blob", color: "red" } }]);
  refused("updateBot", ["nova", { avatar: { shape: "star", color: "red", extra: 1 } }]);
  refused("updateBot", ["nova", { main: false }]);
  assert.deepEqual(checkCall("updateBot", ["nova", { avatar: { shape: "star", color: "red" }, main: true }]), {
    name: "updateBot",
    args: ["nova", { avatar: { shape: "star", color: "red" }, main: true }],
  });
  assert.deepEqual(checkCall("createBot", [{ name: "Nova", avatar: { shape: "drop", color: "teal" } }]), {
    name: "createBot",
    args: [{ name: "Nova", avatar: { shape: "drop", color: "teal" } }],
  });
  refused("createBot", [{ name: "  " }]);
  refused("createBot", [{ name: "Nova", id: "../x" }]);
  refused("createBot", [{ name: "Nova", avatar: { shape: "circle", color: "chartreuse" } }]);
  refused("createBot", [{ name: "x".repeat(201) }]);
  refused("createBot", [{ name: "Nova" }, "extra"]);
  refused("deleteBot", []);
  refused("deleteBot", ["nova", "extra"]);
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
