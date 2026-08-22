---
name: verify-before-done
description: >
  完成前验收——在声称完成前对照验收清单自检（功能、回归、文档、资源链接）。用户说"验收一下""真的做完了吗""检查再交"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: automation
    displayName: "完成前验收"
    tags:
      - verify
      - qa
      - checklist
      - automation
    tools:
      - run_terminal_command
---

# 完成前验收

声称完成之前先自检。找不到证据就标未验证，不要用语气填坑。

## 必须遵守

- 每条验收项给出：通过 / 失败 / 未验证 + 证据。
- 失败项给出最小修复建议。
- 不把「我感觉没问题」当成通过。

## 主流程

1. 从用户目标或计划中提取验收项。
2. 用可读工具/命令/UI 取证。
3. 汇总缺口，决定是否还能说「完成」。

## 输出承诺

验收表 + 是否允许宣告完成 + 剩余风险。
