// Shared helpers for the catalog tooling. Dependency-free (plain Node) so CI needs no install step.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root. CATALOG_ROOT lets tests point the tooling at a fixture repo; production
// falls back to the real repo relative to this script.
export const ROOT = process.env.CATALOG_ROOT
  ? resolve(process.env.CATALOG_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// --- Publish-time asset vendoring (used by generate-catalog.mjs --vendor) ---
//
// The catalog vendors an app's display assets from the app repo at publish, so the
// storefront stays self-contained and frozen at review time (no hotlinking to mutable
// author URLs). All of this is deliberately conservative and fails loudly: a declared
// asset that can't be fetched, is too big, has a disallowed type, or escapes the app's
// manifest folder aborts the build rather than shipping a broken storefront.

// Display-asset extension allowlist. Mirrors the Core asset endpoint (D4 in the feature plan).
export const IMAGE_EXTENSIONS = ["svg", "png", "webp", "jpg", "jpeg", "gif", "avif"];
export const DESCRIPTION_EXTENSIONS = ["md"];

// Per-file byte caps (D7). Oversized declared assets fail the publish build.
export const ICON_MAX_BYTES = 512 * 1024;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const DESCRIPTION_MAX_BYTES = 256 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

// Per-app vendoring budget (D7): a floor against a runaway manifest.
export const PER_APP_MAX_FILES = 32;
export const PER_APP_MAX_BYTES = 20 * 1024 * 1024;

export class VendorError extends Error {}

function extensionOf(pathname) {
  const base = pathname.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Resolve a manifest's folder (its "asset root") — the manifestRef with the file name dropped.
// A trailing-slash URL means `startsWith` containment can't be fooled by a sibling prefix
// (`.../demo/` never matches `.../demo-evil/...`).
export function manifestFolderBase(manifestRef) {
  return new URL(".", manifestRef).href;
}

// Resolve a ref and enforce containment. `resolveBase` is what a relative ref resolves against
// (the manifest folder for a manifest-declared asset; a description file's own folder for an image
// it references). `containmentRoot` is the boundary the result must stay within — always the app's
// manifest folder (the asset root, D1), so a description in a subfolder may still reach a sibling
// asset like ../assets/icon.svg without escaping the app. Throws VendorError on escape or a
// cross-origin ref. Path comparison is case-sensitive by construction (URL paths are case-sensitive),
// so a case-insensitive host can't be used to slip a sibling past the check.
export function resolveContainedRef(resolveBase, ref, containmentRoot = resolveBase) {
  let resolved;
  try {
    resolved = new URL(ref, resolveBase);
  } catch {
    throw new VendorError(`ref '${ref}' is not a resolvable URL`);
  }
  // The URL parser resolves literal ./ and ../ dot-segments but leaves percent-encoded ones
  // (%2e%2e, %2f, %5c) intact, so a startsWith check would treat `.../demo/%2e%2e/secret` as
  // contained even though a server may decode it and escape the folder. Reject encoded traversal
  // tokens outright — real asset paths never contain them.
  if (/%2e|%2f|%5c/i.test(resolved.pathname)) {
    throw new VendorError(`ref '${ref}' contains percent-encoded path traversal`);
  }
  if (!resolved.href.startsWith(containmentRoot)) {
    throw new VendorError(`ref '${ref}' escapes the app's manifest folder (${containmentRoot})`);
  }
  return resolved.href;
}

// The manifest-folder-relative path of a contained URL — reused verbatim under
// dist/apps/<id>/vendored/ so a vendored markdown file and its images keep the same
// relative relationship and the markdown never needs rewriting.
export function containedRelativePath(folderBase, resolvedUrl) {
  const basePath = new URL(folderBase).pathname;
  const path = new URL(resolvedUrl).pathname;
  return decodeURIComponent(path.slice(basePath.length));
}

export function assertAllowedExtension(ref, allowlist) {
  const ext = extensionOf(new URL(ref, "https://placeholder.invalid/").pathname);
  if (!allowlist.includes(ext)) {
    throw new VendorError(`ref '${ref}' has a disallowed type '.${ext || "(none)"}' (allowed: ${allowlist.join(", ")})`);
  }
}

// Reject fetch targets that could turn the publisher into an SSRF proxy: non-http(s) schemes and
// hosts that are the cloud metadata service or a literal loopback/link-local/private/unspecified IP.
// The catalog's manifest/asset URLs are PR-reviewed, so this is defense-in-depth (it does not resolve
// DNS, so a hostname pointing at a private IP is not caught — a heavier, rebinding-prone mitigation
// left out as disproportionate here), but it closes the concrete metadata-endpoint vector cheaply.
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata"]);
export function assertSafeFetchTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new VendorError(`'${url}' is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VendorError(`'${url}' uses a non-http(s) scheme`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // The cloud metadata service and its hostnames are always blocked (the crown-jewel SSRF target).
  if (host === "169.254.169.254" || BLOCKED_HOSTS.has(host)) {
    throw new VendorError(`fetching from metadata host '${host}' is blocked`);
  }
  // The broader loopback/link-local/private ranges are relaxed only when tests point the fetcher at a
  // localhost fixture server (production manifestRefs are public URLs, never these ranges).
  if (process.env.CATALOG_ALLOW_PRIVATE_FETCH === "1") return;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    const blocked =
      a === 0 || a === 127 || // unspecified / loopback
      (a === 169 && b === 254) || // link-local
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); // private
    if (blocked) throw new VendorError(`fetching from private/link-local address '${host}' is blocked`);
  } else if (host.includes(":")) {
    // IPv6 literal: block loopback (::1), unspecified (::), link-local (fe80::/10),
    // unique-local (fc00::/7), and IPv4-mapped private/loopback.
    if (host === "::1" || host === "::" || /^fe[89ab]/.test(host) || /^f[cd]/.test(host) || host.includes("127.0.0.1") || host.includes("169.254")) {
      throw new VendorError(`fetching from private/link-local address '${host}' is blocked`);
    }
  }
}

// Fetch a URL, streaming through a byte cap. Never trusts Content-Length for the cap: a chunked or
// header-less response is capped during the read, so a hostile or broken source can't force
// unbounded buffering. Retries transient network / 5xx / 429 failures; a cap breach, a 4xx, and an
// SSRF-blocked target are deterministic and are not retried.
export async function fetchCapped(url, maxBytes, { retries = 2, retryDelayMs = 300, fetchImpl = fetch } = {}) {
  assertSafeFetchTarget(url);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) {
        // Deterministic client errors (4xx other than 429) won't change on retry — fail fast.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new VendorError(`'${url}' returned HTTP ${response.status} ${response.statusText}`);
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.body) {
        // No stream to cap during read, so pre-check the declared length before buffering to avoid
        // an OOM on a huge body-less response, then re-check the actual size.
        const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        if (!Number.isNaN(declared) && declared > maxBytes) {
          throw new VendorError(`'${url}' exceeds the ${maxBytes}-byte cap (Content-Length: ${declared})`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
          throw new VendorError(`'${url}' exceeds the ${maxBytes}-byte cap`);
        }
        return buffer;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new VendorError(`'${url}' exceeds the ${maxBytes}-byte cap`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      // A cap breach won't change on retry — surface it immediately.
      if (error instanceof VendorError) throw error;
      lastError = error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
  }
  throw new VendorError(`failed to fetch '${url}': ${lastError?.message ?? lastError}`);
}

// Discover image references in a markdown document: inline `![alt](url)`, HTML `<img src>`,
// and reference-style `![alt][label]` / `![label][]` resolved against `[label]: url` definitions.
// A reference-style image whose label has no definition is a loud failure (dangling ref).
// Returns unique raw ref strings in document order; constructs the regexes don't recognize are,
// by design, a review-time concern rather than a silent skip.
export function discoverMarkdownImageRefs(markdown) {
  const refs = [];
  const seen = new Set();
  const add = (raw) => {
    let value = raw.trim();
    if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      refs.push(value);
    }
  };

  // Strip fenced (``` / ~~~) and inline (`…`) code first: an image-like example inside a code sample
  // is documentation, not a real asset, and must not be discovered (it would fail the build loudly).
  const scan = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]+`/g, "");

  // Reference-link definitions: `[label]: url "title"` at (indented) line start.
  const definitions = new Map();
  for (const match of scan.matchAll(/^[ \t]*\[([^\]]+)\]:\s*(<[^>]*>|\S+)/gm)) {
    definitions.set(match[1].trim().toLowerCase(), match[2]);
  }

  // Inline images: ![alt](url "title"), url optionally <bracketed>.
  for (const match of scan.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g)) {
    add(match[1]);
  }

  // HTML images: <img ... src="url" ...> (single or double quoted). Require whitespace before `src`
  // so `data-src`/`custom-src` lazy-loading attributes aren't mistaken for the real source.
  for (const match of scan.matchAll(/<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    add(match[1] ?? match[2] ?? "");
  }

  // Reference-style images: ![alt][label] (full) and ![label][] (collapsed). The second bracket is
  // required, which keeps this from misreading an inline ![alt](url) or a bare ![text]. Shortcut
  // form (![label] with no brackets) is intentionally out of scope — too ambiguous to detect safely.
  const usedLabels = new Set();
  for (const match of scan.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const label = (match[2].trim() || match[1].trim());
    if (label) usedLabels.add(label.toLowerCase());
  }
  for (const label of usedLabels) {
    const def = definitions.get(label);
    if (def === undefined) {
      throw new VendorError(`markdown references image label '[${label}]' with no matching definition`);
    }
    add(def);
  }

  return refs;
}

function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A prerelease sorts below its release (1.0.0-rc < 1.0.0).
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

// The manifestRef the storefront should vendor from: the feed's `stable` tag, else the
// highest listed version. Returns null for an empty/absent feed.
export function resolveStableManifestRef(feed) {
  const versions = Array.isArray(feed?.versions) ? feed.versions : [];
  if (versions.length === 0) return null;
  const stable = feed.tags?.stable;
  if (stable) {
    const hit = versions.find((v) => v.version === stable);
    if (hit) return hit.manifestRef ?? null;
  }
  const highest = [...versions].sort((x, y) => compareVersions(x.version, y.version)).pop();
  return highest?.manifestRef ?? null;
}
