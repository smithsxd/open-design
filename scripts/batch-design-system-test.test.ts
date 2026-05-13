import assert from "node:assert/strict";
import test from "node:test";

import { dedupeDesignSystemIds, validateExplicitDesignSystemIds } from "./batch-design-system-test.ts";

test("dedupeDesignSystemIds trims and preserves first-seen order", () => {
  assert.deepEqual(dedupeDesignSystemIds([" default ", "kami", "default", "", "kami "]), ["default", "kami"]);
});

test("validateExplicitDesignSystemIds rejects unknown design system ids", () => {
  assert.throws(
    () => validateExplicitDesignSystemIds(["default", "typo"], ["default", "kami"]),
    /unknown design system id\(s\): typo/,
  );
});

test("validateExplicitDesignSystemIds returns the normalized explicit ids when all exist", () => {
  assert.deepEqual(validateExplicitDesignSystemIds([" default ", "kami", "default"], ["default", "kami"]), ["default", "kami"]);
});
