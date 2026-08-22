# Releasing

[中文](RELEASING.md)

TabTin has one product version line. Tags in the public repository mark which product version a source tree corresponds to. They do not replace the official release pipeline.

```
Product version 1.1.2
├── Official: existing clients / update channel / hosted backend
└── Community: public tag v1.1.2 = this source corresponds to product 1.1.2
```

## Version contract

- Public stable versions use `vMAJOR.MINOR.PATCH` only, for example `v1.1.2`.
- Prereleases may use a hyphenated tag such as `v1.1.3-rc.1`. Mark the GitHub Release as a prerelease and do not mark it latest.
- Do not start a separate `v0.1.0` community line, and do not add a second `desktop-v…` line.
- Do not backfill `v1.0.0` … `v1.1.1`. Public history starts at the first public tag.
- The product number is `apps/tabtin-electron/package.json#version`. The root `package.json`, Android `versionName`, and iOS `MARKETING_VERSION` must use the same number. Internal packages may keep their own package versions.

## Who can release

Only maintainers may push release tags and create GitHub Releases. External contributors should not create tags.

## Cut a release

1. Confirm the public tree is the open-source slice of that product version, or that the docs clearly say what was removed. If it does not match, wait for the next version. Do not tag first.
2. Move verified `[Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md` and `CHANGELOG.en.md`.
3. Set the product version fields to `X.Y.Z` and merge that change to `main` through a pull request.
4. Create an annotated tag on that commit and push only the tag:

   ```bash
   git tag -a vX.Y.Z -m "TabTin X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Create a GitHub Release from the tag. The notes should describe the community snapshot: what runs, and how it differs from the official product. Do not attach the official installer pipeline to this tag.

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md --latest
   ```

   For a prerelease, omit `--latest` and add `--prerelease`.

After the official product ships `1.1.3`, update the public snapshot and tag `v1.1.3`. Cut the next version only when there are verified, user-visible changes.

## Do not

- Use a public-repository tag to deploy official production.
- Tag before the changelog is merged and the product version fields match.
- Ship a stable release through `workflow_dispatch` (this repository has no such workflow).
- Invent a second version line for community Docker images or installers. If those are added later, they follow the same `vX.Y.Z` tags.
