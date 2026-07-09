// Validates every catalog entry before merge. Dependency-free.
// Fails (exit 1) on any error so the PR gate blocks a malformed submission.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  APP_ID_PATTERN,
  CATEGORIES,
  FEED_ID_PATTERN,
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

// Feeds live inline in the entry: named pointers at moving manifest refs. Anything malformed is a
// hard error (never a silent skip) so a broken feed can't merge and strand installs.
function validateFeeds(id, feeds) {
  if (!Array.isArray(feeds) || feeds.length === 0) {
    err(id, "feeds must be a non-empty array when present");
    return;
  }

  const seen = new Set();
  let defaults = 0;
  for (const [index, feed] of feeds.entries()) {
    const at = `feeds[${index}]`;
    if (!feed || typeof feed !== "object") {
      err(id, `${at} must be an object`);
      continue;
    }
    if (typeof feed.id !== "string" || !FEED_ID_PATTERN.test(feed.id)) {
      err(id, `${at}.id must match ${FEED_ID_PATTERN}`);
    } else if (!seen.add(feed.id)) {
      err(id, `${at}.id '${feed.id}' is duplicated`);
    }
    if (!isHttpUrl(feed.manifestRef)) {
      err(id, `${at}.manifestRef must be an absolute http(s) URL to the app's manifest at a moving ref`);
    }
    if (feed.default !== undefined && feed.default !== true) {
      err(id, `${at}.default must be true when present (omit it otherwise)`);
    }
    if (feed.default === true) defaults += 1;
  }

  if (defaults > 1) {
    err(id, "at most one feed may be marked default: true");
  }
  if (feeds.length === 1 && defaults === 1) {
    warn(id, "default: true is redundant on a single feed");
  }
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

  // The removed pinned-feed pointer must not linger: entries carry feeds inline now.
  if (entry.releasesUrl !== undefined) {
    err(folder, "releasesUrl is no longer supported — declare feeds[] (named moving manifest refs) instead");
  }

  if (entry.feeds !== undefined) {
    validateFeeds(folder, entry.feeds);
  } else {
    warn(folder, "no feeds — the app will not be installable from the storefront");
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
