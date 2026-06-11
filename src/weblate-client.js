import { basename } from "node:path";
import { readFile } from "node:fs/promises";

export function createWeblateClient(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiToken = options.apiToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!apiToken) {
    throw new Error("A Weblate API token is required.");
  }
  if (!fetchImpl) {
    throw new Error("This action requires a Node runtime with fetch support.");
  }

  async function request(pathOrUrl, requestOptions = {}) {
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${baseUrl}${pathOrUrl}`;
    const headers = {
      Authorization: `Token ${apiToken}`,
      ...(requestOptions.headers ?? {})
    };

    const response = await fetchImpl(url, {
      method: requestOptions.method ?? "GET",
      headers,
      body: requestOptions.body
    });

    const expected = requestOptions.expected ?? [200, 201, 202, 204];
    if (!expected.includes(response.status)) {
      throw new Error(`Weblate API ${requestOptions.method ?? "GET"} ${url} failed with ${response.status}: ${await safeText(response)}`);
    }

    if (response.status === 204 || requestOptions.parse === "none") {
      return null;
    }
    if (requestOptions.parse === "buffer") {
      return Buffer.from(await response.arrayBuffer());
    }

    return response.json();
  }

  async function getOrNull(path) {
    const url = `${baseUrl}${path}`;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Token ${apiToken}`
      }
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Weblate API GET ${url} failed with ${response.status}: ${await safeText(response)}`);
    }

    return response.json();
  }

  return {
    getProject: (project) => getOrNull(`/api/projects/${encodeSegment(project)}/`),
    createProject: (project) => request("/api/projects/", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(project)
    }),
    getComponent: (project, component) => getOrNull(`/api/components/${encodeSegment(project)}/${encodeSegment(component)}/`),
    createComponent: (project, component) => request(`/api/projects/${encodeSegment(project)}/components/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(component)
    }),
    createLocalFilesComponent: async (project, component, bootstrap) => {
      const form = new FormData();
      if (bootstrap.kind === "docfile") {
        const fileBuffer = await readFile(bootstrap.absolutePath);
        form.append("docfile", new Blob([fileBuffer]), basename(bootstrap.absolutePath));
      } else {
        form.append("zipfile", new Blob([bootstrap.content]), bootstrap.filename);
      }
      appendFormEntries(form, component);

      return request(`/api/projects/${encodeSegment(project)}/components/`, {
        method: "POST",
        body: form
      });
    },
    getTranslation: (project, component, language) =>
      getOrNull(`/api/translations/${encodeSegment(project)}/${encodeSegment(component)}/${encodeSegment(language)}/`),
    createTranslation: (project, component, languageCode, fromComponent) => request(
      `/api/components/${encodeSegment(project)}/${encodeSegment(component)}/translations/`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(compactObject({
          language_code: languageCode,
          from_component: fromComponent
        }))
      }
    ),
    uploadTranslationFile: async (project, component, translation, absolutePath) => {
      const form = new FormData();
      const fileBuffer = await readFile(absolutePath);

      form.append("file", new Blob([fileBuffer]), basename(absolutePath));
      form.append("method", translation.method);
      form.append("conflicts", translation.conflicts);
      if (translation.fuzzy) {
        form.append("fuzzy", translation.fuzzy);
      }
      if (translation.author_name) {
        form.append("author_name", translation.author_name);
      }
      if (translation.author_email) {
        form.append("author_email", translation.author_email);
      }

      return request(`/api/translations/${encodeSegment(project)}/${encodeSegment(component)}/${encodeSegment(translation.language)}/file/`, {
        method: "POST",
        body: form
      });
    },
    getComponentRepositoryStatus: (project, component) =>
      request(`/api/components/${encodeSegment(project)}/${encodeSegment(component)}/repository/`),
    runComponentRepositoryOperation: (project, component, operation) => request(
      `/api/components/${encodeSegment(project)}/${encodeSegment(component)}/repository/`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ operation })
      }
    ),
    runProjectRepositoryOperation: (project, operation) => request(`/api/projects/${encodeSegment(project)}/repository/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ operation })
    }),
    setComponentLock: (project, component, lock) => request(`/api/components/${encodeSegment(project)}/${encodeSegment(component)}/lock/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ lock })
    }),
    getComponentLock: (project, component) => request(`/api/components/${encodeSegment(project)}/${encodeSegment(component)}/lock/`),
    downloadTranslationFile: (project, component, language) => request(
      `/api/translations/${encodeSegment(project)}/${encodeSegment(component)}/${encodeSegment(language)}/file/`,
      { parse: "buffer" }
    ),
    waitTask: async (taskUrl, waitOptions = {}) => {
      const timeoutMs = waitOptions.timeoutMs ?? 300000;
      const pollIntervalMs = waitOptions.pollIntervalMs ?? 3000;
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        const task = await request(taskUrl);
        const status = String(task.status ?? task.state ?? "").toLowerCase();

        if (task.failed || task.error || ["failure", "failed", "error"].includes(status)) {
          throw new Error(`Weblate task failed: ${JSON.stringify(task)}`);
        }
        if (task.finished || task.completed || ["success", "finished", "completed", "done"].includes(status)) {
          return task;
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(`Timed out waiting for Weblate task: ${taskUrl}`);
    }
  };
}

export function encodeSegment(value) {
  return encodeURIComponent(String(value)).replaceAll("%2F", "%252F").replaceAll("%2f", "%252F");
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("Weblate URL is required.");
  }
  return String(baseUrl).replace(/\/+$/, "");
}

function jsonHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "<unable to read response body>";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function appendFormEntries(form, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || key === "docfile") {
      continue;
    }
    if (typeof value === "object" && value !== null) {
      form.append(key, JSON.stringify(value));
      continue;
    }
    form.append(key, String(value));
  }
}
