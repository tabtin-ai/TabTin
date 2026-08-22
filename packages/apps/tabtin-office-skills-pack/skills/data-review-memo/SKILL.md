---
name: data-review-memo
description: >
  数据复盘备忘——查询聚合 TabData 数据，输出 TabDoc
  复盘结论。用户要求"分析这张表""做运营 / 销售 / 项目复盘""把数据结论写成文档"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: data
    displayName: "数据复盘备忘"
    tags:
      - data
      - review
      - analysis
      - metrics
      - tabdata
      - tabdoc
    tools:
      - run_terminal_command
---

# 数据复盘备忘

把表格数据转成业务复盘，而不是只报数字。结论必须基于数据口径，明确区分事实、推断和建议。

## 先读

- `references/workflow.md`：表结构确认、查询聚合、复盘写作、沉淀分支。
- `references/tooling.md`：TabData 查询安全、TabDoc 写入和可选 TabSlide 分支。
- `references/templates.md`：复盘文档、查询记录、输出回执模板。

## 适用场景

- 用户要求分析表格、复盘运营/销售/项目指标。
- 用户希望把数据结论写成文档或管理层摘要。
- 用户需要发现异常、解释变化、提出后续追踪指标。

## 必须遵守

- 先确认表、字段、时间范围和指标定义，再查询。
- 不编造趋势，不把相关性写成确定因果。
- 默认不执行写操作；修正数据前必须列出影响记录并等待确认。
- 写入 TabDoc 前先给用户看摘要和查询口径。

## 主流程

1. 确认分析问题、数据范围、字段含义和成功标准。
2. 用安全查询获得汇总、分布、异常和样例记录。
3. 产出复盘草稿，保留查询口径和限制。
4. 用户确认后写入 TabDoc；需要汇报 deck 时再进入 TabSlide 分支。

## 输出承诺

完成后回复应包含：3 条以内主要信号、关键数字、口径限制、建议动作、是否已写入文档。
