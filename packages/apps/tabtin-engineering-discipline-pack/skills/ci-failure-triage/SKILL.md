---
name: ci-failure-triage
description: >
  CI 失败分诊——读日志定位并给出最小修复建议。用户说 CI 挂了、帮看失败时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: automation
    displayName: "CI 失败分诊"
    tags:
      - ci
      - triage
      - automation
      - developer
    tools:
      - run_terminal_command
---

# CI 失败分诊

先定位失败 job/用例，再区分 flaky、环境、真回归。给出最小修复路径。
