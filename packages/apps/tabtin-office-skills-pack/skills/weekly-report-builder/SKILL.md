---
name: weekly-report-builder
description: >
  周报月报生成——收集 TabMemo、TabDoc、TabData 事实，
  输出 TabDoc 报告，需要演示时生成 TabSlide 大纲。
  用户要求"写周报""整理本周进展""生成月报""做汇报材料"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: productivity
    displayName: "周报/月报生成器"
    tags:
      - report
      - weekly
      - monthly
      - tabmemo
      - tabdoc
      - tabdata
      - tabslide
    tools:
      - run_terminal_command
---

# 周报/月报生成器

把一段时间内的工作记录整理成可交付报告。先收集事实，再形成总结；不要把计划、猜测或愿望写成已完成成果。

## 先读

- `references/workflow.md`：素材收集、报告生成、沉淀和演示分支。
- `references/tooling.md`：TabMemo、TabDoc、TabData、TabSlide 的使用边界。
- `references/templates.md`：周报/月报/管理层摘要模板。

## 适用场景

- 用户要求写周报、月报、阶段总结、复盘汇报。
- 用户提供任务表、笔记、文档，希望整理成一份报告。
- 用户在报告基础上还要求生成演示大纲或 deck。

## 必须遵守

- 每条“完成/进展”应尽量能追溯到用户材料、Memo、Doc 或表格记录。
- 不知道表名、字段、周期、团队边界时先问，不猜业务结构。
- 写入 TabDoc 或更新既有文档前，先让用户确认报告草稿。
- 需要生成幻灯片时，按 TabSlide builtin skill 读取规范，不能指导用户安装 Playwright/Chromium。

## 主流程

1. 确认周期、受众、项目/团队范围和可读取来源。
2. 收集素材并标明来源，缺失项列为未覆盖。
3. 生成报告草稿，区分完成、进展、风险、计划和需要支持。
4. 用户确认后写入 TabDoc；需要演示时再进入 TabSlide 分支。

## 输出承诺

完成后回复应包含：报告链接或草稿、素材来源统计、未覆盖来源、3 条以内摘要、待用户确认的事项。
