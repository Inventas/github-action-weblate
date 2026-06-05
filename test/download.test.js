import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDownloadAction } from "../src/download.js";

describe("download action", () => {
  it("downloads files and reports byte-level changes without git", async () => {
    const workspace = await makeDownloadWorkspace();
    const outputFile = path.join(workspace, "outputs.txt");
    const client = fakeDownloadClient(Buffer.from("Hallo"));

    await runDownloadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json",
        "INPUT_REPOSITORY_OPERATION": "none",
        GITHUB_OUTPUT: outputFile
      }
    });

    assert.equal(await readFile(path.join(workspace, "locale/de.json"), "utf8"), "Hallo");
    const outputs = await readFile(outputFile, "utf8");
    assert.match(outputs, /changed<<__WEBLATE_OUTPUT__\ntrue/);
    assert.match(outputs, /files-downloaded<<__WEBLATE_OUTPUT__\n1/);
  });

  it("reports no changes when downloaded content is identical", async () => {
    const workspace = await makeDownloadWorkspace();
    await mkdir(path.join(workspace, "locale"), { recursive: true });
    await writeFile(path.join(workspace, "locale/de.json"), "Hallo");
    const outputFile = path.join(workspace, "outputs.txt");
    const client = fakeDownloadClient(Buffer.from("Hallo"));

    await runDownloadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json",
        "INPUT_REPOSITORY_OPERATION": "none",
        GITHUB_OUTPUT: outputFile
      }
    });

    assert.match(await readFile(outputFile, "utf8"), /changed<<__WEBLATE_OUTPUT__\nfalse/);
  });

  it("aborts when Weblate reports a merge failure", async () => {
    const workspace = await makeDownloadWorkspace();
    const client = fakeDownloadClient(Buffer.from("Hallo"), {
      status: { needs_merge: true, merge_failure: "conflict" }
    });

    await assert.rejects(
      () => runDownloadAction({
        workspace,
        client,
        env: {
          "INPUT_WEBLATE_URL": "https://weblate.example.com",
          "INPUT_API_TOKEN": "token",
          "INPUT_MANIFEST": "manifest.json",
          "INPUT_REPOSITORY_OPERATION": "none"
        }
      }),
      /not ready/
    );
  });

  it("unlocks components after download failures when the action took the lock", async () => {
    const workspace = await makeDownloadWorkspace();
    const calls = [];
    const client = fakeDownloadClient(Buffer.from("Hallo"), {
      downloadError: new Error("download failed"),
      onCall: (call) => calls.push(call)
    });

    await assert.rejects(
      () => runDownloadAction({
        workspace,
        client,
        env: {
          "INPUT_WEBLATE_URL": "https://weblate.example.com",
          "INPUT_API_TOKEN": "token",
          "INPUT_MANIFEST": "manifest.json",
          "INPUT_REPOSITORY_OPERATION": "none",
          "INPUT_LOCK": "true"
        }
      }),
      /download failed/
    );

    assert.deepEqual(calls.filter((call) => call[0] === "setLock"), [
      ["setLock", true],
      ["setLock", false]
    ]);
  });

  it("downloads shared xcstrings catalogs once for multiple languages", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "weblate-download-xcstrings-"));
    await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({
      version: 1,
      projects: [{ slug: "mobile", name: "Mobile", web: "https://github.com/example/mobile" }],
      components: [{
        project: "mobile",
        slug: "ios-catalog",
        name: "iOS String Catalog",
        repo: "https://github.com/example/mobile.git",
        file_format: "xcstrings",
        filemask: "Localizable.xcstrings",
        translations: [{ language: "de" }, { language: "nl" }]
      }]
    }));

    const calls = [];
    const client = fakeDownloadClient(Buffer.from("{\"sourceLanguage\":\"en\",\"strings\":{}}"), {
      onCall: (call) => calls.push(call)
    });

    await runDownloadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json",
        "INPUT_REPOSITORY_OPERATION": "none"
      }
    });

    assert.equal(await readFile(path.join(workspace, "Localizable.xcstrings"), "utf8"), "{\"sourceLanguage\":\"en\",\"strings\":{}}");
    assert.deepEqual(calls.filter((call) => call[0] === "download"), [["download", "de"]]);
  });
});

async function makeDownloadWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "weblate-download-"));
  await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({
    version: 1,
    projects: [{ slug: "mobile", name: "Mobile", web: "https://github.com/example/mobile" }],
    components: [{
      project: "mobile",
      slug: "web",
      name: "Web",
      repo: "https://github.com/example/mobile.git",
      file_format: "json",
      filemask: "locale/*.json",
      translations: [{ language: "de", path: "locale/de.json" }]
    }]
  }));
  return workspace;
}

function fakeDownloadClient(content, options = {}) {
  const onCall = options.onCall ?? (() => {});

  return {
    getComponentLock: async () => {
      onCall(["getLock"]);
      return { locked: false };
    },
    setComponentLock: async (_project, _component, lock) => {
      onCall(["setLock", lock]);
    },
    runComponentRepositoryOperation: async (_project, _component, operation) => {
      onCall(["operation", operation]);
      return {};
    },
    runProjectRepositoryOperation: async (_project, operation) => {
      onCall(["projectOperation", operation]);
      return {};
    },
    getComponentRepositoryStatus: async () => options.status ?? { needs_merge: false, merge_failure: null },
    getTranslation: async () => ({ filename: "locale/de.json" }),
    downloadTranslationFile: async (_project, _component, language) => {
      onCall(["download", language]);
      if (options.downloadError) {
        throw options.downloadError;
      }
      return content;
    },
    waitTask: async () => {}
  };
}
