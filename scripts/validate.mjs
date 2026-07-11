// Validates every catalog entry before merge. Dependency-free.
// Fails (exit 1) on any error so the PR gate blocks a malformed submission.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  APP_ID_PATTERN,
  CATEGORIES,
  isHttpUrl,
  listEntryDirs,
  readJson,
} from "./lib.mjs";

const errors = [];
const warnings = [];
const err = (id, message) => errors.push(`${id}: ${message}`);
const warn = (id, message) => warnings.push(`${id}: ${message}`);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resolveLocal(base, ref) {
  // A repo-relative ref (not http, not absolute path) resolves against `base`.
  return isAbsolute(ref) ? ref : join(base, ref);
}

function validateEntry({ id: folder, dir, entryPath }, seenIds) {
  if (!existsSync(entryPath)) {
    err(folder, "missing entry.json");
    return;
  }

  let entry;
  try {
    entry = readJson(entryPath);
  } catch (error) {
    err(folder, `entry.json is not valid JSON: ${error.message}`);
    return;
  }

  const id = entry.id;
  if (typeof id !== "string" || !APP_ID_PATTERN.test(id)) {
    err(folder, "id must match ^[a-z0-9][a-z0-9._-]{0,62}$");
  } else {
    if (id !== folder) {
      err(folder, `id '${id}' must equal the folder name '${folder}'`);
    }
    if (!seenIds.add(id)) {
      err(folder, `id '${id}' is declared by more than one entry`);
    }
  }

  if (entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length === 0)) {
    err(folder, "name must be a non-empty string when present");
  }

  if (entry.category !== undefined && !CATEGORIES.includes(entry.category)) {
    err(folder, `category '${entry.category}' must be one of ${CATEGORIES.join(", ")}`);
  }

  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string" || tag.length === 0)) {
      err(folder, "tags must be an array of non-empty strings");
    }
  }

  if (entry.publisher?.url !== undefined && !isHttpUrl(entry.publisher.url)) {
    err(folder, "publisher.url must be an http(s) URL");
  }
  if (entry.publisher?.email !== undefined && !EMAIL_PATTERN.test(entry.publisher.email)) {
    err(folder, "publisher.email is not a valid email");
  }

  // Assets: a relative path must exist in the repo; an absolute ref must be http(s).
  const assets = [entry.display?.icon, ...(entry.display?.screenshots ?? [])].filter((value) => value !== undefined);
  for (const asset of assets) {
    if (typeof asset !== "string" || asset.length === 0) {
      err(folder, "display icon/screenshots entries must be non-empty strings");
      continue;
    }
    if (isHttpUrl(asset)) {
      continue;
    }
    if (!existsSync(resolveLocal(dir, asset))) {
      err(folder, `asset '${asset}' does not exist in the entry folder`);
    }
  }

  // Legacy pointers must not linger: feeds now live in the app repository's feeds.json, referenced
  // from the entry by feedsUrl.
  if (entry.releasesUrl !== undefined) {
    err(folder, "releasesUrl is no longer supported — declare feedsUrl (the app repository's feeds.json) instead");
  }
  if (entry.feeds !== undefined) {
    err(folder, "inline feeds[] moved to the app repository's feeds.json (app-feeds.0.1) — declare feedsUrl instead");
  }

  if (entry.feedsUrl !== undefined) {
    if (!isHttpUrl(entry.feedsUrl)) {
      err(folder, "feedsUrl must be an absolute http(s) URL to the app's feeds.json");
    }
  } else {
    warn(folder, "no feedsUrl — the app will not be installable from the storefront");
  }
}

function main() {
  const entries = listEntryDirs();
  if (entries.length === 0) {
    console.log("No catalog entries found under apps/.");
  }

  const seenIds = new Set();
  for (const entry of entries) {
    validateEntry(entry, seenIds);
  }

  for (const warning of warnings) {
    console.warn(`warning  ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error    ${error}`);
    }
    console.error(`\n${errors.length} error(s) — catalog validation failed.`);
    process.exit(1);
  }

  const count = listEntryDirs().length;
  console.log(`\nOK — ${count} entr${count === 1 ? "y" : "ies"} valid.`);
}

main();
