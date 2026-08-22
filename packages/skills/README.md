# TabTin Skills

Skill 是 TabTin 中"派给 Agent 完成某类工作的说明书"——Markdown 指令 + 元数据 + 可选脚本/资源/子文件。
**Skill 本身不执行任何操作**,由 Agent 读取后参考其指引调用 Tool 完成实际工作。

> Charter v1.8 §3.1 / §6.4 / §6.8 — Tracker 可选预绑定一个 Skill；不绑定时
> 走纯 Agent 模式，由 Agent 自助读取可用 Skill。Tracker 当前由 CLI / HTTP API
> 暴露，FC 工具已下线。

## 目录结构

每个 Skill 一个独立目录,根级文件:

```
packages/skills/<skill_key>/
├── SKILL.md           # 必需:frontmatter + 决策表 + 用法说明
├── README.md          # 可选:面向开发者的实现说明
├── scripts/           # 可选:辅助脚本(Skill 不"跑"它们,Agent 通过 Tool 执行)
└── ...
```

## SKILL.md frontmatter 必填字段

```yaml
---
name: <skill_key>
description: <一句话描述 + 何时使用的关键词>
auto_activate_for: [<app_id>, ...]   # 在哪些 app 上下文下自动可用
tools:
  - <tool_name>
  - ...
tags: [...]
---
```

## 失败信息规范(Wave 6 / charter §4.4 / §6.7)

Skill 失败汇报必须**人话化**——这是宪法级硬要求,违反等于不能合入。

### 强制底线

1. **禁止把原始堆栈/错误码作为 Run 的最终消息**

   - ❌ 不允许:`"Traceback (most recent call last): File \"...\", line 42\nValueError: ..."`
   - ❌ 不允许:`"Agent 返回错误: ConnectionError: [Errno 111] Connection refused"`
   - ❌ 不允许:`"errno=-111"` / `"error_code=E_TIMEOUT"` 等技术名词
   - ✅ 允许:`"我用的 kimi 模型这次没返回结果,可能是接口暂时不稳定。要不要换 GPT-4 重试?"`

2. **必须双段式:现象 + 恢复动作建议**

   - 现象段:用日常语言描述发生了什么(像同事会怎么说,而不是程序员会怎么说)
   - 恢复段:给一个可操作的下一步("换个模型"/"等几分钟再试"/"把范围调小一点")
   - 不要只描述失败而不给出路 — 用户读到失败汇报后必须能立刻决定下一步做什么

3. **不允许"暂时简化" / "本期不影响"等 wishful 注释**

   - 反思 15 教训:这种"自降级"承诺会变成永久遗留。任何 Skill PR 包含这种字样
     必须升 P0 处理(Wave 5 反思 15 防线)。

### 推荐实现:`humanize_failure_message`

后端 Python 路径(`apps/tabtin_django/apps/services/tools/domains/<domain>/`)
统一通过 `apps.tracker.utils.humanize_failure_message` 翻译错误:

```python
from apps.tracker.utils import humanize_failure_message

try:
    result = some_skill_action(...)
except Exception as exc:
    logger.exception("[my_skill] failed")
    return json.dumps({
        "success": False,
        "error": humanize_failure_message(
            f"my_skill 执行异常: {exc}",
            skill_key="my-skill",
            # 如果上层协议有 error_category(如 LLM 计费 / RemoteAgent dispatcher),
            # 优先传给翻译器——更精确。
            error_category=getattr(exc, "error_category", None),
        ),
    })
```

### 测试约束

- 每个 Skill 的失败路径**必须**有测试覆盖,断言"末条 Agent 消息无堆栈/错误码字面"
- 测试参考:`apps/tabtin_django/apps/tracker/tests/test_failure_translation.py`
- 北极星单测:在 Skill 失败用例的 Agent 末条消息中
  `assert_failure_message_is_human_readable(msg) == True`

### 审查清单

PR 合入前必查(等同于 charter §6.4 单 Skill 模型 hard requirement):

- [ ] Skill 的所有 `except` 路径都走过 `humanize_failure_message` 或同等翻译
- [ ] `TrackerRun.error_summary` / `progress_message` 等用户可见字段写入前过断言
- [ ] 失败模式覆盖测试(timeout / rate_limit / connection / unknown 至少各一)
- [ ] 末条消息既有现象描述也有恢复建议(不只描述失败)

## Skill 成功结果规范 — `artifact_ref` 标准字段(Wave 6 续作 / charter §4.4)

charter §4.4 "看产物 1 步可达"硬要求:Skill 成功完成时,**必须**在 `agent_result`
里返回**至少一个**产物定位字段(下表任一),否则用户点"看产物"通知只能跳到
app 主面板自己找——违反"1 步可达"。

### 标准字段(扁平 list,任选其一,字段名不要改)

| 产物类型 | 字段名 | 值类型 | 适用 app |
|---|---|---|---|
| 通用产物 ID | `artifact_id` | str | 任意 — 兜底字段 |
| TabMemo 笔记 | `memo_id` | str | tabmemo |
| TabData 行 | `record_ids` | list[str] | tabdata |
| TabDoc 文档 | `doc_id` | str | tabdoc |
| TabSlide 幻灯 | `slide_id` | str | tabslide |
| TabCode 代码 | `code_path` | str(workspace 内相对路径) | tabcode |

### Skill Tool 返回示例

```python
return json.dumps({
    "success": True,
    "agent_result": {
        "memo_id": str(memo.id),         # ← 关键:让"看产物"能跳到具体笔记
        "preview": memo.title,
    },
    # 其它任意业务字段 …
})
```

### 后端透传链路(开发者了解即可,Skill 不需直接调用)

1. `TrackerRun.context["agent_result"]` ← Skill 工具返回的 `agent_result`
2. `tracker_notification.py::_extract_artifact_ref(run)` 浅查找 `agent_result` /
   `context` 顶层提取上表字段
3. envelope `payload.artifact_ref` 透传给前端 → `notificationTargetResolver`
   → `navigateToTarget({type:'agentspace-app', id:<app>, artifactRef})`
   → 各 app 容器(tabmemoHandler 等)从 `meta.artifactRef` 跳具体产物

### 哪些 app **本期暂未支持**深度跳

W3 后改为 manifest 驱动 (`packages/apps/*/app.json` 的 `opens.types[]` 字段)——
原 `trackerArtifactMap.ts` 17 项 app id 反例硬编码已物理删除 (D1 红线)。
通知点击会跳到对应 app **主面板**,但**具体产物 ID 字段(站点页面 / 视频分段 /
白板对象)在 charter v3+ 才正式定义**,在那之前 Skill 即使返回 `artifact_ref`
也只能跳主面板:

- `tabsite`(站点页面定位字段待 charter v3+ 定义)
- `tabvideo`(视频分段定位字段待 charter v3+ 定义)
- `tabwhiteboard`(白板对象定位字段待 charter v3+ 定义)

## Skill 失败结果规范 — `recovery_actions`(Wave 6 续作 / plan §Phase 6 验收 #1)

失败时除 `error` 文本外,**应**返回结构化恢复动作。如果 Skill 不显式返回,
`humanize_failure_message` 会按错误关键字反查 `_NEEDLE_TO_ACTIONS` 自动生成。

### 结构化形式

```python
"recovery_actions": [
    {"kind": "retry_with_model", "label": "换 GPT-4 重试", "model": "gpt-4"},
    {"kind": "rerun", "label": "重新运行"},
]
```

### kind 枚举(扩展请改 `apps/tracker/utils.py::_RECOVERY_ACTION_KINDS`)

| kind | 含义 | 前端按钮行为 |
|---|---|---|
| `rerun` | 重新跑一次(沿用原配置) | 调 `trackerApi.triggerTask(tracker_id)` |
| `retry_with_model` | 换模型重试(`model` 字段指定) | 调 `triggerTask(tracker_id, {override_model})` |
| `switch_agent` | 换 Agent 重试 | 跳 Tracker 详情让用户人工换 |
| `check_permission` | 检查权限/资源后重试 | 跳 Tracker 详情精调 |
| `adjust_budget` | 调整预算/额度 | 跳 settings/billing |
| `wait_and_rerun` | 稍等再试(冷却 1-2 分钟) | 跳 toast 提示 + 调 triggerTask |

### 协议层落点

`recovery_actions` 字段在三层都有定义,改时同步:

1. 后端 utils.py:`make_recovery_action(kind=..., label=..., model=...)` 工厂
2. envelope payload:`notify_run_failed` 透传 `payload.recovery_actions`
3. 前端 chat-client:`packages/tabtin-chat-client/src/types/session.ts`
   `RecoveryAction` 类型 + `TrackerRunMeta.recovery_actions?`

## 现有 Skill

- [`tabtracker/`](tabtracker/) — Tracker 管理(创建/列表/暂停/恢复/触发)

## 相关文档

- 能力总览:[`docs/overview/tracker-scheduler-capability-overview.md`](../../docs/overview/tracker-scheduler-capability-overview.md)
- 问题总览:[`docs/overview/tracker-scheduler-issues-overview.md`](../../docs/overview/tracker-scheduler-issues-overview.md)
- App 开发:[`support/app/`](../../support/app/)
