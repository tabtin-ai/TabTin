# TabTracker · CLI 命令

> 本文从主 [`../SKILL.md`](../SKILL.md) 拆出。模块称「自动化」，具体任务称「自动化任务」；命令仍为 `tabtin tracker`。
> 已移除 `tabtin tracker cancel`（曾等价 pause）；暂停用 `pause`，取消单次执行用 `cancel-run`。

### `tabtin tracker new` —— 创建自动化任务

```bash
# 5 档预设：manual / hourly / daily / weekdays / weekly
# --at HH:MM 配合 daily/weekdays/weekly 使用；manual / hourly 忽略

# --agent 必填（或已配置 TABTIN_AGENT_ID / profile.DefaultAgent）
# 执行 Workspace：全局 --workspace-id / 当前 profile 会写入创建请求体
tabtin tracker new "每日报告" --schedule daily --at 09:00 \
    --agent <agent-id> \
    --workspace-id <workspace-id> \
    --instructions "汇总昨天的数据变化并发到 Inbox"

tabtin tracker new "工作日提醒" --schedule weekdays --at 18:30 \
    --agent <agent-id> \
    --instructions "提醒我检查今日未完成事项"

# 未来只跑一次（at，一等支持）——支持 ISO，也支持“明天上午十点”这类相对时间
tabtin tracker new "一次性网页整理" --once-at "明天上午十点" \
    --agent <agent-id> \
    --instructions "打开 36k 网页，并把网页中的内容整理成文档"

# 表格行变化触发（table_event，一等支持）——用 --on-table + --on-events
tabtin tracker new "表格变更触发" \
    --on-table <table-id> --on-events record_created,record_updated \
    --agent <agent-id> \
    --instructions "根据变化记录生成同步摘要"

# 扩展事件触发（extension_event，高级·谨慎用）——必须完整 event_key
tabtin tracker new "新邮件触发" --on tabmail.email.received \
    --agent <agent-id> \
    --instructions "收到新邮件后判断是否需要提醒我"

# skill_params 用 JSON 字符串透传初始参数
tabtin tracker new "周报" --schedule weekly --at 10:00 \
    --agent <agent-id> \
    --instructions "生成工程团队上周进展和风险周报" \
    --skill-params '{"team":"engineering"}'
```

**关键约束**（charter v1.8 §7.1）：
- `--agent` **必填语义**（charter v1.8 §7.1：后端强制要求执行 Agent，不再回落 Space 默认 Agent）——先用 `tabtin agent list` 取合法 agent UUID；也可依赖 `TABTIN_AGENT_ID` / profile.DefaultAgent。不要传 `"default"` 这类别名。
- **执行 Workspace 必填**：服务端校验的是创建请求体里的 `workspace_id`。CLI 会把全局 `--workspace-id`（或当前 profile / `TABTIN_WORKSPACE_ID`）写入 body。只把 ID 当「上下文 flag」而不进 body 时，会稳定报「必须指定执行 Workspace」。个人 Workspace 场景通常与当前会话 Workspace 同 ID；Project 场景须传成员自己的执行 Workspace，不能把 Project / team_space ID 当执行现场（见 ）。
- `--skill` 可选——默认纯 Agent 模式，由 Agent 运行时自助搜索 / 读取可用 Skill。只有用户明确指定，或你已确认该 Skill 已安装时，才传 `--skill <skill_key>` 预绑定方法论。
- **未来只跑一次用 `--once-at`**：支持 ISO 8601（如 `2026-06-10T09:00:00+08:00`）
  和窄中文相对时间（今天/明天/后天 + 上午/下午/晚上 + 点/点半/分钟，如
  `"明天上午十点"`）。不要把未来一次性任务建成 `manual`，manual 只表示手动触发。
- **优先传 `--instructions`**：这是每次运行时真正派给 Agent 的任务指令，写入
  `skill_params.instructions`；长提示词可用 `--instructions @prompt.md` 或
  `--instructions -`。`--skill-params` 仍用于其它结构化参数；若两者都含
  `instructions`，显式 `--instructions` 覆盖 JSON 里的同名字段。
- 创建成功后直接进入活动状态并按触发条件调度，不需要再调用第二条启用命令。
- 用户明确要求暂不运行时，创建成功后调用 `tabtin tracker pause <tracker-id>`；恢复时用 `resume`。产品侧只表达“活动 / 暂停”。

**调度档位**：
- `manual`：手动触发（无定时）
- `hourly`：每小时 0 分（`--at` 忽略）
- `daily`：每天指定时刻
- `weekdays`：周一至周五指定时刻
- `weekly`：每周一指定时刻

**触发类型支持度分级（v1 边界，别误用）**：

本版本并非所有触发类型都同等成熟。给用户派活时**默认只用一等支持**那一档；高级类型仅在用户/集成场景明确需要时才用，并提醒其「本版本属高级、UI 不暴露、验证覆盖弱」。

| 等级 | 触发类型 | 怎么用 |
|------|---------|--------|
| **一等支持** | `manual` / `cron`(每小时·每天·工作日·每周) / `interval`（`--every`）/ `at`（`--once-at`）/ `table_event`（`--on-table` + `--on-events`） | UI + CLI 双入口、已 live 验，放心用 |
| **高级（谨慎用）** | `webhook` / `extension_event`（`--on <完整 event_key>`）/ `tracker_completed` | 仅 CLI/API、UI 不暴露、验证弱，别当一等能力随便派 |

- **未来只跑一次**请用 `--once-at`；`manual` 只表示手动触发，不会到点自动运行。
- **`extension_event` 必须传完整带命名空间的 `event_key`**（如 `tabmail.email.received`），裸名（如 `record_created`）不匹配、会静默永不触发。表格行变化请改用一等的 `table_event`（`--on-table <table-id> --on-events record_created,record_updated`），不要用 `extension_event` 套裸 `record_created`。
- **`webhook`** 本版本无管理面（创建 / 复制回调 URL / 签名示例 / secret 轮换都不做），只能 CLI/API 配，需用户具备签名配置能力时才建议。
- 完整边界与问题编号见能力总览「[触发类型支持度分级（v1 边界）](../../../../docs/overview/tracker-scheduler-capability-overview.md#触发类型支持度分级v1-边界)」（TS-25）。

### `tabtin tracker list` —— 列出自动化任务

```bash
tabtin tracker list                          # 当前 Space 全部
tabtin tracker list --status active          # 仅运行中的
tabtin tracker list --trigger-type cron      # 按触发类型过滤
tabtin tracker list --limit 50               # 翻页
```

返回字段：`id / name / status / trigger_type / skill_key / total_runs / last_run_at`。

**用途**：用户问"我有哪些任务" / "看一下自动化任务"时调用。

### `tabtin tracker show` —— 自动化任务详情

```bash
tabtin tracker show <tracker-id>
```

返回：Tracker 详情字段（不含 Run 历史）。**用途**：用户问"这个任务怎么配置的"。

### `tabtin tracker runs` —— 历次执行

```bash
tabtin tracker runs <tracker-id>
```

返回：Run 列表（按时间倒序），每条含 `id / status / started_at / finished_at / duration / error_summary`。
**用途**：用户问"上次运行结果" / "为什么没跑" / "看跑了几次" 时调用。

### `tabtin tracker activate` —— 兼容历史草稿

```bash
tabtin tracker activate <tracker-id>
```

仅用于兼容历史版本留下的 `draft` 数据。新建自动化任务已经直接进入活动状态，
正常生命周期只使用 `pause` / `resume`。

### `tabtin tracker trigger` —— 立即执行一次

```bash
tabtin tracker trigger <tracker-id>
# 别名（向后兼容）：tabtin tracker run-now <tracker-id>
```

**Risk: review** —— 会消耗 token 与外部资源，需用户确认。返回 `{run_id, status}`。

### `tabtin tracker pause` / `tabtin tracker resume` —— 暂停/恢复

```bash
tabtin tracker pause <tracker-id>     # 不取消正在执行的 Run，仅阻止后续调度
tabtin tracker resume <tracker-id>    # paused → active（适用于业务暂停后的恢复）
```

### `tabtin tracker cancel-run` —— 取消进行中的本次执行

```bash
tabtin tracker cancel-run <tracker-id> <run-id>
```

终止一个 `running` / `pending` Run，关联的 ChatSession 也会请求取消。

### `tabtin tracker delete` —— 删除自动化任务

```bash
tabtin tracker delete <tracker-id>
```

**Risk: high** —— 删除 Tracker 会同时丢失所有历史 Run 记录，需用户明确确认。

### `tabtin tracker dry-run` —— 触发条件试运行

```bash
tabtin tracker dry-run <tracker-id>              # 用合成事件验证条件
tabtin tracker dry-run <tracker-id> --replay-last 5   # 用最近 5 个真实事件回放
```

用途：用户配置 `extension_event` / `table_event` Tracker 后，想验证条件是否
正确匹配，但不真正消耗 token。
