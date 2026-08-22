---
name: github-pr-ops
description: >
  GitHub PR 编排——用 gh/CLI 查看失败检查、评论、保持 PR 可合并的偏好流程。用户提 GitHub/PR/CI 相关协作时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: developer
    displayName: "GitHub PR 编排"
    tags:
      - github
      - pr
      - cli
      - integration
    tools:
      - run_terminal_command
---

# GitHub PR 编排

优先 `gh` CLI。先读仓库 GitFlow，再操作。不 force push，不跳过 hooks，除非用户明确要求。
