import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBooleanInput, getInput, getIntegerInput, info, setOutput, warning } from "./action-io.js";
import { isRepositoryBackedComponent } from "./component-mode.js";
import { getGitChangedFiles } from "./git.js";
import { loadManifest } from "./manifest.js";
import { resolveWorkspacePath } from "./path-utils.js";
import { createWeblateClient } from "./weblate-client.js";
import { catalogTranslations } from "./xcstrings.js";

const COMPONENT_REPOSITORY_OPERATIONS = new Set(["none", "pull"]);
const PROJECT_REPOSITORY_OPERATIONS = new Set(["file-scan", "file-sync"]);

export async function runDownloadAction(options = {}) {
  const env = options.env ?? process.env;
  const workspace = options.workspace ?? process.cwd();
  const inputs = {
    weblateUrl: getInput("weblate-url", { required: true }, env),
    apiToken: getInput("api-token", { required: true }, env),
    manifestPath: getInput("manifest", { defaultValue: ".weblate-localization.json" }, env),
    outputRoot: getInput("output-root", { defaultValue: "." }, env),
    dryRun: getBooleanInput("dry-run", { defaultValue: "false" }, env),
    lock: getBooleanInput("lock", { defaultValue: "false" }, env),
    repositoryOperation: getInput("repository-operation", { defaultValue: "pull" }, env),
    commitBeforeDownload: getBooleanInput("commit-before-download", { defaultValue: "true" }, env),
    failOnMergeNeeded: getBooleanInput("fail-on-merge-needed", { defaultValue: "true" }, env),
    taskTimeoutMs: getIntegerInput("task-timeout-ms", { defaultValue: "300000" }, env),
    taskPollIntervalMs: getIntegerInput("task-poll-interval-ms", { defaultValue: "3000" }, env)
  };

  validateRepositoryOperation(inputs.repositoryOperation);
  const outputWorkspace = resolveOutputRoot(inputs.outputRoot, workspace);
  const manifest = await loadManifest(resolveWorkspacePath(inputs.manifestPath, workspace), { workspace });
  validateDownloadDestinations(manifest, outputWorkspace);

  const client = options.client ?? createWeblateClient({
    baseUrl: inputs.weblateUrl,
    apiToken: inputs.apiToken,
    fetchImpl: options.fetchImpl
  });
  const repositoryComponents = manifest.components.filter(isRepositoryBackedComponent);

  const lockedComponents = [];
  const changedByBytes = new Set();
  let filesDownloaded = 0;

  try {
    if (inputs.lock && !inputs.dryRun) {
      await lockComponents(client, manifest, lockedComponents);
    }

    await assertRepositoryReady(client, repositoryComponents, inputs);
    await runRepositoryPreparation(client, manifest, repositoryComponents, inputs);
    await assertRepositoryReady(client, repositoryComponents, inputs);

    for (const component of manifest.components) {
      for (const translation of catalogTranslations(component)) {
        const destination = await resolveDownloadDestination(client, component, translation, outputWorkspace);

        if (inputs.dryRun) {
          info(`Dry run: would download ${component.project}/${component.slug}/${translation.language} to ${path.relative(outputWorkspace, destination)}`);
          continue;
        }

        const content = await client.downloadTranslationFile(component.project, component.slug, translation.language);
        const changed = await writeIfChanged(destination, content);
        if (changed) {
          changedByBytes.add(path.relative(workspace, destination).split(path.sep).join("/"));
        }
        filesDownloaded += 1;
      }
    }
  } finally {
    await unlockComponents(client, lockedComponents);
  }

  const manifestPaths = destinationPaths(manifest, outputWorkspace, workspace);
  const gitChangedFiles = inputs.dryRun ? [] : getGitChangedFiles(manifestPaths, { cwd: workspace });
  const byteChangedFiles = [...changedByBytes];
  const changedFiles = gitChangedFiles === null
    ? byteChangedFiles
    : [...new Set([...gitChangedFiles, ...byteChangedFiles])];
  const changed = changedFiles.length > 0;

  setOutput("changed", changed ? "true" : "false", env);
  setOutput("files-downloaded", filesDownloaded, env);
  setOutput("changed-files", changedFiles, env);
}

async function lockComponents(client, manifest, lockedComponents) {
  for (const component of manifest.components) {
    const lockState = await client.getComponentLock(component.project, component.slug);
    if (lockState?.locked) {
      warning(`Component already locked, leaving lock ownership unchanged: ${component.project}/${component.slug}`);
      continue;
    }

    await client.setComponentLock(component.project, component.slug, true);
    lockedComponents.push(component);
    info(`Locked component: ${component.project}/${component.slug}`);
  }
}

async function unlockComponents(client, lockedComponents) {
  for (const component of lockedComponents.reverse()) {
    try {
      await client.setComponentLock(component.project, component.slug, false);
      info(`Unlocked component: ${component.project}/${component.slug}`);
    } catch (error) {
      warning(`Failed to unlock ${component.project}/${component.slug}: ${error.message}`);
    }
  }
}

async function runRepositoryPreparation(client, manifest, repositoryComponents, inputs) {
  if (repositoryComponents.length === 0) {
    if (inputs.repositoryOperation !== "none" || inputs.commitBeforeDownload) {
      warning("Manifest uses only local-files components; skipping repository preparation.");
    }
    return;
  }

  if (inputs.dryRun) {
    info(`Dry run: would run repository preparation operation ${inputs.repositoryOperation}`);
    return;
  }

  if (inputs.repositoryOperation === "none") {
    return;
  }

  for (const component of repositoryComponents) {
    if (inputs.commitBeforeDownload) {
      await waitIfTaskReturned(client, await client.runComponentRepositoryOperation(component.project, component.slug, "commit"), inputs);
    }
  }

  if (PROJECT_REPOSITORY_OPERATIONS.has(inputs.repositoryOperation)) {
    const projectSlugs = new Set(repositoryComponents.map((component) => component.project));
    for (const project of projectSlugs) {
      await waitIfTaskReturned(client, await client.runProjectRepositoryOperation(project, inputs.repositoryOperation), inputs);
    }
    return;
  }

  for (const component of repositoryComponents) {
    if (inputs.repositoryOperation !== "none") {
      await waitIfTaskReturned(client, await client.runComponentRepositoryOperation(component.project, component.slug, inputs.repositoryOperation), inputs);
    }
  }
}

async function assertRepositoryReady(client, repositoryComponents, inputs) {
  if (!inputs.failOnMergeNeeded) {
    return;
  }

  for (const component of repositoryComponents) {
    const status = await client.getComponentRepositoryStatus(component.project, component.slug);
    if (status?.needs_merge || status?.merge_failure) {
      throw new Error(`Weblate repository is not ready for ${component.project}/${component.slug}: needs_merge=${Boolean(status.needs_merge)}, merge_failure=${status.merge_failure ?? ""}`);
    }
  }
}

async function resolveDownloadDestination(_client, _component, translation, outputWorkspace) {
  return resolveWorkspacePath(translation.path, outputWorkspace);
}

async function writeIfChanged(destination, content) {
  let current;
  try {
    current = await readFile(destination);
  } catch {
    current = null;
  }

  if (current && Buffer.compare(current, content) === 0) {
    return false;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, destination);
  return true;
}

function validateRepositoryOperation(operation) {
  if (!COMPONENT_REPOSITORY_OPERATIONS.has(operation) && !PROJECT_REPOSITORY_OPERATIONS.has(operation)) {
    throw new Error(`repository-operation must be one of none, pull, file-scan, or file-sync. Got: ${operation}`);
  }
}

function validateDownloadDestinations(manifest, outputWorkspace) {
  const destinations = new Set();
  for (const component of manifest.components) {
    for (const translation of catalogTranslations(component)) {
      if (!translation.path) {
        throw new Error(`Translation ${component.project}/${component.slug}/${translation.language} needs an explicit path for deterministic downloads.`);
      }

      const destination = resolveWorkspacePath(translation.path, outputWorkspace);
      if (destinations.has(destination)) {
        throw new Error(`Duplicate download destination: ${translation.path}`);
      }
      destinations.add(destination);
    }
  }
}

function destinationPaths(manifest, outputWorkspace, workspace) {
  return [...new Set(manifest.components.flatMap((component) =>
    catalogTranslations(component)
      .filter((translation) => translation.path)
      .map((translation) => path.relative(workspace, resolveWorkspacePath(translation.path, outputWorkspace)).split(path.sep).join("/"))
  ))];
}

function resolveOutputRoot(outputRoot, workspace) {
  if (!outputRoot || typeof outputRoot !== "string") {
    throw new Error("output-root must be a non-empty string.");
  }
  if (path.isAbsolute(outputRoot)) {
    throw new Error(`output-root must be relative to the workspace: ${outputRoot}`);
  }

  const resolved = path.resolve(workspace, outputRoot);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`output-root escapes the workspace: ${outputRoot}`);
  }

  return resolved;
}

async function waitIfTaskReturned(client, result, inputs) {
  const taskUrl = result?.task_url ?? result?.result?.task_url;
  if (!taskUrl) {
    return;
  }

  await client.waitTask(taskUrl, {
    timeoutMs: inputs.taskTimeoutMs,
    pollIntervalMs: inputs.taskPollIntervalMs
  });
}
