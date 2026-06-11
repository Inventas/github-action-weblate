import { isLocalFilesComponent } from "./component-mode.js";

export function getLocalFilesBootstrap(component) {
  if (!isLocalFilesComponent(component)) {
    return null;
  }

  return {
    kind: "zipfile",
    paths: [...new Set([
    component.docfile,
    ...component.translations.map((translation) => translation.path).filter(Boolean)
    ])]
  };
}
