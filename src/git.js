import { execFileSync } from "node:child_process";
import { warning } from "./action-io.js";

export function getGitChangedFiles(paths, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (paths.length === 0) {
    return [];
  }

  try {
    const output = execFileSync("git", ["diff", "-z", "--name-only", "--", ...paths], {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"]
    });

    return output.toString("utf8").split("\0").filter(Boolean);
  } catch {
    warning("Unable to inspect git diff; falling back to byte comparison.");
    return null;
  }
}
