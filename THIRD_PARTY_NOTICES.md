# 第三方声明

[English](THIRD_PARTY_NOTICES.en.md)

TabTin 包含第三方软件、字体和资产。它们适用各自许可证；根目录 AGPL-3.0-only 不替代这些条款。本文件是索引，完整条款以仓内许可证文件为准。

## 直接分发资产

| 组件 | 版本或来源 | 许可证 | 仓内许可证 |
| --- | --- | --- | --- |
| Inter | Inter Project Authors | SIL OFL 1.1 | `apps/tabtin_django/apps/tabslide/assets/fonts/OFL-Inter.txt` |
| Noto Sans SC | Google / Noto Fonts | SIL OFL 1.1 | `apps/tabtin_django/apps/tabslide/assets/fonts/OFL-NotoSansSC.txt` |
| Font Awesome Free | 6.5.0 | 图标 CC BY 4.0；字体 SIL OFL 1.1；代码 MIT | `apps/tabtin_django/apps/tabslide/assets/vendor/fontawesome/LICENSE.txt` |
| Chart.js | 4.4.0 | MIT | `apps/tabtin_django/apps/tabslide/assets/vendor/chartjs/LICENSE.md` |
| Apache ECharts | 5.5.0 | Apache-2.0 | `apps/tabtin_django/apps/tabslide/assets/vendor/echarts/LICENSE` |
| MathJax | 3.2.2 | Apache-2.0 | `apps/tabtin_django/apps/tabslide/assets/vendor/mathjax/LICENSE` |
| Superpowers personal plugin fixtures | Jesse Vincent | MIT | `packages/agent-runtime/fixtures/personal-plugins/superpowers/LICENSE` |
| Ponytail | DietrichGebert | MIT | `packages/apps/ponytail/LICENSE` |
| Table Engine Canvas / Teable-derived work | Teable, Inc. 与 TabTin Contributors | MIT | `packages/table-engine-canvas/LICENSE` |

TabSlide 资产版本、来源和 SHA-256 见 `apps/tabtin_django/apps/tabslide/assets/vendor/manifest.json`。

## 其他依赖

JavaScript、Python、Go 和移动端依赖以包清单与锁文件为准。构建或再分发时，应从实际发布产物生成 SBOM（软件物料清单）和许可证报告，不能只依赖本索引。

新增或升级第三方内容时，必须确认来源、版本和许可证，保留完整条款，说明修改情况，并同步更新中英文声明。

首次发布前须对最终构建产物完成第三方许可证复核。
