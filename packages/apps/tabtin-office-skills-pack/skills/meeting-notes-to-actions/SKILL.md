---
name: meeting-notes-to-actions
description: >
  会议纪要整理——沉淀纪要、提炼 action items、结构化行动项、
  同步到文档 / 任务表。用户贴会议记录、录音转写、讨论要点，
  要求"整理成纪要""提炼 action items""同步到文档 /
   任务"时使用；必要时用 Tracker 做后续提醒。
metadata:
  version: "0.1.0"
  tabtin:
    category: collaboration
    displayName: "会议纪要与行动项"
    tags:
      - meeting
      - notes
      - action-items
      - tabdoc
      - tabdata
      - tracker
    tools:
      - run_terminal_command
---

# 会议纪要与行动项

把会议原始材料整理成可分享的 TabDoc 纪要和可跟踪的行动项。目标是让会后责任清楚、结论可追溯，而不是替用户编造负责人或截止日期。

## 先读

- `references/workflow.md`：端到端流程、分支条件、确认点。
- `references/tooling.md`：应优先读取的 TabDoc、TabData、Tracker 能力和禁用猜测。
- `references/templates.md`：纪要、行动项表、回复用户的标准结构。

## 适用场景

- 用户给出会议记录、访谈纪要、录音转写或讨论要点。
- 用户要求整理纪要、提炼行动项、同步到文档/表格/后续跟进。
- 用户希望把会议结论沉淀成团队可复用资源。

## 必须遵守

- 信息缺失时标为“待确认”，不要猜负责人、日期、优先级或业务背景。
- 写入 TabDoc、创建/更新 TabData、创建 Tracker 前先让用户确认沉淀范围。
- 涉及人事、薪资、合同、隐私内容时，先询问哪些内容允许保存。
- 资源链接统一使用 `tabtin://resource/...?...hint=...`。

## 主流程

1. 提取会议主题、背景、关键决策、行动项、风险和待确认问题。
2. 先给用户预览摘要与行动项，列出缺口。
3. 用户同意后，用 TabDoc 固化纪要，用 TabData 创建或更新行动项。
4. 只有用户明确要求长期提醒或自动跟进时，才创建 Tracker。

## 输出承诺

完成后回复应包含：纪要链接、行动项数量、写入位置、待确认事项、下一步建议。没有执行写入时，要明确说明当前只是草稿。
