import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWeblateClient, encodeSegment } from "../src/weblate-client.js";
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

  it("retries transient Weblate repository locks", async () => {
    const requests = [];
    const retries = [];
    const sleeps = [];
    const client = createWeblateClient({
      baseUrl: "https://weblate.example.com",
      apiToken: "token",
      repositoryLockRetryTimeoutMs: 1000,
      repositoryLockRetryPollIntervalMs: 25,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      onRepositoryLockRetry: (event) => {
        retries.push(event);
      },
      fetchImpl: async (url, options) => {
        requests.push([url, options.method]);
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            type: "client_error",
            errors: [{ code: "repository-locked", detail: "Could not obtain the repository lock." }]
          }), { status: 423 });
        }

        return new Response(JSON.stringify({ language: { code: "de" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const result = await client.createTranslation("mobile", "ios", "de");

    assert.deepEqual(result, { language: { code: "de" } });
    assert.deepEqual(requests, [
      ["https://weblate.example.com/api/components/mobile/ios/translations/", "POST"],
      ["https://weblate.example.com/api/components/mobile/ios/translations/", "POST"]
    ]);
    assert.deepEqual(sleeps, [25]);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].status, 423);
  });
});
