// Builds the published storefront from the entries: dist/catalog.json plus the assets/feeds/schema it
// references, ready to upload to GitHub Pages. Dependency-free.
//
// Relative `display.icon`/`display.screenshots` (resolved against the entry folder) and a relative
// `releasesUrl` (resolved against the repo root) are rewritten to absolute URLs under --base-url so a
// browser and Hosty Core can fetch them. Absolute http(s) refs are left untouched.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_DIR, FEEDS_DIR, ROOT, SCHEMA_VERSION, isHttpUrl, listEntryDirs, readJson } from "./lib.mjs";

const DIST = join(ROOT, "dist");

function parseBaseUrl() {
  const arg = process.argv.find((value) => value.startsWith("--base-url="));
  const raw = (arg ? arg.slice("--base-url=".length) : process.env.CATALOG_BASE_URL) ?? "";
  return raw.replace(/\/+$/, "");
}

function main() {
  const base = parseBaseUrl();
  const abs = (path) => `${base}/${path.replace(/^\/+/, "")}`;
  const rewriteAsset = (id, value) => (value === undefined || isHttpUrl(value) ? value : abs(`apps/${id}/${value}`));

  const source = existsSync(join(ROOT, "catalog.source.json")) ? readJson(join(ROOT, "catalog.source.json")) : undefined;

  const apps = listEntryDirs().map(({ id, entryPath }) => {
    const entry = readJson(entryPath);
    const display = entry.display
      ? {
          ...entry.display,
          icon: rewriteAsset(id, entry.display.icon),
          screenshots: (entry.display.screenshots ?? []).map((shot) => rewriteAsset(id, shot)),
        }
      : undefined;
    const releasesUrl =
      entry.releasesUrl === undefined || isHttpUrl(entry.releasesUrl) ? entry.releasesUrl : abs(entry.releasesUrl);
    return { ...entry, ...(display ? { display } : {}), ...(releasesUrl ? { releasesUrl } : {}) };
  });

  const catalog = { schemaVersion: SCHEMA_VERSION, ...(source ? { source } : {}), apps };

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  // Copy the assets/feeds/schema the catalog points at so the published site is self-contained.
  cpSync(APPS_DIR, join(DIST, "apps"), { recursive: true, filter: (src) => !src.endsWith("entry.json") });
  if (existsSync(FEEDS_DIR)) {
    cpSync(FEEDS_DIR, join(DIST, "feeds"), { recursive: true });
  }
  if (existsSync(join(ROOT, "schema"))) {
    cpSync(join(ROOT, "schema"), join(DIST, "schema"), { recursive: true });
  }
  writeFileSync(join(DIST, "index.html"), landingPage(catalog, base));

  console.log(`Wrote dist/catalog.json with ${apps.length} app(s)${base ? ` (base ${base})` : ""}.`);
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
    <p>Point Hosty Core at it with <code>HOSTY_CATALOG_SOURCES</code>.</p>
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

main();
