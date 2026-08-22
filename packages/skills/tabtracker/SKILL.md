---
name: tabtracker
description: >
  管理自动化任务——创建、列出、暂停、恢复、立即触发（产品模块名「自动化」，
  具体条目称「自动化任务」；CLI 命令仍为 tabtin tracker）。当用户表达"派活"意图时使用：
  关键词包括"帮我..."、"以后..."、"每天..."、"工作日..."、
  "提醒我..."、"定时..."、"每周..."。区分一次性指令（直接执行）和长期任务（创建
  自动化任务，由调度器在指定时间唤起 Agent）。
metadata:
  version: 0.2.2
  tabtin:
    category: collaboration
    autoActivateFor: [tabtracker]
    entry: cli
    tags: [tracker, scheduling, automation, 自动化, 自动化任务]
---

# 自动化（tabtin tracker）

## 概述

「自动化」是 TabTin 的产品模块名；模块里的每一条长期工单叫**自动化任务**。
对用户说话时：指模块用「自动化」，指具体任务/执行用「自动化任务」。
CLI 命令名仍是 `tabtin tracker`（工程内部也可称 Tracker）。

每个自动化任务绑定**一个 Agent**，可选预绑定一个 Skill。默认纯 Agent 模式下，
用户描述意图，Agent 在调度时刻自助搜索并调用可用 Skill 完成任务。

**入口规范**：本 Skill 的所有操作通过 `tabtin tracker` CLI 触发，由 Agent 通过
`run_terminal_command` 工具调用。**没有对应的 FC 工具**——charter §3.1 / AGENTS.md
明确「CLI-first，不是 FC-first」。

| 场景 | 推荐命令 |
|------|---------|
| 对话中创建未来一次性自动化任务 | `tabtin tracker new ... --once-at "明天上午十点" --agent ... --workspace-id ... --instructions "..."`（执行 Workspace 会写入创建请求体，见 ） |
| 列出当前 Space 所有自动化任务 | `tabtin tracker list` |
| 查看自动化任务详情 | `tabtin tracker show <tracker-id>` |
| 查看历次执行 | `tabtin tracker runs <tracker-id>` |
| 立即触发一次执行 | `tabtin tracker trigger <tracker-id>` |
| 取消进行中的本次执行 | `tabtin tracker cancel-run <tracker-id> <run-id>` |
| 暂停 / 恢复 | `tabtin tracker pause <tracker-id>` / `tabtin tracker resume <tracker-id>` |
| 删除 | `tabtin tracker delete <tracker-id>` |
| 触发条件试运行 | `tabtin tracker dry-run <tracker-id> [--replay-last N]` |

## 何时调用本 Skill

**调用时机**：用户表达"以后 / 未来 / 定时"做某事的意图。

| 用户表达 | 是否创建自动化任务 |
|---------|-------------------|
| "帮我每天早上 9 点同步 X" | ✅ 创建 daily 自动化任务 |
| "工作日下班前提醒我 Y" | ✅ 创建 weekdays 自动化任务 |
| "以后每次有新订单就通知我" | ✅ 创建事件触发自动化任务 |
| "现在帮我查一下数据" | ❌ 一次性指令，直接执行 |
| "我想要一个查 X 的功能" | ❌ 创建 Skill 不是自动化任务 |

**关键判别**：「现在 vs 以后」+「一次 vs 重复」。两者都倾向「以后」或「重复」时，
创建自动化任务。

## CLI 命令

> 每个子命令的完整参数与示例（new / list / show / runs / trigger / pause / resume / cancel-run / delete / dry-run）见 [`references/cli-commands.md`](references/cli-commands.md)。
> 不要使用已移除的 `tabtin tracker cancel`（曾等价 pause）；暂停用 `pause`，取消单次执行用 `cancel-run`。

## 资源导航（按需读取 / 运行）

- `references/cli-commands.md`：当你需要核对 `tabtin tracker` 子命令的完整 flag、参数约束或示例时读取。
- `scripts/new-and-activate.sh`：旧版兼容入口；当前 `tabtin tracker new` 已直接创建为活动状态，新调用无需使用该脚本。

## 输出契约（创建 / 启用后必须给可点链接）

创建或启用成功后，在最终回复里用 markdown 链接指给用户，方便一键打开详情：

```
[查看自动化任务「任务名」](tabtin://resource/tracker/<完整uuid>?hint=tabtracker)
```

- `<type>` 必须是 `tracker`（不是 `tabtracker` / `goal` / `cron`）
- `<id>` 用 CLI 返回的完整 tracker UUID
- `?hint=tabtracker` 建议带上

## 注意事项

- **对用户说话**：模块称「自动化」，具体任务/执行称「自动化任务」；不要蹦「Tracker」；命令仍写 `tabtin tracker ...`。
- **`--agent` 必填，`--skill` 可选**：创建必须指定执行 Agent——先用 `tabtin agent list` 取 agent id。默认不要猜 Skill；只有用户明确指定或已确认已安装时才传 `--skill`。
- **未来只跑一次用 `--once-at`**：用户说“明天上午十点”这类相对时间时直接传给 `--once-at`；不要误用 `--schedule manual`。
- **创建时必须把用户要 Agent 做什么写进 `--instructions`**：这是运行时任务主体。不要只把任务写进名称或 `--description`。
- **创建后直接活动**：`tabtin tracker new` 成功返回时已经进入调度，不要再补第二条启用命令。用户明确要求暂不运行时，创建成功后使用 `tabtin tracker pause <id>`，产品侧只表达“活动 / 暂停”。
- **意图留痕**：UI / command palette 会写 `intent_snapshot`；CLI 无 `--intent` flag，Agent 应在最终回复里保留用户原始意图与最终配置。
- **CLI = HTTP 等价路径**：走 `/api/tracker/events`，与 UI `CreateTrackerDialog` 同一 service。

## Risk Level

| 命令 | risk_level | 含义 |
|------|-----------|------|
| `list` / `show` / `runs` / `dry-run` | safe | 只读 / 试运行 |
| `new` | review | 创建后定时执行，需用户知晓 |
| `pause` / `resume` | review | 影响业务节奏（生命周期切换） |
| `trigger` / `run-now` | review | 立即消耗 token + 外部资源 |
| `cancel-run` | review | 终止进行中的本次执行 |
| `delete` | high | 软删归档，destructive |

## 历史背景（仅供参考）

早期 charter 曾设想 FC 工具；Tracker 模块收敛后整体下线，以 `tabtin tracker` CLI 为唯一对外契约。产品面：模块称「自动化」，具体条目称「自动化任务」。
