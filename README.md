# Hosty Catalog

The official marketplace catalog for [Hosty](https://github.com/alex-de-haas/docker-host) runtime apps.

It is a **discovery + trust index over existing transport** — not a new way to ship apps. Every entry
holds **metadata and pointers only**; an app's manifest and artifact live in the author's own
repo/registry. The catalog never contains app code. Adding an app is a reviewed pull request; new
**releases** of an already-listed app flow through its **feeds** — named pointers at moving manifest
refs (typically branch raw URLs) that the app owns in its own `feeds.json` — so releasing is just
pushing to the branch, with no catalog PR. The entry only points at that file via `feedsUrl`.

Schema: `marketplace.0.2`. Zero servers — a Git repo plus GitHub Actions that publish a single
`catalog.json` to GitHub Pages.

## How Hosty consumes it

The optional first-party **`hosty.marketplace`** system app reads one catalog source and serves the
storefront to the Shell:

```bash
# The Marketplace app's single source setting (its official default is this catalog):
HOSTY_MARKETPLACE_SOURCE_URL=https://alex-de-haas.github.io/hosty-catalog/catalog.json
```

The Shell renders the storefront under **Marketplace**. Choosing an app hands its `feedsUrl` to the
Shell, which opens Core's existing reviewed install flow: Core independently fetches and validates the
app's `feeds.json`, resolves the selected feed's manifest, and installs it — the catalog and the
Marketplace app install nothing themselves. The marketplace is opt-in: with no source configured the
storefront is simply empty, and nothing changes for apps installed by other means.

## Repository layout

```
apps/<reverse-dns-id>/
  entry.json          # the catalog entry (metadata + feedsUrl) — see schema/entry.schema.json
  assets/             # optional hand-hosted icon/screenshots (prefer manifest catalogMetadata — see Display assets)
catalog.source.json   # this source's display metadata (name/description/url)
schema/               # marketplace.0.2 JSON Schemas (entry / catalog)
scripts/              # generate-catalog.mjs, validate.mjs, vendor.test.mjs (dependency-free Node)
```

CI generates `catalog.json` from every `apps/<id>/entry.json` — **never hand-edit `catalog.json`**.

## Submitting an app

Open the [**Submit an app**](../../issues/new?template=app-submission.yml) issue, or send a PR directly:

1. Create `apps/<reverse-dns-id>/entry.json`. The `id` must match your manifest's id, the reverse-DNS
   format `^[a-z0-9][a-z0-9._-]{0,62}$`, and the folder name.
2. Declare `feedsUrl` — the absolute URL of your app repository's `feeds.json` (the app owns its
   feeds; see [Feeds](#feeds-releases-without-a-catalog-pr)). Provide display assets — **preferably
   from your app repo** (see [Display assets](#display-assets)).
3. Open a PR. CI validates the entry; a maintainer reviews the capabilities, external mounts, and
   publisher identity declared by your manifest — a one-time trust gate.

Minimal entry:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "publisher": { "name": "Example Co", "url": "https://example.com" },
  "category": "Productivity",
  "tags": ["notes"],
  "display": { "summary": "Take notes.", "icon": "assets/icon.svg" },
  "feedsUrl": "https://raw.githubusercontent.com/example/notes/main/feeds.json"
}
```

### Feeds (releases without a catalog PR)

Your app **owns its feeds** in a `feeds.json` (schema `app-feeds.0.1`) in its own repository; the
catalog entry only points at it via `feedsUrl`. A **feed** is a named pointer at your manifest at a
**moving ref** — releasing is pushing to that ref, so the catalog is never PRed for a release. The
manifest's own `version` is informational display metadata; Hosty detects updates by comparing
**content digests** (manifest and artifact), so a forgotten version bump never blocks delivery.
Declare several feeds for several tracks and mark the one quick-install should use:

```json
{
  "schemaVersion": "app-feeds.0.1",
  "appId": "com.example.notes",
  "feeds": [
    { "id": "main", "manifestRef": "https://raw.githubusercontent.com/example/notes/main/manifest.json", "default": true },
    { "id": "beta", "manifestRef": "https://raw.githubusercontent.com/example/notes/develop/manifest.json" }
  ]
}
```

The feed document's `appId` must equal your manifest's id (Core rejects a mismatch at install).
`default: true` is required only when several feeds are declared (at most one; feed order carries no
meaning). Feed quality is the author's responsibility: a broken branch can't ship a docker image (the
build fails, the last published image stays current), and source runtimes are gated by your own CI.
Rolling back a bad release is `git revert` — the changed head surfaces as a normal update.

## Display assets

The **app repository is the source of truth for display assets** — the app's own manifest declares them
under `catalogMetadata`, alongside the code they describe:

```jsonc
// manifest.json (in your app repo)
"catalogMetadata": {
  "icon": "assets/icon.svg",              // manifest-relative path (or an https URL)
  "screenshots": ["assets/1.png"],
  "descriptionFile": "docs/store.md"      // markdown long-description; images it references are vendored too
}
```

At publish, the catalog fetches your manifest (at the default-or-sole feed's head), then **vendors** the
declared assets — icon, screenshots, and the `descriptionFile` plus every relative image it references —
into the published site under `apps/<id>/vendored/…`. This keeps the storefront self-contained and frozen
at review time (no hotlinking to mutable author URLs), while you keep editing assets in your own repo.
Everything served stays **within your manifest's folder**; a ref that escapes it, can't be fetched, is
too large, or has a disallowed type fails the publish build. The vendored markdown is byte-identical to
your source (Hosty resolves its relative image links at render time).

`descriptionFile` must be markdown (`.md`); assets must be `svg/png/webp/jpg/jpeg/gif/avif`. External
absolute image URLs inside a description are rendered as links, not inlined.

**Hand-hosted `apps/<id>/assets/` in this repo still works** and a hand-authored `entry.display` field
overrides the manifest (curation wins) — but it is discouraged for apps that have a public repo: prefer
`catalogMetadata` so there is a single source of truth and version bumps carry asset changes automatically.

## Local development

Dependency-free (Node 18+). No install step:

```bash
node scripts/validate.mjs      # validate every entry (the PR gate)
node scripts/vendor.test.mjs   # test the generator + vendoring helpers
node scripts/generate-catalog.mjs --base-url=https://alex-de-haas.github.io/hosty-catalog
# → dist/catalog.json + copied assets/schema + a landing page (offline; entry.display only)

node scripts/generate-catalog.mjs --vendor --base-url=…   # full build: also vendor manifest assets (hits the network)
```

`--vendor` (also `npm run generate:vendor`) is what produces the real storefront — fetching each app's
manifest and its declared assets. Run it to self-check a submission before opening a PR. Without it,
`generate` is offline and uses only `entry.display`, so the PR gate and quick local runs stay hermetic.

Vendoring only fetches public `http(s)` URLs and refuses cloud-metadata / loopback / private-range
targets (SSRF defense-in-depth). To self-check against a **localhost** fixture server, set
`CATALOG_ALLOW_PRIVATE_FETCH=1` (test-only; the metadata endpoint stays blocked).

## Publishing

`.github/workflows/validate.yml` gates every PR: it validates entries, runs the tooling tests, and does an
**offline** generate build check (no `--vendor`, so an unrelated PR is never blocked by another app repo's
state). On merge to `main`, `.github/workflows/publish.yml` regenerates `catalog.json` **with `--vendor`**
— rewriting relative asset paths to absolute `https://<owner>.github.io/<repo>/…` URLs and vendoring
each app's manifest-level display assets (see [Display assets](#display-assets)) — then deploys `dist/` to
GitHub Pages. Vendoring fails the build on any declared-asset problem; a failed build leaves the last good
deploy live. Enable Pages once under **Settings → Pages → Source: GitHub Actions**.

## Trust

The catalog vouches for a publisher's signing identity once (the reviewed membership PR); an entry
records it as `signerIdentity`. Cryptographic verification of the index (ECDsa P-256) is a planned
follow-up — until then trust rests on the PR review plus Core's install-time review of the manifest's
capabilities and mounts. Feeds move *where the pointer points*, not *who is trusted*: the entry (and
its feed refs) is PR-gated; what the author pushes behind a ref is theirs, exactly like the registry
image behind a tag.

## See also

- [Runtime App Marketplace design](https://github.com/alex-de-haas/docker-host/blob/main/docs/features/runtime-app-marketplace.md)
- Hosty Core reads this via `CatalogService` / `GET /api/catalog/*`.
