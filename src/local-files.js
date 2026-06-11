import { isLocalFilesComponent } from "./component-mode.js";

export function getLocalFilesBootstrap(component) {
  if (!isLocalFilesComponent(component)) {
    return null;
  }

  const paths = [...new Set([
    component.docfile,
    ...component.translations.map((translation) => translation.path).filter(Boolean)
  ])];

  if (paths.length === 1) {
    return { kind: "docfile", path: paths[0] };
  }

  return { kind: "zipfile", paths };
}
