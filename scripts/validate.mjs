// Validates every catalog entry (and any repo-hosted feed) before merge. Dependency-free.
// Fails (exit 1) on any error so the PR gate blocks a malformed submission.

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  APP_ID_PATTERN,
  ARTIFACT_KINDS,
  CATEGORIES,
  FEEDS_DIR,
  ROOT,
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

function validateFeed(id, feedPath) {
  let feed;
  try {
    feed = readJson(feedPath);
  } catch (error) {
    err(id, `feed ${feedPath} is not valid JSON: ${error.message}`);
    return;
  }

  if (!Array.isArray(feed.versions) || feed.versions.length === 0) {
    err(id, "feed.versions must be a non-empty array");
    return;
  }

  const seen = new Set();
  for (const [index, version] of feed.versions.entries()) {
    const at = `feed.versions[${index}]`;
    if (typeof version.version !== "string" || version.version.length === 0) {
      err(id, `${at}.version is required`);
    } else if (!seen.add(version.version)) {
      err(id, `${at}.version '${version.version}' is duplicated`);
    }
    if (!isHttpUrl(version.manifestRef)) {
      err(id, `${at}.manifestRef must be an absolute http(s) URL`);
    }
    if (version.artifact !== undefined) {
      if (!ARTIFACT_KINDS.includes(version.artifact.kind)) {
        err(id, `${at}.artifact.kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
      }
    }
  }

  for (const tag of ["stable", "beta"]) {
    const value = feed.tags?.[tag];
    if (value !== undefined && !seen.has(value)) {
      err(id, `feed.tags.${tag} '${value}' does not match any listed version`);
    }
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

  // releasesUrl: relative -> a repo-hosted feed file that must exist and validate; absolute -> http(s).
  if (entry.releasesUrl !== undefined) {
    if (isHttpUrl(entry.releasesUrl)) {
      // Author-hosted feed; reachability/shape verified at install time, not in CI.
      warn(folder, `releasesUrl is external (${entry.releasesUrl}) — not validated in CI`);
    } else {
      const feedPath = resolveLocal(ROOT, entry.releasesUrl);
      if (!existsSync(feedPath)) {
        err(folder, `releasesUrl '${entry.releasesUrl}' points at a missing repo file`);
      } else {
        validateFeed(folder, feedPath);
      }
    }
  } else {
    warn(folder, "no releasesUrl — the app will show no installable versions in the storefront");
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

  // Also fail on an orphan feed that no entry references (avoids dead files / typos).
  const referenced = new Set(
    entries
      .map((entry) => {
        try {
          return readJson(entry.entryPath).releasesUrl;
        } catch {
          return undefined;
        }
      })
      .filter((value) => value && !isHttpUrl(value))
      .map((value) => join(ROOT, value)),
  );
  try {
    for (const file of readdirSync(FEEDS_DIR)) {
      if (file.endsWith(".json") && !referenced.has(join(FEEDS_DIR, file))) {
        warnings.push(`feeds/${file}: not referenced by any entry`);
      }
    }
  } catch {
    // no feeds/ dir — fine
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
