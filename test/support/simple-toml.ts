import { isRecord } from "../../src/unknown-parse";

export type SimpleTomlValue = string | number | boolean | SimpleTomlValue[] | SimpleTomlObject;
export interface SimpleTomlObject {
  [key: string]: SimpleTomlValue;
}

/**
 * Minimal structural TOML reader for repository configuration tests.
 *
 * It supports the value forms used by wrangler.toml: strings, booleans,
 * numbers, arrays, tables and arrays of tables. Tests consume parsed values
 * rather than relying on source ordering or whitespace.
 */
export function parseSimpleToml(source: string): SimpleTomlObject {
  const root: SimpleTomlObject = {};
  let current = root;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = stripComment(lines[index] ?? "").trim();
    if (!line) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = line.slice(2, -2).trim().split(".");
      const parent = ensureObjectPath(root, path.slice(0, -1));
      const key = path.at(-1)!;
      const existing = parent[key];
      const entries = Array.isArray(existing) ? existing : [];
      const entry: SimpleTomlObject = {};
      entries.push(entry);
      parent[key] = entries;
      current = entry;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      current = ensureObjectPath(root, line.slice(1, -1).trim().split("."));
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let rawValue = line.slice(separator + 1).trim();

    while (needsContinuation(rawValue) && index + 1 < lines.length) {
      index += 1;
      rawValue += `\n${stripComment(lines[index] ?? "").trim()}`;
    }
    current[key] = parseValue(rawValue);
  }

  return root;
}

function ensureObjectPath(root: SimpleTomlObject, path: string[]): SimpleTomlObject {
  let current = root;
  for (const segment of path) {
    const existing = current[segment];
    if (!isRecord(existing) || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as SimpleTomlObject;
  }
  return current;
}

function parseValue(raw: string): SimpleTomlValue {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      return JSON.parse(value.replace(/,\s*]/g, "]")) as SimpleTomlValue[];
    } catch {
      return value;
    }
  }
  return value;
}

function needsContinuation(value: string): boolean {
  if (!value.startsWith("[")) return false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
  }
  return depth > 0;
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}
