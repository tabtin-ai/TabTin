---
name: brief-to-slide-deck
description: >
  简报转演示稿——把文档 / 汇报转成给老板 / 客户看的
  PPT deck。用户要求"把文档做成 PPT""把汇报变成幻灯片""生成
  deck"时使用；先用 TabDoc 固化讲稿，再按 TabSlide
  规范生成可编辑演示。
metadata:
  version: "0.1.0"
  tabtin:
    category: design
    displayName: "简报转演示稿"
    tags:
      - slide
      - presentation
      - briefing
      - tabdoc
      - tabslide
    tools:
      - run_terminal_command
---

# 简报转演示稿

把已有材料整理成可演示 deck。先建立讲稿逻辑，再生成 TabSlide 页面；目标是可编辑、可解释、可复查的演示材料。

## 先读

- `references/workflow.md`：讲稿整理、页面规划、生成、检查、交付流程。
- `references/tooling.md`：TabDoc、TabData、TabSlide operator/html-spec/design-guide 的调用边界。
- `references/templates.md`：deck 大纲、页面 HTML 骨架、交付回执模板。

## 适用场景

- 用户要求把文档、简报、周报、项目状态或客户材料做成 PPT/deck。
- 用户指定页数、受众、汇报时长、视觉风格或演示目标。
- 用户希望生成可编辑的 TabSlide，而不是只要文字大纲。

## 必须遵守

- 生成前确认受众、目标、页数/时长、视觉风格和素材来源。
- 先读取 `app:tabslide/html-spec`；必要时读取 `app:tabslide/design-guide` 和 `app:tabslide/tabslide-operator`。
- 使用 `tabtin slide create --name "<deck name>" --html @./slides.html` 创建并写入新演示文稿；已有演示文稿插页用 `cat slide.html | tabtin slide add-page --project-id <id> --html -`。
- 高频检查优先用 `tabtin slide lint --skip-visual --min-severity warning`。
- 如果 `preview`、`lint` 或 `generate` 透出 Playwright/Chromium 缺失，不要给用户浏览器安装命令；说明这是 TabSlide runtime 环境缺失/未就绪，并保留原始错误给产品或管理员诊断。

## 主流程

1. 收集材料并确认演示目标。
2. 先生成讲稿或大纲，必要时写入 TabDoc。
3. 按 TabSlide HTML 规范生成 `slides.html`。
4. 创建 TabSlide 项目、生成页面、运行 lint；预览失败时按 runtime 边界处理。
5. 交付讲稿链接、TabSlide 项目和待确认项。

## 输出承诺

完成后回复应包含：讲稿链接或大纲、TabSlide 项目、页数、已运行的检查、视觉/内容待确认项。没有成功生成时，要明确卡在素材、规范、CLI 还是 runtime 环境。
