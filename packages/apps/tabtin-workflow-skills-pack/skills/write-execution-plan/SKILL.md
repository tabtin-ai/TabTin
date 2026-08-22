---
name: write-execution-plan
description: >
  写可执行计划——把目标拆成可验证步骤、验收标准与风险。用户要求"写计划""拆任务""怎么做"且尚未进入实现时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: workflow
    displayName: "写可执行计划"
    tags:
      - plan
      - execution
      - checklist
      - workflow
    tools:
      - run_terminal_command
---

# 写可执行计划

把目标变成可验证的执行清单。计划要短、可检查，不要写成愿景文。

## 先读

- `references/workflow.md`
- `references/tooling.md`
- `references/templates.md`

## 必须遵守

- 每一步都要有可观察的完成信号。
- 标出依赖、风险与回滚点。
- 不确定的输入写成假设，不要伪装成事实。

## 主流程

1. 确认目标、非目标、约束。
2. 拆成有序步骤（每步一人/一 Agent 可完成）。
3. 写验收标准与失败时怎么办。
4. 需要时同步到 TabDoc 或 Tracker（先确认）。

## 输出承诺

计划草稿 + 验收清单 + 最大风险 3 条。
