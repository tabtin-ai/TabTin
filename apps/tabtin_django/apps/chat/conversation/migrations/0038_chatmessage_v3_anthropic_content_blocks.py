"""W3 §3.3.1 ChatMessage 字段重做（Anthropic ContentBlock 协议对齐 · 一步到位）。

== 背景 ==

W2 完成后 daemon 端已 emit Anthropic 6 件套（`message_*` + `content_block_*`），
但 Django 后端 `chat_message` 表仍是 v1/v2 时代的 `blocks_json` + `content` +
`attachments_json` + `agent_type` + `intent` + `intent_confidence` + `error_code`
+ `blocks_trimmed_at` 八字段散乱状态——格式不兼容 Anthropic ContentBlock[]。

W4a 临时桥（`packages/agent-runtime/src/engine/lite-blocks-collector.ts`）通过
inject `agent.stream.assistant(phase='final', blocks_json=...)` 让 Django 现有
`_write_chat_messages` 路径能把 daemon 6 件套消费成的 blocks 落到老 `blocks_json`
字段。这是临时方案——W3 完成后 Django 直接消费 6 件套并落到 `content_blocks_json`，
临时桥 `LITE_COLLECTOR_ENABLED=false` 即可拆除。

== 变更（v3 §3.3.7 修订：硬切，不留 ARCHIVE 表） ==

**Drop 老字段**（v1/v2 残留）：
- `content`            ← text_summary 顶替（由 ContentBlockReassembler 反推）
- `blocks_json`        ← content_blocks_json 顶替（Anthropic ContentBlock[]）
- `attachments_json`   ← 已并入 content_blocks_json 的 image / document / file 块
- `agent_type`         ← 删除（external Agent 元信息迁到 metadata）
- `intent`             ← 删除（识别意图字段下线）
- `intent_confidence`  ← 删除
- `blocks_trimmed_at`  ← 重命名为 content_blocks_trimmed_at（语义不变）

注：v2 §3.3.1 表里曾列 `error_code` 为待删字段，但 ChatMessage 实际从未有过
此字段（0001_initial 起就没有）——v2 文档误标，本 migration 不动它。结构化
错误统一收口到新 `error_info_json` 字段。

**Add 新字段**（v3 §3.3.1 表）：
- `content_blocks_json` JSONField default=list   核心：ContentBlock[] schema
- `text_summary` TextField                       兜底/搜索：text 块前 200 字
- `error_info_json` JSONField nullable           ErrorInfo 结构化错误
- `usage_json` JSONField nullable                TokenUsage 结构化 token
- `model_name_snapshot` CharField(100)           写盘瞬间 displayName
- `stop_reason` CharField(32)                    end_turn / aborted / ...
- `subagent_run_id` CharField(64)                识别 subagent 输出
- `checkpoint_anchor_block_id` CharField(64)     block 粒度 checkpoint 锚点
- `checkpoint_anchor_block_index` IntegerField   双锚定（防 trim 重排）
- `content_blocks_trimmed_at` DateTimeField      trim 任务标记（重命名）

**新增索引**：`(session_id, created_at, role)` 复合索引——会话+时间+角色
组合查询热路径（API list 模式 + 会话刷新 + reconciliation worker 扫描）。

== 数据策略：硬切 TRUNCATE ==

v3 总控 §3.3.7 修订决策：**产品未上线，无用户数据要保护**——硬切 TRUNCATE。
不留 ARCHIVE 表（v2 §3.3.7 原方案被 v3 推翻，理由：开发期数据无合规要求）。

`RunPython._truncate_chat_message_tables` 负责：
1. TRUNCATE chat_message  （MySQL）
2. TRUNCATE agent_engine_conversation_states  （PG）
3. 重置 ChatSession 的 token 累计字段 + last_message_at（否则与空 message 表不一致）

reverse 不实现 TRUNCATE 反向（数据已清空无法恢复）；只反向 schema 变更。

== 跨库 alias ==

chat_message 在 default (MySQL)，conversation_state 在 postgresql (PG)。
RunPython 内部 `if schema_editor.connection.alias != "default": return` 保证只
在 default alias 跑一次；conversation_state TRUNCATE 用显式 cursor with PG
connection 走，不依赖 schema_editor。

== 不可逆性 ==

- 删字段 + drop column 不可逆（数据物理删除）。
- TRUNCATE 不可逆（数据物理删除）。
- 上线前已通知团队群（v3 上线日 protocol）："对话历史会被清空，新协议从空开始"。

== 失败回滚预案 ==

如果 W3 上线后发现严重问题需要回滚：
1. 执行 `python manage.py migrate conversation 0037`（reverse 0038）
2. schema 回到老形态，但**老数据已 TRUNCATE 不可恢复**——用户对话历史从空开始
3. 客户端老版本能继续用（API 字段名变化由 W3 §3.3.5 兼容层处理）
"""

from django.db import migrations, models


def _truncate_chat_message_tables(apps, schema_editor):
    """硬切：TRUNCATE chat_message + DROP 老 FULLTEXT 索引 + 重置 ChatSession 累计字段。

    跨库注意：
    - chat_message 在 default (MySQL)
    - conversation_state 在 postgresql (PG)
    本函数只 TRUNCATE default alias 的表；conversation_state 由独立路径处理
    （见 apps/services/agent_engine/migrations/0012_truncate_conversation_state_for_w3.py）。

    DROP 老 FULLTEXT INDEX：0024 migration 在 chat_message.content 上建了
    FULLTEXT(content) ngram 索引。0038 RemoveField 之前显式 DROP INDEX 让
    schema 改动更稳（不依赖 MySQL 自动级联 DROP 行为）。
    """
    if schema_editor.connection.alias != "default":
        return

    vendor = schema_editor.connection.vendor
    with schema_editor.connection.cursor() as cursor:
        if vendor == "mysql":
            # 1. 先 DROP 老 FULLTEXT 索引（防 fresh setup 跳 0024 的 case）
            try:
                cursor.execute("ALTER TABLE `chat_message` DROP INDEX `ft_msg_content`")
            except Exception:
                # FULLTEXT 索引不存在或已被 dropped — 静默忽略（fresh setup 可能跳过 0024）
                # 注：MySQL 容忍语句出错后继续事务；PG 不容忍，故此 try/except 仅限 MySQL 分支。
                pass
            # 2. TRUNCATE chat_message（MySQL 反引号标识符；自动重置 AUTO_INCREMENT）
            cursor.execute("TRUNCATE TABLE `chat_message`")
        elif vendor == "postgresql":
            # PG 无 MySQL FULLTEXT 索引；主键为 UUID 无需 RESTART IDENTITY，直接清空。
            cursor.execute("TRUNCATE TABLE chat_message")
        else:
            # SQLite 等不支持 TRUNCATE，用 DELETE 清空。
            cursor.execute("DELETE FROM chat_message")

    # 重置 ChatSession 累计字段——chat_message 清空后，token / last_message_at 也应归零
    # 否则会出现"会话显示有 100K tokens 但消息列表为空"的诡异状态
    ChatSession = apps.get_model("conversation", "ChatSession")
    ChatSession.objects.using("default").update(
        input_tokens=0,
        output_tokens=0,
        total_tokens=0,
        context_tokens=0,
        compaction_count=0,
        last_message_at=None,
        last_compaction_at=None,
        memory_extracted_index=0,
        memory_settled=False,
        memory_quick_settled=False,
    )


def _no_truncate_reverse(apps, schema_editor):
    """反向 noop：TRUNCATE 不可逆——数据已物理删除，反向只能让 schema 回老形态。"""
    if schema_editor.connection.alias != "default":
        return
    # 不做任何事——数据已清空


class Migration(migrations.Migration):

    # MySQL `chat_message` 在 default alias；本 migration 只跑在 default
    # （DefaultDatabaseRouter `allow_migrate` 已经卡了，但 RunPython 内再 alias
    # guard 一层更稳）

    dependencies = [
        ("conversation", "0037_align_chat_session_space_indexes"),
    ]

    operations = [
        # ── Step 1: TRUNCATE 老数据（在 schema 变更前先清空，避免 drop 字段时
        #   留 NOT NULL default 约束触发慢 ALTER TABLE） ─────────────────────
        migrations.RunPython(_truncate_chat_message_tables, reverse_code=_no_truncate_reverse),

        # ── Step 2: Add 新字段（v3 §3.3.1 表 10 个字段） ─────────────────
        migrations.AddField(
            model_name="chatmessage",
            name="content_blocks_json",
            field=models.JSONField(
                default=list, blank=True,
                verbose_name="ContentBlock 数组",
                help_text="严格按 Anthropic ContentBlock[] schema（v3 §2.2）；含 text / "
                          "tool_use / tool_result / thinking / image / document / "
                          "tabtin_* 等所有结构化块类型",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="text_summary",
            field=models.TextField(
                blank=True, default="",
                verbose_name="文本摘要",
                help_text="content_blocks_json 中 text 块前 200 字的拼接，用于会话列表 / 全文搜索",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="error_info_json",
            field=models.JSONField(
                null=True, blank=True, default=None,
                verbose_name="结构化错误信息",
                help_text="ErrorInfo: { error_class, error_message, suggested_action, "
                          "category: aborted/timeout/protocol_error/runtime_failed/budget_exceeded }",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="usage_json",
            field=models.JSONField(
                null=True, blank=True, default=None,
                verbose_name="Token 用量",
                help_text="TokenUsage: { input_tokens, output_tokens, "
                          "cache_creation_input_tokens?, cache_read_input_tokens? }；"
                          "Anthropic 协议 cumulative 语义（已是最终值，消费方不要再累加）",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="model_name_snapshot",
            field=models.CharField(
                max_length=100, blank=True, default="",
                verbose_name="模型名称快照",
                help_text="写盘瞬间的 LLMModel.display_name，与 model_id 双写防 LLMModel "
                          "后续重命名导致历史回看错",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="stop_reason",
            field=models.CharField(
                max_length=32, blank=True, default="",
                verbose_name="结束原因",
                help_text="end_turn / max_tokens / tool_use / stop_sequence / aborted / "
                          "pause_turn / refusal / error 等（开放枚举，与 Anthropic 协议对齐）",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="subagent_run_id",
            field=models.CharField(
                max_length=64, blank=True, default="",
                verbose_name="子 Agent run ID",
                help_text="识别本消息是否来自 subagent（非空时）；与 SubtaskRun.subagent_run_id 关联",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="checkpoint_anchor_block_id",
            field=models.CharField(
                max_length=64, blank=True, default="",
                verbose_name="Checkpoint 锚点 block ID",
                help_text="Checkpoint 落地瞬间该消息内某个 block 的 block_id 锚点，"
                          "配合 checkpoint_anchor_block_index 防 trim 重排错位",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="checkpoint_anchor_block_index",
            field=models.IntegerField(
                null=True, blank=True,
                verbose_name="Checkpoint 锚点 block index",
                help_text="锚点 block 在 content_blocks_json 数组中的 index（双锚定）",
            ),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="content_blocks_trimmed_at",
            field=models.DateTimeField(
                null=True, blank=True, default=None, db_index=True,
                verbose_name="content_blocks_json 瘦身时间",
                help_text="非空表示 content_blocks_json 已被定时任务瘦身（thinking / "
                          "tool_use.input / tool_result.content 等大字段被截断为 head + tail）",
            ),
        ),

        # ── Step 3: Drop 老字段（v3 §3.3.7 硬切；TRUNCATE 已在 Step 1 完成） ──
        migrations.RemoveField(model_name="chatmessage", name="content"),
        migrations.RemoveField(model_name="chatmessage", name="blocks_json"),
        migrations.RemoveField(model_name="chatmessage", name="attachments_json"),
        migrations.RemoveField(model_name="chatmessage", name="agent_type"),
        migrations.RemoveField(model_name="chatmessage", name="intent"),
        migrations.RemoveField(model_name="chatmessage", name="intent_confidence"),
        migrations.RemoveField(model_name="chatmessage", name="blocks_trimmed_at"),

        # ── Step 4: 新增 (session, created_at, role) 复合索引 ────────────
        migrations.AddIndex(
            model_name="chatmessage",
            index=models.Index(fields=["session", "created_at", "role"], name="chat_msg_sess_time_role_idx"),
        ),
    ]
