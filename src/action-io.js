import { appendFileSync } from "node:fs";

export function getInput(name, options = {}, env = process.env) {
  const keys = inputEnvKeys(name);
  const value = keys.map((key) => env[key]).find((candidate) => candidate !== undefined);
  const normalized = value === undefined || value === "" ? options.defaultValue : value;

  if (options.required && (normalized === undefined || normalized === "")) {
    throw new Error(`Missing required input: ${name}`);
  }

  return normalized ?? "";
}

export function getBooleanInput(name, options = {}, env = process.env) {
  const raw = getInput(name, options, env);
  if (typeof raw === "boolean") {
    return raw;
  }

  const value = String(raw).trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Input ${name} must be true or false, got: ${raw}`);
}

export function getIntegerInput(name, options = {}, env = process.env) {
  const raw = getInput(name, options, env);
  const value = Number.parseInt(String(raw), 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input ${name} must be a positive integer, got: ${raw}`);
  }

  return value;
}

export function info(message) {
  console.log(message);
}

export function warning(message) {
  console.warn(`Warning: ${message}`);
}

export function setOutput(name, value, env = process.env) {
  const serialized = Array.isArray(value) ? value.join("\n") : String(value);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${name}<<__WEBLATE_OUTPUT__\n${serialized}\n__WEBLATE_OUTPUT__\n`);
    return;
  }

  console.log(`${name}=${serialized}`);
}

function inputEnvKeys(name) {
  const upper = name.toUpperCase();
  return [
    `INPUT_${upper}`,
    `INPUT_${upper.replaceAll("-", "_")}`,
    `INPUT_${upper.replaceAll(" ", "_")}`,
    `INPUT_${upper.replaceAll("-", "_").replaceAll(" ", "_")}`
  ];
}
