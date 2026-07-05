// Shared helpers for the catalog tooling. Dependency-free (plain Node) so CI needs no install step.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APPS_DIR = join(ROOT, "apps");
export const FEEDS_DIR = join(ROOT, "feeds");

export const SCHEMA_VERSION = "marketplace.0.1";

// Must stay in sync with Hosty Core's AppIdPattern (RuntimeAppManifest.cs) and entry.schema.json.
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// Must stay in sync with entry.schema.json `category` enum.
export const CATEGORIES = ["Media", "Developer Tools", "Productivity", "Networking", "AI", "Utilities", "Other"];

export const ARTIFACT_KINDS = ["image", "source", "prebuilt"];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Every apps/<id>/ folder holding an entry.json, sorted by id.
export function listEntryDirs() {
  let names;
  try {
    names = readdirSync(APPS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(APPS_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ id: name, dir: join(APPS_DIR, name), entryPath: join(APPS_DIR, name, "entry.json") }));
}

export function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
