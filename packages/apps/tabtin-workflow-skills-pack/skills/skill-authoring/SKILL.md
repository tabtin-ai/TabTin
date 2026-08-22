---
name: skill-authoring
description: >
  编写新技能——把反复出现的流程沉淀为 SKILL.md（含 frontmatter、references）。用户要求"做成 skill""沉淀流程""教 Agent 以后这样干"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: knowledge
    displayName: "编写新技能"
    tags:
      - skill
      - authoring
      - meta
      - knowledge
    tools:
      - run_terminal_command
---

# 编写新技能

把可复用流程写成 agentskills 兼容的 TabTin skill。

## 必须遵守

- `description` 必须像路由规则（何时用），禁止空泛「提高效率」。
- 一个 skill 只干一件事；细节进 `references/`。
- 使用 `metadata.tabtin.category`，分类必须属于平台 27 类。
- 写操作前确认；缺信息标待确认。

## 主流程

1. 明确触发场景与非目标。
2. 起草 frontmatter + 短正文 + references 大纲。
3. 用 2～3 个例子压力测试路由描述。
4. 用户确认后写入约定目录（通常当前 Agent 可写的本地 skill 目录，或 Pack 草案）。

## 输出承诺

可粘贴的 SKILL.md 草案 + 建议 category/tags + 测试用触发句。
