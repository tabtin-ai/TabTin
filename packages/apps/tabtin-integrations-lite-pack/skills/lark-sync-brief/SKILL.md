---
name: lark-sync-brief
description: >
  飞书同步简报——把 Space 结论整理成适合飞书群/文档的同步稿，并给出粘贴或 CLI 发送步骤。用户要同步到飞书时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: communication
    displayName: "飞书同步简报"
    tags:
      - lark
      - feishu
      - sync
      - integration
    tools:
      - run_terminal_command
---

# 飞书同步简报

先产出可粘贴的同步稿。若环境已配置飞书 CLI/集成，再询问是否代发；否则只给文稿与步骤。

> **导入飞书多维表 / 云文档进 Organization**（入站迁入）请用 `skills_read("app:tabtin-integrations-lite-pack/feishu-import-to-org")`，不要用本 skill。
