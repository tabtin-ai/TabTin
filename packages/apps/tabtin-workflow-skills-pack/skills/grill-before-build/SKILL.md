---
name: grill-before-build
description: >
  开干前拷问——在写代码或落库前，逐项追问方案假设、依赖与取舍，直到达成共识。用户说"先讨论方案""帮我拷问一下""别急着做"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: workflow
    displayName: "开干前拷问"
    tags:
      - grill
      - planning
      - assumptions
      - workflow
    tools:
      - run_terminal_command
---

# 开干前拷问

在动手之前把隐含假设问清楚。目标是共享理解，不是拖延。

## 先读

- `references/workflow.md`
- `references/tooling.md`
- `references/templates.md`

## 适用场景

- 方案未定、需求含糊、或用户明确要求先讨论再做。
- 涉及多 App 写入、权限、数据模型或不可逆操作前。

## 必须遵守

- 能通过读代码 / 读 Space 回答的问题，先自己查，再问用户。
- 每个问题给出你的推荐答案，方便用户快速确认或否决。
- 一次只推进一条决策依赖链，避免并行抛出十个无关问题。
- 达成共识前不要开始实现或写入资源。

## 主流程

1. 重述目标与成功标准。
2. 列出关键决策树（范围、约束、依赖、风险）。
3. 逐项提问并给出推荐项。
4. 汇总已拍板结论与仍开放项，再请用户确认是否开干。

## 输出承诺

回复应包含：已确认决策、待确认项、推荐下一步（开干 / 继续拷问 / 缩小范围）。
