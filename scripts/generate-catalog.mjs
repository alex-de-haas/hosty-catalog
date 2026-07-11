// Builds the published storefront from the entries: dist/catalog.json plus the assets/schema it
// references, ready to upload to GitHub Pages. Dependency-free.
//
// Relative `display.icon`/`display.screenshots` (resolved against the entry folder) are rewritten to
// absolute URLs under --base-url so a browser and Hosty Core can fetch them. Absolute http(s) refs
// are left untouched. `feedsUrl` passes through as-is: it is an absolute URL by contract.
//
// With --vendor, the generator additionally fetches the app's feeds.json (via the entry's feedsUrl),
// picks its vendor feed (the default-flagged feed, else the sole one), fetches that manifest, and
// vendors the manifest-level display assets it
// declares — icon, screenshots, and a markdown descriptionFile plus the images that description
// references — into dist/apps/<id>/vendored/, so the app repository is the source of truth while the
// published storefront stays self-contained (no hotlinking). A hand-authored entry.display field
// overrides the manifest (curation wins). Vendoring hits the network and fails loudly, so it is
// opt-in: CI's build check runs without it, and publish runs with it. See README "Publishing".

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  APPS_DIR,
  DESCRIPTION_EXTENSIONS,
  DESCRIPTION_MAX_BYTES,
  ICON_MAX_BYTES,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  PER_APP_MAX_BYTES,
  PER_APP_MAX_FILES,
  ROOT,
  SCHEMA_VERSION,
  SCREENSHOT_MAX_BYTES,
  VendorError,
  assertAllowedExtension,
  containedRelativePath,
  discoverMarkdownImageRefs,
  fetchCapped,
  isHttpUrl,
  listEntryDirs,
  manifestFolderBase,
  readJson,
  resolveContainedRef,
  resolveVendorManifestRef,
} from "./lib.mjs";

const DIST = join(ROOT, "dist");
const MANIFEST_MAX_BYTES = 1 * 1024 * 1024;

function parseBaseUrl() {
  const arg = process.argv.find((value) => value.startsWith("--base-url="));
  const raw = (arg ? arg.slice("--base-url=".length) : process.env.CATALOG_BASE_URL) ?? "";
  return raw.replace(/\/+$/, "");
}

// Tracks a single app's vendoring budget and writes fetched bytes under dist/apps/<id>/vendored/.
// `root` is the app's manifest folder (the asset root): the published path always mirrors a file's
// path relative to that root — never relative to a description's subfolder — so a vendored markdown
// file resolves its own relative images (including ../ into a sibling folder) without any rewriting.
function makeVendorSink(id, base, root) {
  let files = 0;
  let bytes = 0;
  return {
    // Fetch `ref` (resolved against `resolveBase`, contained under `root`), write it, return its URL.
    async vendor(ref, { maxBytes, allowlist, resolveBase = root }) {
      assertAllowedExtension(ref, allowlist);
      const url = resolveContainedRef(resolveBase, ref, root);
      const relPath = containedRelativePath(root, url);
      const data = await fetchCapped(url, maxBytes);
      files += 1;
      bytes += data.byteLength;
      if (files > PER_APP_MAX_FILES) {
        throw new VendorError(`vendors more than ${PER_APP_MAX_FILES} files`);
      }
      if (bytes > PER_APP_MAX_BYTES) {
        throw new VendorError(`vendored assets exceed ${PER_APP_MAX_BYTES} bytes in total`);
      }
      const dest = join(DIST, "apps", id, "vendored", relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      return { publishedUrl: `${base}/apps/${id}/vendored/${relPath}`, data };
    },
  };
}

// Vendor a manifest's display assets for one app. Returns the manifest-sourced display fields
// (icon / screenshots / summary / descriptionUrl); entry.display overrides are applied by the caller.
async function vendorManifestAssets(id, manifestRef, base) {
  const manifest = JSON.parse((await fetchCapped(manifestRef, MANIFEST_MAX_BYTES)).toString("utf8"));
  // A malformed manifest can parse to null or a non-object (e.g. a bare string/number) — guard before
  // reading properties so it degrades to "no manifest assets" instead of a TypeError crash.
  if (!manifest || typeof manifest !== "object") return {};
  const meta = manifest.catalogMetadata;
  if (!meta || typeof meta !== "object") return {};

  const folderBase = manifestFolderBase(manifestRef);
  const sink = makeVendorSink(id, base, folderBase);
  const out = {};

  if (typeof meta.icon === "string" && meta.icon.length > 0) {
    out.icon = isHttpUrl(meta.icon)
      ? meta.icon
      : (await sink.vendor(meta.icon, { maxBytes: ICON_MAX_BYTES, allowlist: IMAGE_EXTENSIONS })).publishedUrl;
  }

  if (Array.isArray(meta.screenshots) && meta.screenshots.length > 0) {
    out.screenshots = [];
    for (const shot of meta.screenshots) {
      if (typeof shot !== "string" || shot.length === 0) {
        throw new VendorError("screenshot entries must be non-empty strings");
      }
      out.screenshots.push(
        isHttpUrl(shot)
          ? shot
          : (await sink.vendor(shot, { maxBytes: SCREENSHOT_MAX_BYTES, allowlist: IMAGE_EXTENSIONS })).publishedUrl,
      );
    }
  }

  if (typeof meta.summary === "string" && meta.summary.length > 0) {
    out.summary = meta.summary;
  }

  if (typeof meta.descriptionFile === "string" && meta.descriptionFile.length > 0) {
    if (isHttpUrl(meta.descriptionFile)) {
      throw new VendorError(`descriptionFile must be a manifest-relative path, not an absolute URL (${meta.descriptionFile})`);
    }
    const { publishedUrl, data } = await sink.vendor(meta.descriptionFile, {
      maxBytes: DESCRIPTION_MAX_BYTES,
      allowlist: DESCRIPTION_EXTENSIONS,
    });
    out.descriptionUrl = publishedUrl;
    // The description resolves its own relative images against its own folder; they are still contained
    // under the manifest folder (so ../assets/icon.svg into a sibling folder is fine) and vendored at
    // their manifest-folder-relative path, keeping the relationship intact. Absolute refs are left for
    // the renderer to show as links (no hotlinking of author-mutable images into the storefront).
    const descResolveBase = manifestFolderBase(resolveContainedRef(folderBase, meta.descriptionFile));
    for (const ref of discoverMarkdownImageRefs(data.toString("utf8"))) {
      if (isHttpUrl(ref)) continue;
      if (ref.startsWith("#") || ref.startsWith("data:")) continue;
      await sink.vendor(ref, { maxBytes: IMAGE_MAX_BYTES, allowlist: IMAGE_EXTENSIONS, resolveBase: descResolveBase });
    }
  }

  return out;
}

async function buildApp({ id, entryPath }, { base, vendor }) {
  const entry = readJson(entryPath);
  const abs = (path) => `${base}/${path.replace(/^\/+/, "")}`;
  const rewriteEntryAsset = (value) => (value === undefined || isHttpUrl(value) ? value : abs(`apps/${id}/${value}`));

  // Hand-authored entry.display, with relative asset paths rewritten to published URLs.
  const entryDisplay = entry.display ?? {};
  const handIcon = rewriteEntryAsset(entryDisplay.icon);
  const handShots = (entryDisplay.screenshots ?? []).map(rewriteEntryAsset);

  // Manifest-level assets (vendored) fill whatever the entry doesn't override.
  let manifest = {};
  if (vendor) {
    let manifestRef;
    try {
      manifestRef = await resolveVendorManifestRef(entry);
    } catch (error) {
      throw new VendorError(`${id}: could not resolve a manifest to vendor from: ${error.message}`);
    }
    if (manifestRef) {
      try {
        manifest = await vendorManifestAssets(id, manifestRef, base);
      } catch (error) {
        throw new VendorError(`${id}: vendoring failed (${manifestRef}): ${error.message}`);
      }
    }
  }

  // Per-field precedence: a hand-authored entry.display value wins; the manifest fills the gaps.
  const icon = entryDisplay.icon !== undefined ? handIcon : manifest.icon;
  const screenshots = entryDisplay.screenshots !== undefined ? handShots : manifest.screenshots;
  const summary = entryDisplay.summary ?? manifest.summary;
  const descriptionUrl = manifest.descriptionUrl;

  const display = {};
  if (summary !== undefined) display.summary = summary;
  if (icon !== undefined) display.icon = icon;
  if (screenshots !== undefined) display.screenshots = screenshots;
  if (descriptionUrl !== undefined) display.descriptionUrl = descriptionUrl;

  return {
    ...entry,
    ...(Object.keys(display).length > 0 ? { display } : {}),
  };
}

async function main() {
  const base = parseBaseUrl();
  const vendor = process.argv.includes("--vendor");
  const source = existsSync(join(ROOT, "catalog.source.json")) ? readJson(join(ROOT, "catalog.source.json")) : undefined;

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Copy the hand-hosted assets/schema the catalog points at (vendored/ is written on top).
  // Exclude only files named exactly entry.json — not e.g. a legitimate asset like custom-entry.json.
  cpSync(APPS_DIR, join(DIST, "apps"), { recursive: true, filter: (src) => src.split(sep).pop() !== "entry.json" });
  if (existsSync(join(ROOT, "schema"))) {
    cpSync(join(ROOT, "schema"), join(DIST, "schema"), { recursive: true });
  }

  const apps = [];
  for (const entry of listEntryDirs()) {
    apps.push(await buildApp(entry, { base, vendor }));
  }

  const catalog = { schemaVersion: SCHEMA_VERSION, ...(source ? { source } : {}), apps };
  writeFileSync(join(DIST, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(DIST, "index.html"), landingPage(catalog, base));

  console.log(
    `Wrote dist/catalog.json with ${apps.length} app(s)${base ? ` (base ${base})` : ""}${vendor ? " [vendored manifest assets]" : ""}.`,
  );
}

function landingPage(catalog, base) {
  const rows = catalog.apps
    .map((app) => `<li><strong>${escapeHtml(app.name ?? app.id)}</strong> <code>${escapeHtml(app.id)}</code>${app.category ? ` — ${escapeHtml(app.category)}` : ""}</li>`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hosty Catalog</title>
    <style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#111}code{background:#f2f2f2;padding:.1em .35em;border-radius:.25rem}a{color:#4f46e5}</style>
  </head>
  <body>
    <h1>Hosty Catalog</h1>
    <p>Machine-readable index: <a href="${base ? `${base}/catalog.json` : "catalog.json"}">catalog.json</a> (schema <code>${escapeHtml(catalog.schemaVersion)}</code>).</p>
    <p>Point the Hosty Marketplace app at it with <code>HOSTY_MARKETPLACE_SOURCE_URL</code>.</p>
    <h2>${catalog.apps.length} app(s)</h2>
    <ul>
      ${rows || "<li>(none yet)</li>"}
    </ul>
    <p>See the <a href="https://github.com/alex-de-haas/hosty-catalog">repository</a> to submit an app.</p>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

main().catch((error) => {
  console.error(`error    ${error instanceof VendorError ? error.message : error.stack ?? error}`);
  process.exit(1);
});
