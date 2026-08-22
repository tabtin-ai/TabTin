---
name: skill-creator
description: >
  技能创建器——交互式创建、校验、打包 SKILL.md。用户要新建/改进 skill 时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: knowledge
    displayName: "技能创建器"
    tags:
      - meta
      - skill-creator
      - authoring
    tools:
      - run_terminal_command
---

# 技能创建器

引导用户从场景 → 路由描述 → 正文 → references → 自测触发句。产出符合 TabTin `metadata.tabtin` 规范的草案。

## 必须遵守

- 对照 `support/app/specs/tool-skill.md` 与 27 类枚举。
- description 必须可路由；禁止空泛描述。
- 提醒用户：第三方 skill 需审核后才能 public。
