export const COMPONENT_MODE_REPOSITORY = "repository";
export const COMPONENT_MODE_LOCAL_FILES = "local-files";
export const LOCAL_FILES_VCS = "local";

const COMPONENT_MODES = new Set([COMPONENT_MODE_REPOSITORY, COMPONENT_MODE_LOCAL_FILES]);

export function normalizeComponentMode(mode, label) {
  if (mode === undefined || mode === null || mode === "") {
    return undefined;
  }
  if (typeof mode !== "string") {
    throw new Error(`Expected string value, got ${typeof mode}.`);
  }
  if (!COMPONENT_MODES.has(mode)) {
    throw new Error(`${label} must be one of ${[...COMPONENT_MODES].join(", ")}. Got: ${mode}`);
  }
  return mode;
}

export function isLocalFilesComponent(component) {
  return component.mode === COMPONENT_MODE_LOCAL_FILES || component.vcs === LOCAL_FILES_VCS;
}

export function isRepositoryBackedComponent(component) {
  return !isLocalFilesComponent(component);
}
