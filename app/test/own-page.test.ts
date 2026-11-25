// Own-page check: only the app's page may use the IPC API; look-alike hosts and other files may not.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ownPageCheck } from "../src/main/own-page.ts";

const file = join(process.cwd(), "out", "renderer", "index.html");

test("dev: the dev server's exact origin, nothing that merely starts with it", () => {
  const own = ownPageCheck("http://localhost:5173", file);
  assert.equal(own("http://localhost:5173/"), true);
  assert.equal(own("http://localhost:5173/settings#x"), true);
  assert.equal(own("http://localhost:5173.evil.example/"), false);
  assert.equal(own("http://localhost:51730/"), false);
  assert.equal(own("https://localhost:5173/"), false);
  assert.equal(own("http://user@localhost:5173.evil.example/"), false);
  assert.equal(own("not a url"), false);
});

test("built: the bundled index.html, with or without a hash, and no other file", () => {
  const own = ownPageCheck(undefined, file);
  const href = pathToFileURL(file).href;
  assert.equal(own(href), true);
  assert.equal(own(`${href}#/bots/nova`), true);
  assert.equal(own(pathToFileURL(join(process.cwd(), "evil.html")).href), false);
  assert.equal(own("http://localhost:5173/"), false);
});
