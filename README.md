# Hosty Catalog

The official marketplace catalog for [Hosty](https://github.com/alex-de-haas/docker-host) runtime apps.

It is a **discovery + trust index over existing transport** — not a new way to ship apps. Every entry
holds **metadata and pointers only**; an app's manifest and artifact live in the author's own
repo/registry. The catalog never contains app code. Adding an app is a reviewed pull request; new
**versions** of an already-listed app flow through an author-owned feed with no catalog PR.

Schema: `marketplace.0.1`. Zero servers — a Git repo plus GitHub Actions that publish a single
`catalog.json` to GitHub Pages.

## How Hosty consumes it

Hosty Core reads one or more catalog sources and serves the storefront to the Shell:

```bash
# Point Core at the published index (comma-separated, highest priority first):
HOSTY_CATALOG_SOURCES=https://alex-de-haas.github.io/hosty-catalog/catalog.json
```

Core exposes `GET /api/catalog/apps` and `/api/catalog/apps/{id}` (host-admin, read-only) and the Shell
renders them under **Marketplace**. Installing a version hands its `manifestRef` to Core's existing
reviewed install flow — the catalog installs nothing itself. The marketplace is opt-in: with no source
configured the storefront is simply empty, and nothing changes for apps installed by other means.

## Repository layout

```
apps/<reverse-dns-id>/
  entry.json          # the catalog entry (metadata + pointers) — see schema/entry.schema.json
  assets/             # optional icon / screenshots referenced by entry.display
feeds/<id>.json       # optional repo-hosted version feed (authors may host their own instead)
catalog.source.json   # this source's display metadata (name/description/url)
schema/               # marketplace.0.1 JSON Schemas (entry / catalog / feed)
scripts/              # generate-catalog.mjs, validate.mjs (dependency-free Node)
```

CI generates `catalog.json` from every `apps/<id>/entry.json` — **never hand-edit `catalog.json`**.

## Submitting an app

Open the [**Submit an app**](../../issues/new?template=app-submission.yml) issue, or send a PR directly:

1. Create `apps/<reverse-dns-id>/entry.json`. The `id` must match your manifest's id, the reverse-DNS
   format `^[a-z0-9][a-z0-9._-]{0,62}$`, and the folder name.
2. Point `releasesUrl` at your version feed (an https URL you host, or a repo-relative `feeds/<id>.json`
   here). Drop an `assets/icon.svg` (or use an https `display.icon`).
3. Open a PR. CI validates the entry (and any repo-hosted feed); a maintainer reviews the capabilities,
   external mounts, and publisher identity declared by your manifest — a one-time trust gate.

Minimal entry:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "publisher": { "name": "Example Co", "url": "https://example.com" },
  "category": "Productivity",
  "tags": ["notes"],
  "display": { "summary": "Take notes.", "icon": "assets/icon.svg" },
  "releasesUrl": "https://example.com/hosty/releases.json"
}
```

### The version feed (releases without a catalog PR)

`releasesUrl` points at an author-owned feed. New releases land there, so you never PR the catalog for a
version bump. The feed is **runtime-agnostic** — a version points at a manifest and carries an optional,
discriminated artifact identity (image digest / source commit / prebuilt hash), so `docker` and
`localCommand`/source apps are both first-class:

```json
{
  "versions": [
    { "version": "0.3.1", "manifestRef": "https://example.com/app/0.3.1/manifest.json", "artifact": { "kind": "image", "imageDigest": "sha256:…" } },
    { "version": "1.4.0", "manifestRef": "https://example.com/app/manifest.json", "artifact": { "kind": "source", "commit": "abc123", "ref": "refs/tags/v1.4.0" } }
  ],
  "tags": { "stable": "0.3.1" }
}
```

`artifact` is optional — Core re-resolves it at install from the manifest's declared runtime.

## Local development

Dependency-free (Node 18+). No install step:

```bash
node scripts/validate.mjs      # validate every entry + repo-hosted feed (the PR gate)
node scripts/generate-catalog.mjs --base-url=https://alex-de-haas.github.io/hosty-catalog
# → dist/catalog.json + copied assets/feeds/schema + a landing page
```

## Publishing

`.github/workflows/validate.yml` gates every PR. On merge to `main`,
`.github/workflows/publish.yml` regenerates `catalog.json` (rewriting relative asset/feed paths to
absolute `https://<owner>.github.io/<repo>/…` URLs) and deploys `dist/` to GitHub Pages. Enable Pages
once under **Settings → Pages → Source: GitHub Actions**.

## Trust

The catalog vouches for a publisher's signing identity once (the reviewed membership PR); an entry
records it as `signerIdentity`. Cryptographic verification of the index and feeds (ECDsa P-256) is a
planned follow-up — until then trust rests on the PR review plus Core's install-time review of the
manifest's capabilities and mounts.

## See also

- [Runtime App Marketplace design](https://github.com/alex-de-haas/docker-host/blob/main/docs/features/runtime-app-marketplace.md)
- Hosty Core reads this via `CatalogService` / `GET /api/catalog/*`.
