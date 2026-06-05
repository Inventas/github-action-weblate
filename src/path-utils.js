import path from "node:path";

export function normalizeWorkspacePath(filePath, workspace = process.cwd()) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Manifest paths must be non-empty strings.");
  }

  if (path.isAbsolute(filePath)) {
    throw new Error(`Manifest path must be relative to the workspace: ${filePath}`);
  }
  if (/[\0\r\n]/.test(filePath)) {
    throw new Error(`Manifest path contains unsupported control characters: ${filePath}`);
  }

  const absoluteWorkspace = path.resolve(workspace);
  const absolutePath = path.resolve(absoluteWorkspace, filePath);
  const relative = path.relative(absoluteWorkspace, absolutePath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Manifest path escapes the workspace: ${filePath}`);
  }

  return relative.split(path.sep).join("/");
}

export function resolveWorkspacePath(filePath, workspace = process.cwd()) {
  const safeRelative = normalizeWorkspacePath(filePath, workspace);
  return path.resolve(workspace, safeRelative);
}
