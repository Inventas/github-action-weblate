import { readFile, stat } from "node:fs/promises";
import { getBooleanInput, getInput, getIntegerInput, info, setOutput, warning } from "./action-io.js";
import { isLocalFilesComponent } from "./component-mode.js";
import { getLocalFilesBootstrap } from "./local-files.js";
import { loadManifest } from "./manifest.js";
import { resolveWorkspacePath } from "./path-utils.js";
import { createWeblateClient } from "./weblate-client.js";
import { catalogTranslations } from "./xcstrings.js";
import { createStoredZip } from "./zip.js";

export async function runSetupUploadAction(options = {}) {
  const env = options.env ?? process.env;
  const workspace = options.workspace ?? process.cwd();
  const inputs = {
    weblateUrl: getInput("weblate-url", { required: true }, env),
    apiToken: getInput("api-token", { required: true }, env),
    manifestPath: getInput("manifest", { defaultValue: ".weblate-localization.json" }, env),
    dryRun: getBooleanInput("dry-run", { defaultValue: "false" }, env),
    setup: getBooleanInput("setup", { defaultValue: "true" }, env),
    upload: getBooleanInput("upload", { defaultValue: "true" }, env),
    taskTimeoutMs: getIntegerInput("task-timeout-ms", { defaultValue: "300000" }, env),
    taskPollIntervalMs: getIntegerInput("task-poll-interval-ms", { defaultValue: "3000" }, env)
  };

  if (!inputs.setup && !inputs.upload) {
    throw new Error("setup=false and upload=false is a no-op.");
  }

  const manifest = await loadManifest(resolveWorkspacePath(inputs.manifestPath, workspace), { workspace });

  if (inputs.setup) {
    validateSetupManifest(manifest);
    await validateSetupFiles(manifest, workspace);
  }
  if (inputs.upload) {
    await validateUploadFiles(manifest, workspace);
  }

  const client = options.client ?? createWeblateClient({
    baseUrl: inputs.weblateUrl,
    apiToken: inputs.apiToken,
    fetchImpl: options.fetchImpl,
    repositoryLockRetryTimeoutMs: inputs.taskTimeoutMs,
    repositoryLockRetryPollIntervalMs: inputs.taskPollIntervalMs,
    onRepositoryLockRetry: ({ attempt, method, retryAfterMs, url }) => {
      info(`Weblate repository is locked for ${method} ${url}; retrying in ${retryAfterMs} ms (attempt ${attempt}).`);
    }
  });

  const stats = {
    projectsCreated: 0,
    componentsCreated: 0,
    translationsCreated: 0,
    filesUploaded: 0
  };

  if (inputs.setup) {
    await ensureProjects(client, manifest, inputs, stats);
    await ensureComponents(client, manifest, inputs, stats, workspace);
    await ensureTranslations(client, manifest, inputs, stats);
  }

  if (inputs.upload) {
    await uploadFiles(client, manifest, inputs, stats, workspace);
  }

  setOutput("projects-created", stats.projectsCreated, env);
  setOutput("components-created", stats.componentsCreated, env);
  setOutput("translations-created", stats.translationsCreated, env);
  setOutput("files-uploaded", stats.filesUploaded, env);
}

async function ensureProjects(client, manifest, inputs, stats) {
  for (const project of manifest.projects) {
    const existing = await client.getProject(project.slug);
    if (existing) {
      warnOnDrift(`project ${project.slug}`, existing, project, ["name", "web"]);
      info(`Project exists: ${project.slug}`);
      continue;
    }

    if (inputs.dryRun) {
      info(`Dry run: would create project ${project.slug}`);
      continue;
    }

    await client.createProject(project);
    stats.projectsCreated += 1;
    info(`Created project: ${project.slug}`);
  }
}

async function ensureComponents(client, manifest, inputs, stats, workspace) {
  for (const component of manifest.components) {
    const existing = await client.getComponent(component.project, component.slug);
    if (existing) {
      warnOnDrift(`component ${component.project}/${component.slug}`, existing, component, driftFields(component));
      info(`Component exists: ${component.project}/${component.slug}`);
      continue;
    }

    if (inputs.dryRun) {
      info(`Dry run: would create component ${component.project}/${component.slug}`);
      continue;
    }

    const result = isLocalFilesComponent(component)
      ? await client.createLocalFilesComponent(
        component.project,
        componentPayload(component),
        await buildLocalFilesBootstrap(component, workspace)
      )
      : await client.createComponent(component.project, componentPayload(component));
    await waitIfTaskReturned(client, result, inputs);
    await verifyCreatedComponent(client, component);
    stats.componentsCreated += 1;
    info(`Created component: ${component.project}/${component.slug}`);
  }
}

async function ensureTranslations(client, manifest, inputs, stats) {
  for (const component of manifest.components) {
    for (const translation of component.translations) {
      const existing = await client.getTranslation(component.project, component.slug, translation.language);
      if (existing) {
        info(`Translation exists: ${component.project}/${component.slug}/${translation.language}`);
        continue;
      }

      if (inputs.dryRun) {
        info(`Dry run: would add translation ${component.project}/${component.slug}/${translation.language}`);
        continue;
      }

      const creation = await createTranslationOrDetectExisting(client, component, translation);
      if (!creation.created) {
        info(`Translation exists: ${component.project}/${component.slug}/${translation.language}`);
        continue;
      }

      const result = creation.result;
      await waitIfTaskReturned(client, result, inputs);
      await verifyCreatedTranslation(client, component, translation);
      stats.translationsCreated += 1;
      info(`Added translation: ${component.project}/${component.slug}/${translation.language}`);
    }
  }
}

async function createTranslationOrDetectExisting(client, component, translation) {
  try {
    return {
      created: true,
      result: await client.createTranslation(component.project, component.slug, translation.language)
    };
  } catch (error) {
    const existing = await client.getTranslation(component.project, component.slug, translation.language);
    if (existing) {
      warning(
        `Translation ${component.project}/${component.slug}/${translation.language} already exists after create failed; continuing. Original error: ${error.message}`
      );
      return { created: false };
    }

    throw error;
  }
}

async function uploadFiles(client, manifest, inputs, stats, workspace) {
  for (const component of manifest.components) {
    for (const translation of catalogTranslations(component)) {
      if (!translation.path) {
        throw new Error(`Translation ${component.project}/${component.slug}/${translation.language} has no path for upload.`);
      }

      const absolutePath = resolveWorkspacePath(translation.path, workspace);
      const fileStat = await stat(absolutePath);
      if (fileStat.size === 0) {
        warning(`Skipping empty upload file: ${translation.path} (${component.project}/${component.slug}/${translation.language})`);
        continue;
      }
      if (inputs.dryRun) {
        info(`Dry run: would upload ${translation.path} to ${component.project}/${component.slug}/${translation.language} using method=${translation.method}`);
        continue;
      }

      const result = await client.uploadTranslationFile(component.project, component.slug, translation, absolutePath);
      await waitIfTaskReturned(client, result, inputs);
      stats.filesUploaded += 1;
      info(`Uploaded ${translation.path} to ${component.project}/${component.slug}/${translation.language}`);
    }
  }
}

function validateSetupManifest(manifest) {
  for (const project of manifest.projects) {
    if (!project.name || !project.web) {
      throw new Error(`Project ${project.slug} needs name and web fields so setup can create it when missing.`);
    }
  }

  for (const component of manifest.components) {
    const missing = isLocalFilesComponent(component)
      ? ["name", "vcs", "docfile"].filter((field) => !component[field])
      : ["name", "repo", "branch", "vcs"].filter((field) => !component[field]);
    if (missing.length > 0) {
      throw new Error(`Component ${component.project}/${component.slug} is missing setup fields: ${missing.join(", ")}`);
    }
  }
}

async function validateSetupFiles(manifest, workspace) {
  for (const component of manifest.components) {
    if (!isLocalFilesComponent(component)) {
      continue;
    }

    for (const setupPath of localFilesBootstrapPaths(component)) {
      const absolutePath = resolveWorkspacePath(setupPath, workspace);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`Setup bootstrap path is not a file: ${setupPath}`);
      }
    }
  }
}

async function validateUploadFiles(manifest, workspace) {
  const seenPaths = new Set();
  for (const component of manifest.components) {
    for (const translation of catalogTranslations(component)) {
      if (!translation.path) {
        throw new Error(`Translation ${component.project}/${component.slug}/${translation.language} has no path for upload.`);
      }

      const key = `${component.project}/${component.slug}/${translation.language}:${translation.path}`;
      if (seenPaths.has(key)) {
        throw new Error(`Duplicate upload mapping: ${key}`);
      }
      seenPaths.add(key);

      const absolutePath = resolveWorkspacePath(translation.path, workspace);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`Upload path is not a file: ${translation.path}`);
      }
    }
  }
}

function componentPayload(component) {
  const localFilesComponent = isLocalFilesComponent(component);
  return compactObject({
    branch: component.branch,
    docfile: component.docfile,
    file_format: component.file_format,
    file_format_params: component.file_format_params,
    filemask: component.filemask,
    name: component.name,
    slug: component.slug,
    repo: component.repo,
    template: component.template ?? (localFilesComponent ? undefined : ""),
    new_base: localFilesComponent ? component.new_base ?? component.docfile : component.new_base ?? "",
    vcs: component.vcs,
    push: component.push,
    push_branch: component.push_branch,
    source_language: component.source_language,
    new_lang: localFilesComponent ? component.new_lang ?? "none" : component.new_lang,
    language_code_style: component.language_code_style,
    language_aliases: component.language_aliases,
    merge_style: component.merge_style,
    push_on_commit: component.push_on_commit,
    commit_pending_age: component.commit_pending_age,
    auto_lock_error: component.auto_lock_error
  });
}

function driftFields(component) {
  return isLocalFilesComponent(component)
    ? ["file_format", "filemask", "template", "new_base", "new_lang", "source_language", "vcs"]
    : ["file_format", "filemask", "repo", "branch", "template", "new_base", "source_language", "vcs"];
}

async function buildLocalFilesBootstrap(component, workspace) {
  const bootstrap = getLocalFilesBootstrap(component);
  const entries = [];
  for (const entryPath of bootstrap.paths) {
    entries.push({
      name: entryPath,
      data: await readFile(resolveWorkspacePath(entryPath, workspace))
    });
  }

  return {
    kind: "zipfile",
    filename: `${component.slug}.zip`,
    content: createStoredZip(entries)
  };
}

function localFilesBootstrapPaths(component) {
  return getLocalFilesBootstrap(component).paths;
}

async function waitIfTaskReturned(client, result, inputs) {
  const taskUrl = result?.task_url ?? result?.result?.task_url;
  if (!taskUrl) {
    return;
  }

  info(`Waiting for Weblate task: ${taskUrl}`);
  await client.waitTask(taskUrl, {
    timeoutMs: inputs.taskTimeoutMs,
    pollIntervalMs: inputs.taskPollIntervalMs
  });
}

async function verifyCreatedComponent(client, component) {
  const created = await client.getComponent(component.project, component.slug);
  if (!created) {
    throw new Error(`Component creation finished but component is not available: ${component.project}/${component.slug}`);
  }
}

async function verifyCreatedTranslation(client, component, translation) {
  const created = await client.getTranslation(component.project, component.slug, translation.language);
  if (!created) {
    throw new Error(`Translation creation finished but translation is not available: ${component.project}/${component.slug}/${translation.language}`);
  }
}

function warnOnDrift(label, existing, expected, fields) {
  for (const field of fields) {
    if (expected[field] !== undefined && existing[field] !== undefined && existing[field] !== expected[field]) {
      warning(`${label} ${field} differs from manifest; keeping existing Weblate configuration.`);
    }
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
