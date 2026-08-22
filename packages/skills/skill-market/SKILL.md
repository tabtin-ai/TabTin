---
name: skill-market
description: >
  管理 Skill 生命周期——列出已装、看详情、搜索市场、
  安装、卸载、启用、禁用、更新。当用户表达"装个技能
  / 卸载技能 / 看看有什么技能 / 启用禁用技能"意图时使用。
metadata:
  version: 0.1.0
  tabtin:
    category: collaboration
    autoActivateFor: [skill]
    entry: cli
    tags: [skill, marketplace, lifecycle]
---

# Skill Market Operator

## 概述

Skill 是 TabTin 平台的能力包（用户 / 应用 / 平台预先写好的"知识包"）。本 SKILL 覆盖
Skill 的**平台生命周期管理**——安装 / 卸载 / 启用 / 禁用 / 详情 / 市场 / 搜索 / 更新。

**入口规范**：所有操作通过 `tabtin skill` CLI 触发，由 Agent 通过 `run_terminal_command`
工具调用。**没有对应的 FC 工具**——charter §3.1「CLI-first，不是 FC-first」：Skill
生命周期管理以 CLI 命令为唯一对外契约，能管道、能脚本、能复用。FC `skills_read` /
`skill_invoke` 只读正文 / 调指令，不负责平台注册表操作。

## CLI vs FC 边界（重要）

Skill 域有两套访问面，**职责不同，别混用**：

| 目的 | 走哪条 | 命令 |
|------|--------|------|
| **看本地 SKILL.md 正文**（学流程、读方法） | FC | `skills_read` |
| **看平台元数据**（版本 / 安装源 / 启用状态 / 市场信息） | CLI | `tabtin skill info <name>` |
| **生命周期操作**（安装 / 卸载 / 启用 / 禁用 / 更新） | CLI | `tabtin skill install/remove/enable/disable/update` |
| **列已装 / 搜市场 / 看市场** | CLI | `tabtin skill list` / `tabtin skill search` / `tabtin skill market` |

误用排查：
- 想知道"XX 技能怎么用"→ 读正文 → FC `skills_read`，**不是** `tabtin skill info`（info 只给版本/状态）。
- 想知道"XX 技能装没装 / 什么版本 / 启没启用"→ 看元数据 → CLI `tabtin skill info`，**不是** `skills_read`。
- 想装 / 卸 / 启用 / 禁用 → CLI 生命周期命令，**不是** FC（FC 没有这些能力）。

## 方法路由

| 目标 | CLI 命令 |
|------|---------|
| 列出已装 Skill | `tabtin skill list` |
| 看 Skill 详情（版本 / 安装源 / 启用状态） | `tabtin skill info <canonical-key>` |
| 看 Skill 市场 | `tabtin skill market` |
| 看当前 Agent 已启用 / 可见 Skill | `tabtin skill managed`（对齐 Wave 1 `visible`） |
| 搜索 Skill（按关键词） | `tabtin skill search <query>` |
| 安装 Skill | `tabtin skill install <canonical-key>` |
| 卸载 Skill | `tabtin skill remove <canonical-key>` |
| 启用 Skill | `tabtin skill enable <canonical-key>` |
| 禁用 Skill | `tabtin skill disable <canonical-key>` |
| 更新 Skill | `tabtin skill update <canonical-key>` |

## 何时调用本 Skill

**调用时机**：用户表达"管理技能"意图——装 / 卸 / 启用 / 禁用 / 看详情 / 看市场 / 搜索。

| 用户表达 | 推荐命令 |
|---------|---------|
| "装个 web-search 技能" | `tabtin skill install user:web-search` |
| "装 Office Pack 会议纪要技能" | `tabtin skill install app:tabtin-office-skills-pack/meeting-notes-to-actions` |
| "卸载 XX 技能" | `tabtin skill remove user:xx` |
| "看一下 XX 技能的详情" | `tabtin skill info user:xx` |
| "我装了哪些技能？" | `tabtin skill list` |
| "有什么技能可用？" | `tabtin skill market` 或 `tabtin skill search <query>` |
| "启用 / 禁用 XX 技能" | `tabtin skill enable user:xx` / `tabtin skill disable user:xx` |
| "更新 XX 技能" | `tabtin skill update user:xx` |

**关键判别**：用户说的是"管理技能本身"（装/卸/启/禁/看状态）还是"用技能干活"。
前者走本 SKILL（CLI 生命周期）；后者读对应 skill 的正文（FC `skills_read`）再行动。

## CLI 命令

> 每个子命令的完整 flag、参数约束与示例（list / info / market / managed / search /
> install / remove / enable / disable / update）见
> [`references/cli-commands.md`](references/cli-commands.md)。

## 注意事项

- **装 / 卸 / 启用 / 禁用走 CLI，不是 FC**：这些是平台注册表操作，走 `tabtin skill`
  CLI；不要用 FC `skills_read` / `skill_invoke` 代替——它们是读正文 / 调指令，不是
  生命周期管理。
- **看正文 vs 看元数据**：想学 skill 的流程走 FC `skills_read`；想看版本 / 安装源 /
  启用状态走 CLI `tabtin skill info`。两者数据源不同，互相不能替代。
- **安装 = 启用（Wave 1）**：`install` 与 `enable` 都打 `POST /skills/{key}/enable`，
  设备端随后物化本地文件；**不需要**再单独 `enable`。
- **canonical key**：参数必须带 source 前缀（`user:` / `app:` / …），例如
  `user:web-search`、`app:tabtin-office-skills-pack/meeting-notes-to-actions`。
- **卸载 vs 禁用**：`remove` = disable + 删 enablement + 清本地文件；`disable` 只停用、保留安装记录与本地文件。
- **install / remove / update / enable / disable 是 RiskWrite**：会改注册表或本地物化，需用户知晓。RequiresAgent。
- **search 用关键词、market 看全量**：用户说"搜一下 X 技能"走 `search <query>`；
  "看看有什么技能"走 `market`（全量市场）或 `list`（已装）。

## Risk Level

| 命令 | risk_level | 含义 |
|------|-----------|------|
| `list` / `info` / `market` / `managed` / `search` | safe | 只读 |
| `install` / `remove` / `update` | review | 改注册表（RiskWrite），需用户知晓 |
| `enable` / `disable` | review | 影响运行时启用状态 |

## 资源导航

- `references/cli-commands.md`：当你需要核对 `tabtin skill` 子命令的完整 flag、参数约束或示例时读取。
