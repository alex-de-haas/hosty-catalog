// Tests for the publish-time asset vendoring (generate-catalog.mjs --vendor) and its helpers.
// Dependency-free: a local http server stands in for an app repo, and the generator runs as a
// child process against a fixture catalog root. Run with `node scripts/vendor.test.mjs`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VendorError,
  assertAllowedExtension,
  containedRelativePath,
  discoverMarkdownImageRefs,
  fetchCapped,
  manifestFolderBase,
  resolveContainedRef,
  resolveStableManifestRef,
  IMAGE_EXTENSIONS,
} from "./lib.mjs";

const GENERATE = fileURLToPath(new URL("./generate-catalog.mjs", import.meta.url));

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

// --- Pure helpers ---------------------------------------------------------

await test("resolveContainedRef accepts an in-folder ref", () => {
  const base = manifestFolderBase("https://h/apps/demo/manifest.json");
  assert.equal(resolveContainedRef(base, "assets/icon.svg"), "https://h/apps/demo/assets/icon.svg");
});

await test("resolveContainedRef rejects a parent-escaping ref", () => {
  const base = manifestFolderBase("https://h/apps/demo/manifest.json");
  assert.throws(() => resolveContainedRef(base, "../other/icon.svg"), VendorError);
});

await test("resolveContainedRef rejects a sibling-prefix ref", () => {
  const base = manifestFolderBase("https://h/apps/demo/manifest.json");
  // /apps/demo/ must not match /apps/demo-evil/ — the trailing slash guards this.
  assert.throws(() => resolveContainedRef(base, "../demo-evil/icon.svg"), VendorError);
});

await test("resolveContainedRef rejects a cross-origin ref", () => {
  const base = manifestFolderBase("https://h/apps/demo/manifest.json");
  assert.throws(() => resolveContainedRef(base, "https://evil/icon.svg"), VendorError);
});

await test("resolveContainedRef allows a sibling-folder ref within the manifest root", () => {
  const root = manifestFolderBase("https://h/apps/demo/manifest.json");
  const descBase = manifestFolderBase("https://h/apps/demo/docs/store.md");
  // A description in docs/ may reach ../assets/ — still inside the app's manifest folder.
  assert.equal(resolveContainedRef(descBase, "../assets/icon.svg", root), "https://h/apps/demo/assets/icon.svg");
  // But not past the manifest folder itself.
  assert.throws(() => resolveContainedRef(descBase, "../../other/icon.svg", root), VendorError);
});

await test("containedRelativePath returns the folder-relative subpath", () => {
  const base = manifestFolderBase("https://h/apps/demo/manifest.json");
  const url = resolveContainedRef(base, "docs/img/a.png");
  assert.equal(containedRelativePath(base, url), "docs/img/a.png");
});

await test("assertAllowedExtension enforces the allowlist", () => {
  assertAllowedExtension("assets/icon.svg", IMAGE_EXTENSIONS);
  assert.throws(() => assertAllowedExtension("assets/icon.bmp", IMAGE_EXTENSIONS), VendorError);
});

await test("discoverMarkdownImageRefs finds inline, html, and reference images", () => {
  const md = [
    "# Title",
    "![inline](./a.png)",
    '<img src="b.png" alt="x">',
    "![ref][shot]",
    "",
    "[shot]: ./docs/c.png",
    "[external]: https://example.com/skip.png",
  ].join("\n");
  const refs = discoverMarkdownImageRefs(md);
  assert.deepEqual(new Set(refs), new Set(["./a.png", "b.png", "./docs/c.png"]));
});

await test("discoverMarkdownImageRefs throws on a dangling reference label", () => {
  assert.throws(() => discoverMarkdownImageRefs("![missing][nope]\n"), VendorError);
});

await test("resolveStableManifestRef prefers the stable tag, else the highest version", () => {
  assert.equal(
    resolveStableManifestRef({ versions: [{ version: "0.1.0", manifestRef: "a" }, { version: "0.2.0", manifestRef: "b" }], tags: { stable: "0.1.0" } }),
    "a",
  );
  assert.equal(
    resolveStableManifestRef({ versions: [{ version: "0.1.0", manifestRef: "a" }, { version: "0.10.0", manifestRef: "b" }, { version: "0.2.0", manifestRef: "c" }] }),
    "b",
  );
  assert.equal(resolveStableManifestRef({ versions: [] }), null);
});

// --- Local server + capped fetch -----------------------------------------

const appRepo = mkdtempSync(join(tmpdir(), "hosty-apprepo-"));
const catalogHappy = mkdtempSync(join(tmpdir(), "hosty-catalog-happy-"));
const catalogEvil = mkdtempSync(join(tmpdir(), "hosty-catalog-evil-"));

function writeFixture(root, relPath, content) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

// App repo served over http (stands in for raw.githubusercontent.com/.../apps/...).
// The description lives in a subfolder and references a sibling asset via ../ — the case that
// distinguishes "contained under the manifest folder" from "contained under the description folder".
const STORE = "# Demo\n\n![up](../assets/1.png)\n\n<img src=\"./shot.png\" alt=\"s\">\n";
writeFixture(appRepo, "apps/demo/manifest.json", JSON.stringify({
  schemaVersion: "app.0.1",
  id: "com.haas.demo",
  catalogMetadata: {
    summary: "From the manifest.",
    icon: "assets/icon.svg",
    screenshots: ["assets/1.png"],
    descriptionFile: "docs/store.md",
  },
}));
writeFixture(appRepo, "apps/demo/assets/icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
writeFixture(appRepo, "apps/demo/assets/1.png", Buffer.from("png-one"));
writeFixture(appRepo, "apps/demo/docs/shot.png", Buffer.from("png-shot"));
writeFixture(appRepo, "apps/demo/docs/store.md", STORE);

// An app whose description escapes the manifest folder — publish must fail loudly.
writeFixture(appRepo, "apps/evil/manifest.json", JSON.stringify({
  schemaVersion: "app.0.1",
  id: "com.haas.evil",
  catalogMetadata: { descriptionFile: "README.md" },
}));
writeFixture(appRepo, "apps/evil/README.md", "![escape](../../secret.png)\n");
writeFixture(appRepo, "big.bin", Buffer.alloc(100, 1));

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  try {
    res.end(readFileSync(join(appRepo, path)));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await test("fetchCapped streams within the cap and aborts past it", async () => {
  const ok = await fetchCapped(`${origin}/big.bin`, 200);
  assert.equal(ok.byteLength, 100);
  await assert.rejects(fetchCapped(`${origin}/big.bin`, 50), VendorError);
});

// --- End-to-end generate --vendor ----------------------------------------

// Async spawn (not spawnSync): the app-repo http server lives in this same process, so the parent
// event loop must stay free to serve the child generator's fetches.
function runGenerate(catalogRoot, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GENERATE, "--vendor", `--base-url=${base}`], {
      env: { ...process.env, CATALOG_ROOT: catalogRoot },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

await test("generate --vendor vendors manifest assets and a byte-identical description", async () => {
  writeFixture(catalogHappy, "apps/com.haas.demo/entry.json", JSON.stringify({
    id: "com.haas.demo",
    name: "Demo",
    releasesUrl: "feeds/com.haas.demo.json",
  }));
  writeFixture(catalogHappy, "feeds/com.haas.demo.json", JSON.stringify({
    versions: [{ version: "0.1.0", manifestRef: `${origin}/apps/demo/manifest.json` }],
    tags: { stable: "0.1.0" },
  }));

  const base = "https://example.test/hosty-catalog";
  const result = await runGenerate(catalogHappy, base);
  assert.equal(result.status, 0, `generate failed: ${result.stderr}`);

  const dist = join(catalogHappy, "dist");
  // Description is vendored byte-for-byte at its manifest-folder-relative path.
  assert.equal(readFileSync(join(dist, "apps/com.haas.demo/vendored/docs/store.md"), "utf8"), STORE);
  // Its images are vendored at their manifest-folder-relative paths: ./shot.png stays in docs/,
  // ../assets/1.png lands in assets/ — so the byte-identical markdown resolves both at render time.
  assert.equal(readFileSync(join(dist, "apps/com.haas.demo/vendored/docs/shot.png"), "utf8"), "png-shot");
  assert.equal(readFileSync(join(dist, "apps/com.haas.demo/vendored/assets/1.png"), "utf8"), "png-one");
  // The icon is vendored and pointed at by the published URL.
  assert.equal(readFileSync(join(dist, "apps/com.haas.demo/vendored/assets/icon.svg"), "utf8").startsWith("<svg"), true);

  const catalog = JSON.parse(readFileSync(join(dist, "catalog.json"), "utf8"));
  const display = catalog.apps[0].display;
  assert.equal(display.icon, `${base}/apps/com.haas.demo/vendored/assets/icon.svg`);
  assert.equal(display.descriptionUrl, `${base}/apps/com.haas.demo/vendored/docs/store.md`);
  assert.equal(display.summary, "From the manifest.");
  assert.deepEqual(display.screenshots, [`${base}/apps/com.haas.demo/vendored/assets/1.png`]);
});

await test("generate --vendor fails loudly when a description image escapes the folder", async () => {
  writeFixture(catalogEvil, "apps/com.haas.evil/entry.json", JSON.stringify({
    id: "com.haas.evil",
    name: "Evil",
    releasesUrl: "feeds/com.haas.evil.json",
  }));
  writeFixture(catalogEvil, "feeds/com.haas.evil.json", JSON.stringify({
    versions: [{ version: "0.1.0", manifestRef: `${origin}/apps/evil/manifest.json` }],
    tags: { stable: "0.1.0" },
  }));

  const result = await runGenerate(catalogEvil, "https://example.test");
  assert.notEqual(result.status, 0, "expected a non-zero exit");
  assert.match(result.stderr, /escapes the app's manifest folder/);
});

// --- teardown -------------------------------------------------------------

server.close();
for (const dir of [appRepo, catalogHappy, catalogEvil]) {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll vendoring tests passed.");
