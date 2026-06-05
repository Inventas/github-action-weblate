import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeManifest } from "../src/manifest.js";

const baseManifest = {
  version: 1,
  projects: [
    {
      slug: "mobile",
      name: "Mobile",
      web: "https://github.com/example/mobile"
    }
  ],
  components: [
    {
      project: "mobile",
      slug: "android",
      name: "Android",
      repo: "https://github.com/example/mobile.git",
      file_format: "aresource",
      filemask: "app/src/main/res/values-*/strings.xml",
      template: "app/src/main/res/values/strings.xml",
      translations: [
        {
          language: "de",
          path: "app/src/main/res/values-de/strings.xml"
        }
      ]
    }
  ]
};

describe("manifest normalization", () => {
  it("normalizes defaults and translation upload settings", () => {
    const manifest = normalizeManifest(baseManifest, { workspace: process.cwd() });

    assert.equal(manifest.version, 1);
    assert.equal(manifest.components[0].branch, "main");
    assert.equal(manifest.components[0].vcs, "git");
    assert.equal(manifest.components[0].translations[0].method, "translate");
    assert.equal(manifest.components[0].translations[0].conflicts, "ignore");
  });

  it("rejects unsupported manifest versions", () => {
    assert.throws(
      () => normalizeManifest({ ...baseManifest, version: 2 }),
      /Unsupported manifest version/
    );
  });

  it("defaults omitted manifest version to version 1", () => {
    const manifest = structuredClone(baseManifest);
    delete manifest.version;

    assert.equal(normalizeManifest(manifest).version, 1);
  });

  it("rejects file masks without exactly one wildcard", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0].filemask = "app/src/main/res/values/strings.xml";

    assert.throws(() => normalizeManifest(manifest), /exactly one \*/);
  });

  it("rejects duplicate component language mappings", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0].translations.push({
      language: "de",
      path: "app/src/main/res/values-de/other.xml"
    });

    assert.throws(() => normalizeManifest(manifest), /Duplicate translation language/);
  });

  it("rejects workspace traversal paths", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0].translations[0].path = "../outside.xml";

    assert.throws(() => normalizeManifest(manifest), /escapes the workspace/);
  });

  it("rejects workspace traversal file masks", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0].filemask = "../values-*/strings.xml";

    assert.throws(() => normalizeManifest(manifest), /escapes the workspace/);
  });

  it("supports single-file xcstrings catalogs", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0] = {
      project: "mobile",
      slug: "ios-catalog",
      name: "iOS String Catalog",
      repo: "https://github.com/example/mobile.git",
      file_format: "xcstrings",
      filemask: "ios/App/Localizable.xcstrings",
      translations: [
        { language: "de" },
        { language: "nl", path: "ios/App/Localizable.xcstrings" }
      ]
    };

    const normalized = normalizeManifest(manifest);

    assert.equal(normalized.components[0].translations[0].path, "ios/App/Localizable.xcstrings");
    assert.equal(normalized.components[0].translations[1].path, "ios/App/Localizable.xcstrings");
  });

  it("rejects xcstrings file masks with language wildcards", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0] = {
      project: "mobile",
      slug: "ios-catalog",
      name: "iOS String Catalog",
      repo: "https://github.com/example/mobile.git",
      file_format: "xcstrings",
      filemask: "ios/App/*.xcstrings",
      translations: [{ language: "de" }]
    };

    assert.throws(() => normalizeManifest(manifest), /must not contain a \*/);
  });

  it("rejects xcstrings translation paths that do not match the catalog", () => {
    const manifest = structuredClone(baseManifest);
    manifest.components[0] = {
      project: "mobile",
      slug: "ios-catalog",
      name: "iOS String Catalog",
      repo: "https://github.com/example/mobile.git",
      file_format: "xcstrings",
      filemask: "ios/App/Localizable.xcstrings",
      translations: [{ language: "de", path: "ios/App/Other.xcstrings" }]
    };

    assert.throws(() => normalizeManifest(manifest), /must match the xcstrings catalog filemask/);
  });
});
