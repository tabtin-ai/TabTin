---
name: session-handoff
description: >
  会话交接——把当前会话压缩成下一位 Agent / 下一会话可接手的交接文档。用户说"交接""换会话继续""上下文快满了"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: knowledge
    displayName: "会话交接"
    tags:
      - handoff
      - context
      - session
      - knowledge
    tools:
      - run_terminal_command
---

# 会话交接

生成面向「下一个会话」的交接文档，而不是无结构摘要。

## 必须遵守

- 指向已有产物路径/链接，不要复制大段文件内容。
- 写清下一步目的、建议启用的 skill、已知坑。
- 默认写入 TabDoc 或用户指定的 Space 路径；不要丢到系统临时目录后不管。

## 主流程

1. 提炼：当前目标、已完成、未完成、关键决策、产物清单。
2. 写出「下一会话开场指令」。
3. 用户确认后持久化并返回链接。

## 输出承诺

交接文档链接 + 下一会话建议第一句话。
