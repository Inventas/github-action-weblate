import { readFile } from "node:fs/promises";
import {
  COMPONENT_MODE_LOCAL_FILES,
  COMPONENT_MODE_REPOSITORY,
  LOCAL_FILES_VCS,
  isLocalFilesComponent,
  normalizeComponentMode
} from "./component-mode.js";
import { normalizeWorkspacePath } from "./path-utils.js";
import { isXcstringsComponent } from "./xcstrings.js";

const SUPPORTED_MANIFEST_VERSION = 1;
const UPLOAD_METHODS = new Set(["translate", "approve", "suggest", "fuzzy", "replace", "source", "add"]);
const CONFLICT_MODES = new Set(["ignore", "replace-translated", "replace-approved"]);
const FUZZY_MODES = new Set(["", "process", "approve"]);

export async function loadManifest(manifestPath, options = {}) {
  const contents = await readFile(manifestPath, "utf8");
  let raw;

  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${manifestPath}. ${error.message}`);
  }

  return normalizeManifest(raw, options);
}

export function normalizeManifest(raw, options = {}) {
  const workspace = options.workspace ?? process.cwd();

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Manifest must be a JSON object.");
  }

  const version = raw.version ?? SUPPORTED_MANIFEST_VERSION;
  if (version !== SUPPORTED_MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest version ${version}. Supported version: ${SUPPORTED_MANIFEST_VERSION}.`);
  }

  const defaults = normalizeDefaults(raw.defaults ?? {});
  const projects = normalizeProjects(raw.projects ?? []);
  const components = normalizeComponents(raw.components ?? [], defaults, workspace);

  validateUnique(projects.map((project) => project.slug), "project slug");
  validateUnique(components.map((component) => `${component.project}/${component.slug}`), "component slug");
  validateReferencedProjects(projects, components);

  return {
    version,
    defaults,
    projects,
    components
  };
}

function normalizeDefaults(defaults) {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error("Manifest defaults must be an object when provided.");
  }

  return {
    mode: normalizeComponentMode(defaults.mode, "Manifest defaults.mode") ?? COMPONENT_MODE_REPOSITORY,
    repo: optionalString(defaults.repo),
    branch: optionalString(defaults.branch),
    vcs: optionalString(defaults.vcs),
    upload: normalizeUploadDefaults(defaults.upload ?? {})
  };
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) {
    throw new Error("Manifest projects must be an array.");
  }

  return projects.map((project, index) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error(`Project at index ${index} must be an object.`);
    }

    return compactObject({
      slug: requiredString(project.slug, `projects[${index}].slug`),
      name: optionalString(project.name),
      web: optionalString(project.web),
      workspace: optionalString(project.workspace)
    });
  });
}

function normalizeComponents(components, defaults, workspace) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("Manifest components must be a non-empty array.");
  }

  return components.map((component, index) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw new Error(`Component at index ${index} must be an object.`);
    }

    const mode = normalizeComponentMode(component.mode, `components[${index}].mode`) ?? defaults.mode;
    const repo = optionalString(component.repo) ?? defaults.repo;
    const branch = optionalString(component.branch) ?? defaults.branch;
    const vcs = optionalString(component.vcs) ?? defaults.vcs;
    const normalized = compactObject({
      mode,
      project: requiredString(component.project, `components[${index}].project`),
      slug: requiredString(component.slug, `components[${index}].slug`),
      name: optionalString(component.name),
      repo,
      branch,
      vcs,
      file_format: requiredString(component.file_format, `components[${index}].file_format`),
      file_format_params: normalizeObject(component.file_format_params, `components[${index}].file_format_params`),
      filemask: normalizeWorkspacePath(requiredString(component.filemask, `components[${index}].filemask`), workspace),
      template: optionalPath(component.template, workspace),
      new_base: optionalPath(component.new_base, workspace),
      docfile: optionalPath(component.docfile, workspace),
      push: optionalString(component.push),
      push_branch: optionalString(component.push_branch),
      source_language: optionalString(component.source_language),
      new_lang: optionalString(component.new_lang),
      language_code_style: optionalString(component.language_code_style),
      language_aliases: optionalString(component.language_aliases),
      merge_style: optionalString(component.merge_style),
      push_on_commit: optionalBoolean(component.push_on_commit),
      commit_pending_age: optionalNumber(component.commit_pending_age),
      auto_lock_error: optionalBoolean(component.auto_lock_error)
    });

    validateComponentModeConfiguration(normalized, index);
    applyModeDefaults(normalized);
    validateFilemask(normalized, index);
    normalized.translations = normalizeTranslations(component.translations, defaults.upload, workspace, index);
    normalizeXcstringsTranslations(normalized, index);
    validateUnique(normalized.translations.map((translation) => translation.language), `translation language in ${normalized.project}/${normalized.slug}`);

    return normalized;
  });
}

function normalizeTranslations(translations, uploadDefaults, workspace, componentIndex) {
  if (!Array.isArray(translations) || translations.length === 0) {
    throw new Error(`components[${componentIndex}].translations must be a non-empty array.`);
  }

  return translations.map((translation, index) => {
    if (!translation || typeof translation !== "object" || Array.isArray(translation)) {
      throw new Error(`components[${componentIndex}].translations[${index}] must be an object.`);
    }

    const method = optionalString(translation.method) ?? uploadDefaults.method;
    const conflicts = optionalString(translation.conflicts) ?? uploadDefaults.conflicts;
    const fuzzy = optionalString(translation.fuzzy) ?? uploadDefaults.fuzzy;

    if (!UPLOAD_METHODS.has(method)) {
      throw new Error(`Unsupported upload method for components[${componentIndex}].translations[${index}]: ${method}`);
    }
    if (!CONFLICT_MODES.has(conflicts)) {
      throw new Error(`Unsupported conflict mode for components[${componentIndex}].translations[${index}]: ${conflicts}`);
    }
    if (!FUZZY_MODES.has(fuzzy)) {
      throw new Error(`Unsupported fuzzy mode for components[${componentIndex}].translations[${index}]: ${fuzzy}`);
    }

    return compactObject({
      language: requiredString(translation.language, `components[${componentIndex}].translations[${index}].language`),
      path: optionalPath(translation.path ?? translation.file, workspace),
      method,
      conflicts,
      fuzzy,
      author_name: optionalString(translation.author_name),
      author_email: optionalString(translation.author_email)
    });
  });
}

function normalizeUploadDefaults(upload) {
  if (!upload || typeof upload !== "object" || Array.isArray(upload)) {
    throw new Error("Manifest defaults.upload must be an object when provided.");
  }

  const method = optionalString(upload.method) ?? "translate";
  const conflicts = optionalString(upload.conflicts) ?? "ignore";
  const fuzzy = optionalString(upload.fuzzy) ?? "";

  if (!UPLOAD_METHODS.has(method)) {
    throw new Error(`Unsupported default upload method: ${method}`);
  }
  if (!CONFLICT_MODES.has(conflicts)) {
    throw new Error(`Unsupported default conflict mode: ${conflicts}`);
  }
  if (!FUZZY_MODES.has(fuzzy)) {
    throw new Error(`Unsupported default fuzzy mode: ${fuzzy}`);
  }

  return { method, conflicts, fuzzy };
}

function validateReferencedProjects(projects, components) {
  const projectSlugs = new Set(projects.map((project) => project.slug));
  for (const component of components) {
    if (!projectSlugs.has(component.project)) {
      throw new Error(`Component ${component.slug} references missing project ${component.project}.`);
    }
  }
}

function applyModeDefaults(component) {
  if (isLocalFilesComponent(component)) {
    component.mode = COMPONENT_MODE_LOCAL_FILES;
    component.vcs = LOCAL_FILES_VCS;
    delete component.repo;
    delete component.branch;
    return;
  }

  component.mode = COMPONENT_MODE_REPOSITORY;
  component.branch ??= "main";
  component.vcs ??= "git";
}

function validateComponentModeConfiguration(component, componentIndex) {
  if (!isLocalFilesComponent(component)) {
    return;
  }

  const forbidden = ["repo", "branch", "push", "push_branch", "merge_style", "push_on_commit", "commit_pending_age", "auto_lock_error"]
    .filter((field) => component[field] !== undefined);
  if (forbidden.length > 0) {
    throw new Error(
      `components[${componentIndex}] in local-files mode must not define repository fields: ${forbidden.join(", ")}.`
    );
  }
}

function validateFilemask(component, componentIndex) {
  const wildcardCount = (component.filemask.match(/\*/g) ?? []).length;

  if (isXcstringsComponent(component)) {
    if (wildcardCount !== 0) {
      throw new Error(`components[${componentIndex}].filemask must not contain a * language placeholder for xcstrings catalogs.`);
    }
    if (!component.filemask.toLowerCase().endsWith(".xcstrings")) {
      throw new Error(`components[${componentIndex}].filemask must point to a .xcstrings catalog.`);
    }
    return;
  }

  if (wildcardCount !== 1) {
    throw new Error(`components[${componentIndex}].filemask must contain exactly one * language placeholder.`);
  }
}

function normalizeXcstringsTranslations(component, componentIndex) {
  if (!isXcstringsComponent(component)) {
    return;
  }

  for (const [translationIndex, translation] of component.translations.entries()) {
    if (translation.path === undefined) {
      translation.path = component.filemask;
      continue;
    }

    if (translation.path !== component.filemask) {
      throw new Error(
        `components[${componentIndex}].translations[${translationIndex}].path must match the xcstrings catalog filemask.`
      );
    }
  }
}

function validateUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function optionalString(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string value, got ${typeof value}.`);
  }
  return value;
}

function optionalPath(value, workspace) {
  const stringValue = optionalString(value);
  return stringValue === undefined ? undefined : normalizeWorkspacePath(stringValue, workspace);
}

function optionalBoolean(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean value, got ${typeof value}.`);
  }
  return value;
}

function optionalNumber(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected number value, got ${typeof value}.`);
  }
  return value;
}

function normalizeObject(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
