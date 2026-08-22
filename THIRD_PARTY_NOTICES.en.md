# Third-Party Notices

[中文](THIRD_PARTY_NOTICES.md)

TabTin includes third-party software, fonts, and assets. Their own licenses apply; the root AGPL-3.0-only license does not replace them. This file is an index. Complete terms remain in the repository license files.

## Directly distributed assets

| Component | Version or source | License | Repository license |
| --- | --- | --- | --- |
| Inter | Inter Project Authors | SIL OFL 1.1 | `apps/tabtin_django/apps/tabslide/assets/fonts/OFL-Inter.txt` |
| Noto Sans SC | Google / Noto Fonts | SIL OFL 1.1 | `apps/tabtin_django/apps/tabslide/assets/fonts/OFL-NotoSansSC.txt` |
| Font Awesome Free | 6.5.0 | Icons CC BY 4.0; fonts SIL OFL 1.1; code MIT | `apps/tabtin_django/apps/tabslide/assets/vendor/fontawesome/LICENSE.txt` |
| Chart.js | 4.4.0 | MIT | `apps/tabtin_django/apps/tabslide/assets/vendor/chartjs/LICENSE.md` |
| Apache ECharts | 5.5.0 | Apache-2.0 | `apps/tabtin_django/apps/tabslide/assets/vendor/echarts/LICENSE` |
| MathJax | 3.2.2 | Apache-2.0 | `apps/tabtin_django/apps/tabslide/assets/vendor/mathjax/LICENSE` |
| Superpowers personal plugin fixtures | Jesse Vincent | MIT | `packages/agent-runtime/fixtures/personal-plugins/superpowers/LICENSE` |
| Ponytail | DietrichGebert | MIT | `packages/apps/ponytail/LICENSE` |
| Table Engine Canvas / Teable-derived work | Teable, Inc. and TabTin Contributors | MIT | `packages/table-engine-canvas/LICENSE` |

TabSlide asset versions, sources, and SHA-256 values are in `apps/tabtin_django/apps/tabslide/assets/vendor/manifest.json`.

## Other dependencies

JavaScript, Python, Go, and mobile dependencies are defined by manifests and lockfiles. Build and redistribution processes should generate an SBOM and license report from actual release artifacts rather than relying only on this index.

When adding or upgrading third-party content, confirm its source, version, and license; preserve complete terms; state modifications; and update both language versions.

Complete a third-party license review of final build artifacts before the first release.
