---
name: suggesting-skills
description: >
  推荐该装的技能——根据当前任务匹配技能市场/已装技能并建议安装或启用。用户卡住或重复做同类事时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: automation
    displayName: "推荐该装的技能"
    tags:
      - meta
      - suggest
      - marketplace
    tools:
      - run_terminal_command
---

# 推荐该装的技能

先 `tabtin skill search/market` 或读取已装列表，再推荐 1～3 个最相关 skill，说明为何匹配与如何安装。

## 必须遵守

- 不推荐未经验证的来源。
- 说清是「能力补齐」还是「偏好编码」。
- 用户拒绝后不要反复推销。
