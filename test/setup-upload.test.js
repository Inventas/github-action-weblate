import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSetupUploadAction } from "../src/setup-upload.js";

describe("setup-upload action", () => {
  it("performs API lookups but no mutations in dry-run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "weblate-setup-"));
    await writeFile(path.join(workspace, "strings.xml"), "<resources><string name=\"hello\">Hello</string></resources>");
    await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({
      version: 1,
      projects: [{ slug: "mobile", name: "Mobile", web: "https://github.com/example/mobile" }],
      components: [{
        project: "mobile",
        slug: "android",
        name: "Android",
        repo: "https://github.com/example/mobile.git",
        file_format: "aresource",
        filemask: "values-*/strings.xml",
        translations: [{ language: "en", path: "strings.xml" }]
      }]
    }));

    const calls = [];
    const outputFile = path.join(workspace, "outputs.txt");
    const client = {
      getProject: async (project) => {
        calls.push(["getProject", project]);
        return null;
      },
      getComponent: async (project, component) => {
        calls.push(["getComponent", project, component]);
        return null;
      },
      getTranslation: async (project, component, language) => {
        calls.push(["getTranslation", project, component, language]);
        return null;
      },
      createProject: async () => {
        throw new Error("dry-run must not create projects");
      },
      createComponent: async () => {
        throw new Error("dry-run must not create components");
      },
      createTranslation: async () => {
        throw new Error("dry-run must not create translations");
      },
      uploadTranslationFile: async () => {
        throw new Error("dry-run must not upload files");
      }
    };

    await runSetupUploadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json",
        "INPUT_DRY_RUN": "true",
        GITHUB_OUTPUT: outputFile
      }
    });

    assert.deepEqual(calls, [
      ["getProject", "mobile"],
      ["getComponent", "mobile", "android"],
      ["getTranslation", "mobile", "android", "en"]
    ]);
    assert.match(await readFile(outputFile, "utf8"), /files-uploaded<<__WEBLATE_OUTPUT__\n0/);
  });

  it("waits for component task URLs before verifying creation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "weblate-setup-task-"));
    await writeFile(path.join(workspace, "strings.xml"), "<resources><string name=\"hello\">Hello</string></resources>");
    await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({
      version: 1,
      projects: [{ slug: "mobile", name: "Mobile", web: "https://github.com/example/mobile" }],
      components: [{
        project: "mobile",
        slug: "android",
        name: "Android",
        repo: "https://github.com/example/mobile.git",
        file_format: "aresource",
        filemask: "values-*/strings.xml",
        translations: [{ language: "en", path: "strings.xml" }]
      }]
    }));

    const calls = [];
    const client = {
      getProject: async () => ({ slug: "mobile" }),
      createProject: async () => {
        throw new Error("project should exist");
      },
      getComponent: async () => {
        calls.push("getComponent");
        return calls.filter((call) => call === "waitTask").length > 0 ? { slug: "android" } : null;
      },
      createComponent: async () => ({ task_url: "https://weblate.example.com/api/tasks/1/" }),
      waitTask: async () => {
        calls.push("waitTask");
      },
      getTranslation: async () => ({ language: { code: "en" } }),
      createTranslation: async () => {
        throw new Error("translation should exist");
      },
      uploadTranslationFile: async () => {
        calls.push("upload");
      }
    };

    await runSetupUploadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json"
      }
    });

    assert.deepEqual(calls, ["getComponent", "waitTask", "getComponent", "upload"]);
  });

  it("creates all xcstrings languages but uploads the shared catalog once", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "weblate-setup-xcstrings-"));
    await writeFile(path.join(workspace, "Localizable.xcstrings"), JSON.stringify({
      sourceLanguage: "en",
      strings: {}
    }));
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
    const createdTranslations = new Set();
    const client = {
      getProject: async () => ({ slug: "mobile" }),
      createProject: async () => {
        throw new Error("project should exist");
      },
      getComponent: async () => ({ slug: "ios-catalog" }),
      createComponent: async () => {
        throw new Error("component should exist");
      },
      getTranslation: async (_project, _component, language) => {
        calls.push(["getTranslation", language]);
        return createdTranslations.has(language) ? { language: { code: language } } : null;
      },
      createTranslation: async (_project, _component, language) => {
        calls.push(["createTranslation", language]);
        createdTranslations.add(language);
        return {};
      },
      uploadTranslationFile: async (_project, _component, translation, absolutePath) => {
        calls.push(["upload", translation.language, path.basename(absolutePath)]);
        return {};
      }
    };

    await runSetupUploadAction({
      workspace,
      client,
      env: {
        "INPUT_WEBLATE_URL": "https://weblate.example.com",
        "INPUT_API_TOKEN": "token",
        "INPUT_MANIFEST": "manifest.json"
      }
    });

    assert.deepEqual(calls, [
      ["getTranslation", "de"],
      ["createTranslation", "de"],
      ["getTranslation", "de"],
      ["getTranslation", "nl"],
      ["createTranslation", "nl"],
      ["getTranslation", "nl"],
      ["upload", "de", "Localizable.xcstrings"]
    ]);
  });
});
