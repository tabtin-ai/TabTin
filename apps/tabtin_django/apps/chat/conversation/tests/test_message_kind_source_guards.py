"""
W1b 协议层 message_kind 源码级守护测试（plain pytest function，不依赖 DB）。


价值：防 W2+ 改 fork.py / reassembler / reconciliation / API 时误删 message_kind
字段拷贝行——CI 会立刻 fail。

为什么用 getsource 而不是行为测试：
- 行为测试需要 PG ConversationState + FTS Outbox 等跨库副作用，pytest 默认
  fixture（SQLite test substitute）跑不全
- 与"绝不 mock ORM"原则冲突——mock 这些跨库写会让测试失去意义
- 源码断言纯字面量匹配，零副作用 + 失败时定位精准（指明缺哪一行）
- 这些都是**结构性守护**（structural invariant），不是行为测试——属于"防回归"
  类型，源码层是最合适的层次

姊妹文件：`test_message_kind_history_api.py` 含 API 行为测试（继承 TestCase，
需要真 MySQL，conftest._REQUIRES_PG_NATIVE 标记 → 默认 skip）。
"""


def test_fork_sync_source_includes_message_kind_copy():
    """fork.py `_fork_copy_messages_sync` 源码必须含 `message_kind=msg.message_kind`。

    防 fork 后 tool_artifact 被 model default 打回 'llm'，前端按 LLM 主气泡
    渲染产物气泡导致视觉错乱。
    """
    from inspect import getsource
    from apps.chat.conversation.api import fork as fork_mod

    source = getsource(fork_mod._fork_copy_messages_sync)
    assert 'message_kind=msg.message_kind' in source, (
        "fork.py 同步路径漏拷 message_kind 字段——tool_artifact 会被 model "
        "default 打回 'llm'，前端按 LLM 主气泡渲染产物气泡导致视觉错乱。"
    )
    assert "metadata=dict(getattr(msg, 'metadata', None) or {})" in source


def test_fork_async_source_includes_message_kind_copy():
    """conversation/tasks.py 异步 fork 源码必须含 `message_kind=msg.message_kind`。"""
    from inspect import getsource
    from apps.chat.conversation import tasks as conv_tasks

    source = getsource(conv_tasks)
    assert 'message_kind=msg.message_kind' in source, (
        "conversation/tasks.py fork async 路径漏拷 message_kind 字段——"
        "tool_artifact 会被 model default 打回 'llm'。"
    )
    assert "metadata=dict(msg.metadata or {})" in source


# NOTE：原 `test_reassembler_writer_includes_message_kind_create_kwargs` 与
# `test_reconciliation_worker_includes_message_kind_copy` 已随「6 件套降 transient、
# assistant 落库唯一权威 persist_message」删除——reassembler 服务端重建落库路径与
# reconciliation 兜底 worker 均已移除，无源码可守护。persist_message 路径的
# message_kind 落库由 `test_message_kind_history_api` 行为测试覆盖。


def test_chat_message_schema_has_message_kind_and_has_artifacts_fields():
    """ChatMessageSchema Pydantic field 必须含 message_kind + has_artifacts。

    防 W2+ 删 schema 字段或改名导致前端解析失败。
    """
    from apps.chat.conversation.schemas import ChatMessageSchema

    field_names = set(ChatMessageSchema.model_fields.keys())
    assert 'message_kind' in field_names, (
        "ChatMessageSchema 漏 message_kind 字段——前端按 message_kind 路由 UI "
        "形态依赖此字段，缺失会导致前端 fallback 'llm' 渲染所有气泡。"
    )
    assert 'has_artifacts' in field_names, (
        "ChatMessageSchema 漏 has_artifacts 字段——前端\"展开产物气泡\"依赖此 "
        "字段判定 LLM 主消息是否有同 run_id 的 tool_artifact。"
    )

    message_kind_field = ChatMessageSchema.model_fields['message_kind']
    annotation_str = str(message_kind_field.annotation)
    for kind in ('llm', 'tool_artifact', 'error_envelope'):
        assert kind in annotation_str, (
            f"ChatMessageSchema.message_kind enum 漏 '{kind}' —— "
            f"实际 annotation={annotation_str}"
        )


def test_history_api_includes_expand_artifacts_query_param():
    """历史 API endpoint 源码必须含 expand_artifacts 入参 + SQL 过滤逻辑。

    防 W2+ 误删 expand_artifacts 参数导致响应体积失控（5 次 web_search →
    50KB+ 响应）。
    """
    from inspect import getsource
    from apps.chat.conversation.api import message as msg_api

    source = getsource(msg_api.get_messages)
    assert 'expand_artifacts' in source, (
        "历史 API 漏 expand_artifacts 入参——PRD §3.6.4 默认懒加载 tool_artifact "
        "策略失效，响应体积会失控。"
    )
    assert "exclude(message_kind='tool_artifact')" in source, (
        "历史 API 漏 SQL 过滤 `exclude(message_kind='tool_artifact')`——"
        "expand_artifacts=false 时仍会返回 tool_artifact 行。"
    )
    assert 'has_artifacts' in source, (
        "历史 API 漏 has_artifacts 字段计算——前端\"展开产物气泡\"按钮没法显示。"
    )


def test_history_api_updated_after_uses_updated_at():
    """增量对账必须按消息更新时间过滤，而不是创建时间。

    assistant 消息会先创建后补写 content_blocks / metadata；如果继续用
    created_at__gt，弱网重连后的客户端会永久补不到已存在消息的后续修正。
    """
    from inspect import getsource
    from apps.chat.conversation.api import message as msg_api

    source = getsource(msg_api.get_messages)
    assert 'updated_at__gt' in source
    assert 'updated_at__lte=sync_watermark' in source
    assert 'created_at__gt=updated_after_dt' not in source
    assert 'updated_before' in source
    assert 'server_timestamp=sync_watermark' in source


def test_chat_message_schema_includes_updated_at():
    from apps.chat.conversation.schemas import ChatMessageSchema

    assert 'updated_at' in ChatMessageSchema.model_fields
    assert 'client_event_id' in ChatMessageSchema.model_fields


def test_chat_message_model_has_message_kind_field():
    """ChatMessage model 必须有 message_kind CharField，default='llm'。

    防 W2+ 删 model 字段导致 ORM 写库 NULL / IntegrityError。
    """
    from apps.chat.conversation.models import ChatMessage

    field = ChatMessage._meta.get_field('message_kind')
    assert field.__class__.__name__ == 'CharField', (
        f"ChatMessage.message_kind 字段类型应为 CharField，实际 {field.__class__.__name__}"
    )
    assert field.default == 'llm', (
        f"ChatMessage.message_kind default 应为 'llm'，实际 {field.default!r}—— "
        f"老消息 / 漏写场景需要 default 兜底"
    )
    assert field.max_length == 24, (
        f"ChatMessage.message_kind max_length 应为 24，实际 {field.max_length}—— "
        f"留 buffer 防未来新增 kind 名变长"
    )
    #  加 environment_context；#4999 加 hitl_interaction；#7289 加 agent_profile_context；
    # system_prompt_context 用于持久化每轮实际生效的 system prompt。
    expected_choices = {
        'llm',
        'tool_artifact',
        'error_envelope',
        'environment_context',
        'agent_profile_context',
        'system_prompt_context',
        'compaction_summary',
        'hitl_interaction',
        'external_archive_context',
    }
    actual_choices = {c[0] for c in (field.choices or [])}
    assert actual_choices == expected_choices, (
        f"ChatMessage.message_kind choices 应为 {expected_choices}，"
        f"实际 {actual_choices}"
    )
