import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeSegment } from "../src/weblate-client.js";
import { getBooleanInput } from "../src/action-io.js";

describe("Weblate client helpers", () => {
  it("double-encodes category separators in component slugs", () => {
    assert.equal(encodeSegment("docs/usage"), "docs%252Fusage");
  });

  it("accepts GitHub input env vars with underscores", () => {
    assert.equal(getBooleanInput("dry-run", {}, { INPUT_DRY_RUN: "true" }), true);
  });

  it("rejects invalid boolean input values", () => {
    assert.throws(() => getBooleanInput("dry-run", {}, { INPUT_DRY_RUN: "yes" }), /must be true or false/);
  });
});
