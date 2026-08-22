"""Agent 会话运营摘要 API 的纯单元测试。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import uuid

import pytest


def _trace(*, status="completed", error=None, session_id=None):
    return SimpleNamespace(
        status=status,
        error=error,
        session_id=session_id,
    )


def test_thread_overview_hides_runtime_payload_and_returns_session_facts():
    from apps.services.agent_engine.api.agentdash_api import get_thread_overview

    session_id = uuid.uuid4()
    trace = _trace(session_id=str(session_id))
    message = SimpleNamespace(
        id=uuid.uuid4(),
        role="user",
        message_kind="llm",
        text_summary="请帮我整理本周经营数据",
        content_blocks_json=[
            {"type": "text", "text": "请帮我整理本周经营数据"},
            {
                "type": "image",
                "file_id": "img-1",
                "filename": "shot.png",
                "mime_type": "image/png",
                "url": "https://cdn.example.com/shot.png",
            },
        ],
        trace_id=uuid.uuid4(),
        agent_run_id="run-1",
        model_name_snapshot="Test Model",
        stop_reason=None,
        usage_json={"input_tokens": 12},
        error_info_json=None,
        subagent_run_id="",
        created_at=SimpleNamespace(isoformat=lambda: "2026-07-29T10:00:00+08:00"),
    )
    message_qs = MagicMock()
    context_message = SimpleNamespace(
        role="user",
        message_kind="environment_context",
        agent_run_id="",
        text_summary='<context type="environment">内部上下文</context>',
        metadata={},
    )
    message_qs.__iter__.return_value = iter([context_message, message])

    session = MagicMock(
        id=session_id,
        title="经营周报",
        status="active",
        is_paused=False,
        user_id=uuid.uuid4(),
        organization_id="org-1",
        workspace_id=None,
        project_id=None,
        agent_id=None,
        agent_mode="agent",
        context_tier_id="",
        input_tokens=12,
        output_tokens=8,
        total_tokens=20,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
        compaction_count=0,
        forked_from_id=None,
        revert_at=None,
    )
    session.user.get_display_name.return_value = "运营同学"
    session.workspace = None
    session.project = None
    session.agent = None
    session.current_model = None
    session.created_at.isoformat.return_value = "2026-07-29T10:00:00+08:00"
    session.last_message_at.isoformat.return_value = "2026-07-29T10:01:00+08:00"
    session.messages.order_by.return_value = message_qs

    trace_qs = MagicMock()
    trace_qs.exists.return_value = True
    trace_qs.__iter__.return_value = iter([trace])
    scoped_trace_qs = MagicMock()
    excluded_trace_qs = MagicMock()
    excluded_trace_qs.order_by.return_value = [trace]
    scoped_trace_qs.exclude.return_value = excluded_trace_qs
    trace_qs.filter.return_value = scoped_trace_qs
    session_qs = MagicMock()
    session_qs.filter.return_value.first.return_value = session
    organization_qs = MagicMock()
    organization_qs.values_list.return_value.first.return_value = "示例组织"

    with patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace.objects.filter",
        return_value=trace_qs,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api.ChatSession.objects.select_related",
        return_value=session_qs,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api.Organization.objects.filter",
        return_value=organization_qs,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api._lazy_heal_session_persist_buckets",
        return_value=0,
    ):
        result = get_thread_overview(MagicMock(), "chat-session-test")

    assert result["session"]["title"] == "经营周报"
    assert result["session"]["user_name"] == "运营同学"
    assert result["session"]["organization_name"] == "示例组织"
    assert result["session"]["message_count"] == 1
    assert len(result["messages"]) == 1
    assert result["messages"][0]["content"] == "请帮我整理本周经营数据"
    assert result["messages"][0]["attachments"] == [
        {
            "kind": "image",
            "filename": "shot.png",
            "source": "user",
            "file_id": "img-1",
            "mime_type": "image/png",
            "url": "https://cdn.example.com/shot.png",
        }
    ]
    assert "input" not in result["messages"][0]
    assert "output" not in result["messages"][0]
    assert "content_blocks_json" not in result["messages"][0]
    trace_qs.filter.assert_called_once_with(started_at__gte=session.created_at)


def test_extract_message_attachments_user_and_agent_files():
    from apps.services.agent_engine.api.agentdash_api import _extract_message_attachments

    blocks = [
        {
            "type": "file",
            "file_id": "pdf-1",
            "filename": "a.pdf",
            "mime_type": "application/pdf",
            "url": "https://cdn.example.com/a.pdf",
        },
        {
            "type": "tabtin_rich_content",
            "kind": "file",
            "summary": "chart.png",
            "payload": {
                "artifact_kind": "oss_file",
                "file_id": "agent-1",
                "filename": "chart.png",
                "mime_type": "image/png",
                "access_url": "https://cdn.example.com/chart.png",
                "url": "tabtin://resource/file/agent-1",
            },
        },
        {"type": "text", "text": "说明"},
    ]
    out = _extract_message_attachments(blocks)
    assert out[0]["filename"] == "a.pdf"
    assert out[0]["source"] == "user"
    assert out[1]["filename"] == "chart.png"
    assert out[1]["source"] == "agent"
    assert out[1]["url"] == "https://cdn.example.com/chart.png"
    assert out[1]["kind"] == "image"


def test_extract_message_attachments_from_markdown_resource_links():
    from apps.services.agent_engine.api.agentdash_api import _extract_message_attachments

    content = (
        "文档创建成功！\n\n"
        "**[萌猫档案](tabtin://resource/document/056c501e-a833-4d2f-a86d-fd0ef84e9547?hint=tabdoc)**\n"
    )
    out = _extract_message_attachments([], content)
    assert len(out) == 1
    assert out[0]["kind"] == "document"
    assert out[0]["source"] == "agent"
    assert out[0]["filename"] == "萌猫档案"
    assert out[0]["resource_type"] == "document"
    assert out[0]["resource_id"] == "056c501e-a833-4d2f-a86d-fd0ef84e9547"
    assert out[0]["url"].startswith("tabtin://resource/document/")


def test_extract_message_attachments_resource_ref_block():
    from apps.services.agent_engine.api.agentdash_api import _extract_message_attachments

    blocks = [
        {
            "type": "tabtin_rich_content",
            "kind": "resource_ref",
            "summary": "经营周报",
            "payload": {
                "artifact_kind": "platform_resource",
                "resource_type": "document",
                "resource_id": "doc-42",
                "resource_name": "经营周报",
                "url": "tabtin://resource/document/doc-42?hint=tabdoc",
            },
        }
    ]
    out = _extract_message_attachments(blocks)
    assert out == [
        {
            "kind": "document",
            "filename": "经营周报",
            "source": "agent",
            "url": "tabtin://resource/document/doc-42?hint=tabdoc",
            "resource_type": "document",
            "resource_id": "doc-42",
        }
    ]


def test_label_for_model_key_maps_codex_and_passthrough():
    from apps.services.agent_engine.api.agentdash_api import _label_for_model_key

    assert _label_for_model_key("gpt-5.6-sol") == "GPT-5.6 Sol"
    assert _label_for_model_key("gpt-5.6-terra") == "GPT-5.6 Terra"
    assert _label_for_model_key("custom-local-model") == "custom-local-model"


def test_resolve_session_model_name_prefers_db_snapshot_over_current_model():
    """#9039：Codex 实际执行优先于 ChatSession.current_model FK（查全库最新 snapshot）。"""
    from apps.services.agent_engine.api.agentdash_api import _resolve_session_model_name

    current = SimpleNamespace(display_name="Kimi K2.7 Code", model_name="kimi-k2.7-code")
    session = SimpleNamespace(current_model=current, messages=MagicMock())
    session.messages.filter.return_value.exclude.return_value.order_by.return_value.values_list.return_value.first.return_value = (
        "gpt-5.6-sol"
    )
    # 截断窗口里的旧消息不得覆盖 DB 最新 snapshot
    stale_window = [{"role": "assistant", "model_name": "Old Model"}]
    assert _resolve_session_model_name(session, stale_window, []) == "GPT-5.6 Sol"


def test_resolve_session_model_name_falls_back_to_trace_by_model():
    from apps.services.agent_engine.api.agentdash_api import _resolve_session_model_name

    current = SimpleNamespace(display_name="Kimi K2.7 Code", model_name="kimi-k2.7-code")
    session = SimpleNamespace(current_model=current, messages=MagicMock())
    session.messages.filter.return_value.exclude.return_value.order_by.return_value.values_list.return_value.first.return_value = None

    with patch(
        "apps.services.agent_engine.api.agentdash_api._latest_trace_model_key",
        return_value="gpt-5.6-sol",
    ):
        assert _resolve_session_model_name(session, [], [SimpleNamespace(pk=1)]) == "GPT-5.6 Sol"


def test_thread_overview_reports_latest_trace_error():
    from apps.services.agent_engine.api.agentdash_api import get_thread_overview

    traces = [
        _trace(status="error", error="第一次失败"),
        _trace(status="completed"),
        _trace(status="error", error="最近一次失败"),
    ]
    trace_qs = MagicMock()
    trace_qs.exists.return_value = True
    excluded_trace_qs = MagicMock()
    excluded_trace_qs.order_by.return_value = traces
    trace_qs.exclude.return_value = excluded_trace_qs
    session_qs = MagicMock()
    session_qs.filter.return_value.first.return_value = None

    with patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace.objects.filter",
        return_value=trace_qs,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api.ChatSession.objects.select_related",
        return_value=session_qs,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api._lazy_heal_session_persist_buckets",
        return_value=0,
    ):
        result = get_thread_overview(MagicMock(), f"chat-session-{uuid.uuid4()}")

    assert result["trace_summary"] == {
        "total": 3,
        "completed": 1,
        "running": 0,
        "error": 2,
        "latest_error": "最近一次失败",
    }


@pytest.mark.django_db(databases=["default"])
def test_list_threads_excludes_persist_buckets_and_survives_pg_filter():
    """#8836 / ：走 list_threads 本体——persist 桶不进列表，且不触发 PG FILTER 聚合错误。"""
    from django.utils import timezone

    from apps.services.agent_engine.api.agentdash_api import list_threads
    from apps.services.agent_engine.models import ExecutionTrace

    now = timezone.now()
    persist_only_thread = f"chat-session-persist-only-{uuid.uuid4()}"
    mixed_thread = f"chat-session-mixed-{uuid.uuid4()}"
    persist_session = str(uuid.uuid4())
    mixed_session = str(uuid.uuid4())

    # 仅 persist 桶：整 thread 应从列表消失
    ExecutionTrace.objects.create(
        thread_id=persist_only_thread,
        graph_type="local-runtime",
        session_id=persist_session,
        trace_id=uuid.UUID(persist_session),
        status="running",
        user_id="u-persist",
    )
    # 混合：桶 + 真实 completed/running；计数只看真实 trace
    ExecutionTrace.objects.create(
        thread_id=mixed_thread,
        graph_type="local-runtime",
        session_id=mixed_session,
        trace_id=uuid.UUID(mixed_session),
        status="running",
        user_id="u-mixed",
    )
    ExecutionTrace.objects.create(
        thread_id=mixed_thread,
        graph_type="local-runtime",
        session_id=mixed_session,
        trace_id=uuid.uuid4(),
        status="completed",
        ended_at=now,
        user_id="u-mixed",
    )
    ExecutionTrace.objects.create(
        thread_id=mixed_thread,
        graph_type="local-runtime",
        session_id=mixed_session,
        trace_id=uuid.uuid4(),
        status="running",
        user_id="u-mixed",
    )

    class _Req:
        auth = SimpleNamespace(is_superuser=True)

    # 旧实现这里会 ProgrammingError；修好后必须成功返回
    result = list_threads(_Req(), page=1, page_size=100, keyword="chat-session-")
    items_by_thread = {item["thread_id"]: item for item in result["items"]}

    assert persist_only_thread not in items_by_thread
    mixed = items_by_thread.get(mixed_thread)
    assert mixed is not None, result["items"]
    assert mixed["trace_count"] == 2
    assert mixed["status_stats"]["completed"] == 1
    assert mixed["status_stats"]["running"] == 1
    assert mixed["status_stats"]["error"] == 0


def test_list_threads_filters_and_displays_user_phone():
    from apps.services.agent_engine.api.agentdash_api import (
        _matching_user_ids,
        _serialize_thread_summary,
    )

    user_query = MagicMock()
    user_query.values_list.return_value.__getitem__.return_value = ["user-1"]
    with patch(
        "apps.services.agent_engine.api.agentdash_api.User.objects.filter",
        return_value=user_query,
    ) as filter_mock:
        assert _matching_user_ids("13800138000") == ["user-1"]

    assert "phone__icontains" in str(filter_mock.call_args.args[0])
    user = SimpleNamespace(phone="+8613800138000", get_display_name=lambda: "手机号筛选用户")
    session = SimpleNamespace(
        id=uuid.uuid4(),
        title="手机号筛选会话",
        user_id="user-1",
        user=user,
        organization_id="org-1",
    )
    row = {
        "thread_id": "chat-session-1",
        "session_id": str(session.id),
        "user_id": "user-1",
        "organization_id": "org-1",
        "trace_count": 1,
        "first_started_at": None,
        "latest_started_at": None,
        "completed_count": 1,
        "running_count": 0,
        "error_count": 0,
    }

    result = _serialize_thread_summary(
        row,
        {"chat-session-1": 0},
        sessions_by_thread={"chat-session-1": session},
        organization_names={"org-1": "示例组织"},
    )
    assert result["user_phone"] == "+8613800138000"


def test_session_persist_bucket_detection_and_visibility():
    """#8836：session_id==trace_id 的 local-runtime 桶应识别并隐藏。"""
    from apps.services.agent_engine.api.agentdash_api import (
        _is_session_persist_bucket,
        _visible_thread_traces,
    )

    session_id = str(uuid.uuid4())
    zombie = SimpleNamespace(
        pk=1,
        id=1,
        status="running",
        ended_at=None,
        session_id=session_id,
        trace_id=session_id,
        graph_type="local-runtime",
    )
    real_run = SimpleNamespace(
        pk=2,
        id=2,
        status="running",
        ended_at=None,
        session_id=session_id,
        trace_id=uuid.uuid4(),
        graph_type="local-runtime",
    )
    assert _is_session_persist_bucket(zombie) is True
    assert _is_session_persist_bucket(real_run) is False

    with patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace.objects.filter"
    ) as filter_mock:
        update_mock = MagicMock(return_value=1)
        filter_mock.return_value.update = update_mock
        visible = _visible_thread_traces([zombie, real_run])

    assert visible == [real_run]
    filter_mock.assert_called_once_with(pk__in=[1], status="running")
    update_mock.assert_called_once()
    assert update_mock.call_args.kwargs["status"] == "completed"
    assert "ended_at" in update_mock.call_args.kwargs


def test_thread_chat_messages_export_includes_content_blocks_and_hides_context():
    from apps.services.agent_engine.api.agentdash_api import get_thread_chat_messages

    session_id = uuid.uuid4()
    blocks = [{"type": "text", "text": "请帮我整理本周经营数据"}]
    message = SimpleNamespace(
        id=uuid.uuid4(),
        role="assistant",
        message_kind="llm",
        text_summary="请帮我整理本周经营数据",
        content_blocks_json=blocks,
        trace_id=uuid.uuid4(),
        agent_run_id="run-1",
        model_name_snapshot="Test Model",
        stop_reason=None,
        usage_json={"input_tokens": 12},
        error_info_json=None,
        subagent_run_id="",
        created_at=SimpleNamespace(isoformat=lambda: "2026-07-29T10:00:00+08:00"),
    )
    context_message = SimpleNamespace(
        role="user",
        message_kind="environment_context",
        agent_run_id="",
        text_summary='<context type="environment">内部上下文</context>',
        content_blocks_json=[{"type": "text", "text": "内部"}],
        metadata={},
    )
    message_qs = MagicMock()
    message_qs.__iter__.return_value = iter([context_message, message])

    session = MagicMock(id=session_id)
    session.messages.order_by.return_value = message_qs
    session.messages.filter.return_value.order_by.return_value.__getitem__.return_value = []

    system = {
        "sections": [
            {
                "name": "identity",
                "source": "base-prompt",
                "charCount": 12,
                "contentPreview": "你是小Tin。",
            }
        ],
        "charCount": 12,
    }
    llm_snapshot = SimpleNamespace(
        run_id="run-snap",
        iteration=3,
        model="kimi",
        snapshot_json={"system": system, "model": "kimi"},
        created_at=SimpleNamespace(isoformat=lambda: "2026-07-29T10:02:00+08:00"),
        updated_at=SimpleNamespace(isoformat=lambda: "2026-07-29T10:03:00+08:00"),
    )
    snap_qs = MagicMock()
    snap_qs.order_by.return_value.first.return_value = llm_snapshot
    snap_qs.order_by.return_value.__getitem__.return_value = [llm_snapshot]

    with patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace.objects.filter",
        return_value=[],
    ), patch(
        "apps.services.agent_engine.api.agentdash_api._resolve_chat_session",
        return_value=session,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api.ChatLLMSnapshot.objects.filter",
        return_value=snap_qs,
    ):
        result = get_thread_chat_messages(MagicMock(), f"chat-session-{session_id}")

    assert result["source"] == "chat_message"
    assert result["session_id"] == str(session_id)
    assert result["message_count"] == 1
    assert result["messages_truncated"] is False
    assert len(result["messages"]) == 1
    assert result["messages"][0]["content_blocks_json"] == blocks
    assert result["messages"][0]["content"] == "请帮我整理本周经营数据"
    assert result["messages"][0]["model_name"] == "Test Model"
    assert result["messages"][0]["model_display_name"] == "Test Model"
    assert result["model"] == {
        "id": "Test Model",
        "display_name": "Test Model",
        "source": "assistant_message",
    }
    assert result["system"] == system
    assert result["system_source"]["kind"] == "chat_llm_snapshot"
    assert result["system_source"]["run_id"] == "run-snap"
    assert result["system_source"]["iteration"] == 3
    assert result["system_source"]["model"] == "kimi"
    assert result["system_source"]["model_display_name"] == "kimi"
    assert result["llm_snapshot_count"] == 1
    assert result["llm_snapshots_truncated"] is False
    assert result["llm_snapshots"] == [
        {
            "run_id": "run-snap",
            "iteration": 3,
            "model": "kimi",
            "model_display_name": "kimi",
            "created_at": "2026-07-29T10:02:00+08:00",
            "updated_at": "2026-07-29T10:03:00+08:00",
            "snapshot": {"system": system, "model": "kimi"},
        }
    ]


def test_thread_chat_messages_export_falls_back_to_system_prompt_context():
    from apps.services.agent_engine.api.agentdash_api import get_thread_chat_messages

    session_id = uuid.uuid4()
    message = SimpleNamespace(
        id=uuid.uuid4(),
        role="user",
        message_kind="llm",
        text_summary="你好",
        content_blocks_json=[{"type": "text", "text": "你好"}],
        trace_id=None,
        agent_run_id=None,
        model_name_snapshot=None,
        stop_reason=None,
        usage_json=None,
        error_info_json=None,
        subagent_run_id="",
        created_at=SimpleNamespace(isoformat=lambda: "2026-07-29T10:00:00+08:00"),
    )
    prompt = SimpleNamespace(
        id=uuid.uuid4(),
        role="user",
        message_kind="system_prompt_context",
        text_summary="<identity>你是小Tin</identity>",
        content_blocks_json=[{"type": "text", "text": "<identity>你是小Tin</identity>"}],
        created_at=SimpleNamespace(isoformat=lambda: "2026-07-29T09:59:00+08:00"),
    )
    message_qs = MagicMock()
    message_qs.__iter__.return_value = iter([prompt, message])

    session = MagicMock(id=session_id)
    session.messages.order_by.return_value = message_qs
    prompt_qs = MagicMock()
    prompt_qs.order_by.return_value.__getitem__.return_value = [prompt]
    session.messages.filter.return_value = prompt_qs

    snap_qs = MagicMock()
    snap_qs.order_by.return_value.first.return_value = None
    snap_qs.order_by.return_value.__getitem__.return_value = []

    with patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace.objects.filter",
        return_value=[],
    ), patch(
        "apps.services.agent_engine.api.agentdash_api._resolve_chat_session",
        return_value=session,
    ), patch(
        "apps.services.agent_engine.api.agentdash_api.ChatLLMSnapshot.objects.filter",
        return_value=snap_qs,
    ):
        result = get_thread_chat_messages(MagicMock(), f"chat-session-{session_id}")

    assert result["system_source"]["kind"] == "system_prompt_context"
    assert result["llm_snapshot_count"] == 0
    assert result["llm_snapshots_truncated"] is False
    assert result["llm_snapshots"] == []
    assert result["system"]["sections"][0]["name"] == "system_prompt_context"
    assert "你是小Tin" in result["system"]["sections"][0]["contentPreview"]
    assert result["messages"][0]["content"] == "你好"
