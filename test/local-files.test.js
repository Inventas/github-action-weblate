import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLocalFilesBootstrap } from "../src/local-files.js";

describe("local-files bootstrap", () => {
  it("uses zipfile bootstrap even for single-file components", () => {
    const bootstrap = getLocalFilesBootstrap({
      mode: "local-files",
      docfile: "Shared/Ressources/Localizable.xcstrings",
      translations: [{ language: "de", path: "Shared/Ressources/Localizable.xcstrings" }]
    });

    assert.deepEqual(bootstrap, {
      kind: "zipfile",
      paths: ["Shared/Ressources/Localizable.xcstrings"]
    });
  });

  it("uses zipfile bootstrap when multiple files are involved", () => {
    const bootstrap = getLocalFilesBootstrap({
      mode: "local-files",
      docfile: "Shared/en.lproj/OneSecIntents.strings",
      translations: [
        { language: "de", path: "Shared/de.lproj/OneSecIntents.strings" },
        { language: "fr", path: "Shared/fr.lproj/OneSecIntents.strings" }
      ]
    });

    assert.deepEqual(bootstrap, {
      kind: "zipfile",
      paths: [
        "Shared/en.lproj/OneSecIntents.strings",
        "Shared/de.lproj/OneSecIntents.strings",
        "Shared/fr.lproj/OneSecIntents.strings"
      ]
    });
  });
});
