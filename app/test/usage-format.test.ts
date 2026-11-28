// The Usage page's formatting: tokens, cost, bar shares and day labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { barShares, dayLabel, formatCost, formatTokens } from "../src/renderer/src/settings/usage-format.ts";

test("usage format: tokens read short, cost to the cent", () => {
  assert.deepEqual([0, 950, 1_000, 12_345, 123_456, 4_500_000].map(formatTokens), [
    "0",
    "950",
    "1K",
    "12.3K",
    "123K",
    "4.5M",
  ]);
  assert.deepEqual([0, 0.004, 0.42, 12.5].map(formatCost), ["$0.00", "<$0.01", "$0.42", "$12.50"]);
});

test("usage format: each day's bar is its share of the busiest day; nothing gives flat zeros", () => {
  const day = (inputTokens: number, outputTokens = 0) => ({ inputTokens, outputTokens });
  assert.deepEqual(barShares([day(0), day(50, 50), day(25), day(200)]), [0, 50, 13, 100]);
  assert.deepEqual(barShares([day(0), day(0)]), [0, 0]);
  assert.equal(dayLabel("2026-11-27", "en-US"), "Nov 27");
});
