# Connector brand icons — compliance policy

## Purpose

Brand marks in the connector marketplace are for **product identification only**
(recognize GitHub / Notion / …). They must not imply partnership, endorsement,
or that TabTin is an official client of that brand.

## Allowed sources

1. Official brand / logo / press pages linked from each manifest entry (`source`, `guidelines`).
2. Geometry vendored through a reviewed channel (currently Simple Icons path data),
   with the official source URL recorded — not “random website favicon”.

## Forbidden

- Scraping favicons or CDN URLs at runtime.
- Shipping an unreviewed full Simple Icons bundle.
- Using marks in marketing that implies affiliation.
- Shipping a mark when `status` is not `approved`.

## Adding a brand

1. Clear `source` / `guidelines` (or explicit license).
2. Add SVG under `icons/<key>.svg` and set `status: approved` + `file`.
3. Fill `match.ids|hosts|names|npm` so the resolver can find it without UI hardcoding.
4. Run package tests. Do **not** edit marketplace card components for a new brand.

## Deferred

Entries with `status: deferred` stay in the registry for matching documentation
but resolve to no icon (UI shows the generic Plug).

## Matching rules (host)

Host matching uses **MCP endpoint URL only**. Do not match on `docsUrl` /
`credentialUrl` — those often point at GitHub READMEs or vendor consoles and
will false-positive (e.g. Tonghuashun docs on github.com ≠ GitHub connector).

## Visual form

Prefer **official icon marks** (square glyphs from brand kits / maintained
logo packs such as gilbarbara/logos icon variants), not DIY recolors of
monochrome paths and not wide wordmarks.

Marketplace UI uses a **single** muted rounded chip for brand marks and the
Plug fallback alike — do not nest a second white plate (and strip any baked
white plate from assets like Notion’s app mark when compositing into the chip).

Identification use only. Re-run
`pnpm icons:raster` + `bash scripts/sync-connector-brand-icons.sh` after
replacing SVGs.
