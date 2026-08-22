import os
import json
import uuid
import inspect
from io import StringIO
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

django.setup()

from apps.maintenance import admin_ops_api as ops
from apps.maintenance.models import FailedTaskRecord, OpsRuntimeActionLog, OpsRuntimeResolution
from apps.services.common.ws import runtime_snapshot
from apps.tabchat.services import centrifugo_runtime_sample
from apps.tabchat.services.centrifugo_service import CentrifugoService
from apps.rag.models import EmbeddingTask
from tabtin.runtime.registry import BEAT_REGISTRY, QUEUE_REGISTRY, WORKER_REGISTRY

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _enable_runtime_actions(settings):
    settings.OPS_RUNTIME_ACTIONS_ENABLED = True


def _request():
    request = Mock()
    request.auth.id = "admin-user-1"
    request.auth.is_superuser = True
    request.META = {"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "pytest"}
    return request


def _action_request(*, superuser=True, has_permission=True):
    request = _request()
    request.auth.is_superuser = superuser
    request.auth.has_perm = Mock(return_value=has_permission)
    request.auth.username = "runtime-admin"
    return request


def _payload(**overrides):
    data = {
        "target_type": "failed_sample",
        "target_id": "task-1",
        "source": "FailedTaskRecord",
        "queue": "unknown",
        "task_name": "unknown.task",
        "before_status": "failed",
        "ticket_id": "OPS-RUNTIME-1",
        "reason": "diagnose one failed task",
        "payload": {"api_key": "sk-secret", "note": "safe"},
    }
    data.update(overrides)
    return ops.OpsRuntimeActionRequest(**data)


def _worker_items():
    return [
        {
            "worker_name": worker_name,
            "display_name": meta["display_name"],
            "pod_names": [f"{worker_name}@pod"],
            "expected_queues": list(meta["queues"]),
            "actual_queues": list(meta["queues"]),
            "online": True,
            "concurrency": meta["concurrency_default"],
            "active": 0,
            "reserved": 0,
            "scheduled": 0,
            "last_heartbeat": None,
            "restart_count": None,
            "status": "healthy",
            "abnormal_type": "none",
            "diagnosis": "ok",
            "evidence": {},
        }
        for worker_name, meta in WORKER_REGISTRY.items()
    ]


def _queue_lengths(**overrides):
    lengths = {queue_name: 0 for queue_name in QUEUE_REGISTRY}
    lengths.update(overrides)
    return lengths


def test_runtime_queues_uses_registry_not_legacy_allowlist():
    with patch("apps.maintenance.admin_ops_api._runtime_queue_lengths", return_value=(_queue_lengths(), [])), \
         patch("apps.maintenance.admin_ops_api._runtime_worker_items", return_value=(_worker_items(), [])), \
         patch("apps.maintenance.admin_ops_api._runtime_failed_samples", return_value=([], {}, [])):
        response = ops.ops_runtime_queues(_request())

    queue_names = [item["queue_name"] for item in response["items"]]
    assert queue_names == list(QUEUE_REGISTRY.keys())
    assert len(queue_names) == 14
    assert "realtime_delivery" in queue_names
    assert "pptx_import_oss" in queue_names
    assert "celery" not in queue_names


def test_runtime_queue_detects_worker_not_consuming():
    worker_items = [
        item for item in _worker_items()
        if "tabdata_compute" not in (item.get("actual_queues") or [])
    ]
    with patch("apps.maintenance.admin_ops_api._runtime_queue_lengths", return_value=(_queue_lengths(tabdata_compute=5), [])), \
         patch("apps.maintenance.admin_ops_api._runtime_worker_items", return_value=(worker_items, [])), \
         patch("apps.maintenance.admin_ops_api._runtime_failed_samples", return_value=([], {}, [])):
        response = ops.ops_runtime_queues(_request())

    row = next(item for item in response["items"] if item["queue_name"] == "tabdata_compute")
    assert row["status"] == "critical"
    assert row["abnormal_type"] == "worker_not_consuming"


def test_runtime_queue_detects_program_error_without_backlog():
    with patch("apps.maintenance.admin_ops_api._runtime_queue_lengths", return_value=(_queue_lengths(), [])), \
         patch("apps.maintenance.admin_ops_api._runtime_worker_items", return_value=(_worker_items(), [])), \
         patch("apps.maintenance.admin_ops_api._runtime_failed_samples", return_value=([], {"default": 3}, [])):
        response = ops.ops_runtime_queues(_request())

    row = next(item for item in response["items"] if item["queue_name"] == "default")
    assert row["status"] == "warning"
    assert row["abnormal_type"] == "program_error"


def test_runtime_workers_returns_registry_workers_and_flags_missing_inspect():
    with patch("apps.maintenance.admin_ops_api._runtime_worker_snapshot", return_value=(None, ["inspect down"])):
        response = ops.ops_runtime_workers(_request())

    worker_names = [item["worker_name"] for item in response["items"]]
    assert worker_names == list(WORKER_REGISTRY.keys())
    assert len(worker_names) == 7
    assert response["status"] == "partial"
    assert all(item["actual_queues"] is None for item in response["items"])


def test_runtime_beat_returns_registry_even_without_periodic_task_rows():
    with patch("django_celery_beat.models.PeriodicTask.objects.filter", return_value=[]):
        response = ops.ops_runtime_beat(_request())

    beat_keys = [item["beat_key"] for item in response["items"]]
    assert beat_keys == list(BEAT_REGISTRY.keys())
    assert len(beat_keys) == len(BEAT_REGISTRY)
    assert all(item["status"] == "partial" for item in response["items"])


def test_unknown_failed_task_queue_is_not_faked():
    queue, queue_source, queue_confidence = ops._task_route_queue("unknown.task.name")

    assert queue == "unknown"
    assert queue_source == "unavailable"
    assert queue_confidence == "low"


def test_registered_task_without_explicit_queue_stays_unknown():
    with patch("apps.maintenance.admin_ops_api.current_app") as celery_app:
        celery_app.conf.task_routes = {}
        celery_app.tasks.get.return_value = SimpleNamespace(queue="")

        queue, queue_source, queue_confidence = ops._task_route_queue("registered.without.route")

    assert queue == "unknown"
    assert queue_source == "unavailable"
    assert queue_confidence == "low"


def test_runtime_overview_marks_phase2_modules_unsupported_outside_core_status():
    phase2 = [
        ops._runtime_phase2_item("ws_gateway", "WS Gateway"),
        ops._runtime_phase2_item("centrifugo", "Centrifugo"),
        ops._runtime_phase2_item("collab_live", "Collab Live"),
    ]
    with patch("apps.maintenance.admin_ops_api._runtime_queue_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_worker_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_beat_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_failed_samples", return_value=([], {}, [])), \
         patch("apps.maintenance.admin_ops_api._runtime_outbox_items", return_value=[]), \
         patch("apps.maintenance.admin_ops_api._runtime_phase2_item", side_effect=phase2):
        response = ops.ops_runtime_overview(_request())

    unsupported_sources = {item["source"] for item in response["unsupported"]}
    assert unsupported_sources == {"ws_gateway", "centrifugo", "collab_live"}
    assert response["core_status"] == "healthy"


def test_runtime_overview_bubbles_outbox_adapter_errors():
    with patch("apps.maintenance.admin_ops_api._runtime_queue_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_worker_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_beat_items", return_value=([], [])), \
         patch("apps.maintenance.admin_ops_api._runtime_failed_samples", return_value=([], {}, [])), \
         patch("apps.maintenance.admin_ops_api._runtime_outbox_items", return_value=[{
             "source": "rag_embedding_task",
             "status": "partial",
             "errors": ["rag_embedding_task unavailable: FieldError"],
         }]):
        response = ops.ops_runtime_overview(_request())

    assert response["status"] == "partial"
    assert response["errors"] == ["rag_embedding_task unavailable: FieldError"]


def test_runtime_action_requires_ticket_and_writes_audit():
    response = ops.ops_runtime_action_retry(_action_request(), _payload(ticket_id=""))
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 400
    assert body["error"] == "ticket_id_required"
    log = OpsRuntimeActionLog.objects.get()
    assert log.action_type == "retry"
    assert log.result == "rejected"
    assert log.error_message == "ticket_id_required"


def test_runtime_action_requires_permission_and_writes_audit():
    response = ops.ops_runtime_action_resolve(
        _action_request(superuser=False, has_permission=False),
        _payload(ticket_id="OPS-RUNTIME-2"),
    )
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 403
    assert body["error"] == "permission_denied"
    log = OpsRuntimeActionLog.objects.get()
    assert log.action_type == "resolve"
    assert log.ticket_id == "OPS-RUNTIME-2"
    assert log.result == "rejected"
    assert "runtime_action:resolve" in log.error_message


def test_runtime_action_rejects_when_flag_disabled(settings):
    settings.OPS_RUNTIME_ACTIONS_ENABLED = False

    response = ops.ops_runtime_action_retry(
        _action_request(),
        _payload(ticket_id="OPS-RUNTIME-FLAG"),
    )
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 403
    assert body["error"] == "ops_runtime_actions_disabled"
    log = OpsRuntimeActionLog.objects.get()
    assert log.result == "rejected"
    assert log.error_message == "ops_runtime_actions_disabled"


def test_runtime_action_permission_exception_fails_closed():
    request = _action_request(superuser=False)
    request.auth.has_perm = Mock(side_effect=RuntimeError("permission backend down"))

    response = ops.ops_runtime_action_retry(
        request,
        _payload(ticket_id="OPS-RUNTIME-PERM-ERR"),
    )
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 403
    assert body["error"] == "permission_denied"
    log = OpsRuntimeActionLog.objects.get()
    assert log.result == "rejected"
    assert "runtime_action:retry" in log.error_message


def test_runtime_action_guard_rejects_unknown_action_and_writes_audit():
    response = ops._runtime_action_guard(
        _action_request(),
        "purge",
        _payload(ticket_id="OPS-RUNTIME-PURGE"),
    )
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 400
    assert body["error"] == "unsupported_runtime_action"
    log = OpsRuntimeActionLog.objects.get()
    assert log.action_type == "purge"
    assert log.result == "rejected"
    assert log.error_message == "unsupported_runtime_action"


def test_runtime_retry_rejects_unmapped_failed_task_and_logs_safely():
    response = ops.ops_runtime_action_retry(
        _action_request(),
        _payload(ticket_id="OPS-RUNTIME-3"),
    )
    body = json.loads(response.content.decode("utf-8"))

    assert response.status_code == 409
    assert body["ok"] is False
    assert body["error"] == "retry_not_allowed"
    log = OpsRuntimeActionLog.objects.get()
    assert log.result == "rejected"
    assert log.operator_name == "runtime-admin"
    assert log.request_payload_sanitized["payload"]["api_key"] == "[masked]"
    assert log.request_payload_sanitized["payload"]["note"] == "safe"


def test_runtime_resolve_records_overlay_and_updates_failed_task():
    FailedTaskRecord.objects.create(
        task_id="task-1",
        task_name="unknown.task",
        args=[],
        kwargs={},
        exception="boom",
        retries=3,
    )

    response = ops.ops_runtime_action_resolve(
        _action_request(),
        _payload(ticket_id="OPS-RUNTIME-4", reason="confirmed handled"),
    )

    assert response["ok"] is True
    assert response["action_type"] == "resolve"
    assert response["after_status"] == "resolved"
    failed = FailedTaskRecord.objects.get(task_id="task-1")
    assert failed.resolved is True
    resolution = OpsRuntimeResolution.objects.get(source="FailedTaskRecord", target_id="task-1")
    assert resolution.reason == "confirmed handled"
    assert resolution.ticket_id == "OPS-RUNTIME-4"
    log = OpsRuntimeActionLog.objects.get(action_type="resolve")
    assert log.result == "ok"


def test_runtime_fts_retry_requires_engine_enabled_and_explicit_db(settings):
    payload = _payload(
        target_type="outbox",
        target_id="42",
        source="fts_outbox",
        ticket_id="OPS-RUNTIME-5",
        payload={},
    )

    settings.SEARCH_ENGINE_ENABLED = False
    disabled = ops.ops_runtime_action_retry(_action_request(), payload)
    assert disabled.status_code == 409
    assert json.loads(disabled.content)["message"] == "搜索索引未启用，禁止 retry"

    settings.SEARCH_ENGINE_ENABLED = True
    missing_db = ops.ops_runtime_action_retry(_action_request(), payload)
    assert missing_db.status_code == 409
    assert "必须提供明确 db" in json.loads(missing_db.content)["message"]


def test_runtime_api_rejects_rag_resolve_cleanup_bypass():
    response = ops.ops_runtime_action_resolve(
        _action_request(),
        _payload(
            target_type="rag_embedding_task",
            target_id=str(uuid.uuid4()),
            source="rag_embedding_task",
            ticket_id="OPS-RAG-BYPASS",
            reason="try bypass command",
        ),
    )

    assert response.status_code == 409
    body = json.loads(response.content)
    assert body["error"] == "resolve_not_allowed"
    assert "ops_rag_terminal_failed_resolve" in body["message"]


class _FakeRedisPipeline:
    def __init__(self, redis):
        self.redis = redis
        self.calls = []

    def set(self, *args, **kwargs):
        self.calls.append(("set", args, kwargs))
        return self

    def zadd(self, *args, **kwargs):
        self.calls.append(("zadd", args, kwargs))
        return self

    def zremrangebyscore(self, *args, **kwargs):
        self.calls.append(("zremrangebyscore", args, kwargs))
        return self

    def expire(self, *args, **kwargs):
        self.calls.append(("expire", args, kwargs))
        return self

    def sadd(self, *args, **kwargs):
        self.calls.append(("sadd", args, kwargs))
        return self

    def execute(self):
        for name, args, kwargs in self.calls:
            getattr(self.redis, name)(*args, **kwargs)
        return []


class _FakeRedis:
    def __init__(self):
        self.values = {}
        self.sets = {}
        self.zsets = {}
        self.streams = {}

    def pipeline(self):
        return _FakeRedisPipeline(self)

    def set(self, key, value, ex=None):
        self.values[key] = value
        return True

    def get(self, key):
        return self.values.get(key)

    def zadd(self, key, mapping):
        self.zsets.setdefault(key, {}).update(mapping)
        return len(mapping)

    def zremrangebyscore(self, key, min_score, max_score):
        zset = self.zsets.setdefault(key, {})
        max_value = float(max_score)
        for member, score in list(zset.items()):
            if float(score) <= max_value:
                zset.pop(member, None)
        return 0

    def zrevrange(self, key, start, end):
        rows = sorted(self.zsets.get(key, {}).items(), key=lambda item: item[1], reverse=True)
        return [member for member, _score in rows[start:end + 1]]

    def expire(self, key, ttl):
        return True

    def sadd(self, key, member):
        self.sets.setdefault(key, set()).add(member)
        return 1

    def smembers(self, key):
        return set(self.sets.get(key, set()))

    def xadd(self, key, fields, maxlen=None, approximate=True):
        stream_id = f"{len(self.streams.setdefault(key, [])) + 1}-0"
        self.streams[key].append((stream_id, fields))
        return stream_id

    def xrevrange(self, key, count=100):
        return list(reversed(self.streams.get(key, [])))[:count]


def test_ws_runtime_snapshot_flag_false_skips_redis(settings):
    settings.WS_RUNTIME_SNAPSHOT_ENABLED = False
    with patch("apps.services.common.ws.runtime_snapshot._redis") as redis_mock:
        runtime_snapshot.upsert_connection_snapshot(connection_id="conn-1", user_id="user-1")
    redis_mock.assert_not_called()


def test_ws_runtime_snapshot_records_and_reads_without_keys_scan(settings):
    settings.WS_RUNTIME_SNAPSHOT_ENABLED = True
    settings.WS_EVENT_SAMPLE_ENABLED = True
    fake = _FakeRedis()
    with patch("apps.services.common.ws.runtime_snapshot._redis", return_value=fake):
        runtime_snapshot.upsert_connection_snapshot(
            connection_id="conn-1",
            user_id="user-1",
            device_id="device-1",
            client_type="electron",
            client_version="1.2.3",
            subscriptions_count=2,
        )
        runtime_snapshot.record_event(
            "auth_failed",
            connection_id="conn-1",
            user_id="user-1",
            ip="192.168.1.9",
            token="secret",
            access_token="secret",
            raw_auth_header="Bearer secret",
            payload={"raw": "forbidden"},
        )
        rows = runtime_snapshot.read_connection_snapshots(limit=10)
        user_rows = runtime_snapshot.read_connection_snapshots(user_id="user-1", limit=10)
        device_rows = runtime_snapshot.read_connection_snapshots(device_id="device-1", limit=10)
        events = runtime_snapshot.read_event_samples(limit=10)

    assert rows[0]["connection_id"] == "conn-1"
    assert rows[0]["subscriptions_count"] == 2
    assert user_rows[0]["connection_id"] == "conn-1"
    assert device_rows[0]["connection_id"] == "conn-1"
    assert events[0]["event_type"] == "auth_failed"
    assert events[0]["ip_masked"] == "192.168.*.*"
    assert "token" not in events[0]
    assert "access_token" not in events[0]
    assert "raw_auth_header" not in events[0]
    assert "payload" not in events[0]
    source = inspect.getsource(runtime_snapshot)
    assert ".keys(" not in source
    assert ".scan(" not in source


def test_ws_runtime_api_returns_unsupported_when_flag_disabled(settings):
    settings.WS_RUNTIME_SNAPSHOT_ENABLED = False

    response = ops.ops_runtime_websocket_summary(_request())

    assert response["status"] == "unsupported"
    assert response["items"] == []


def test_centrifugo_publish_sample_flag_false_skips_redis(settings):
    settings.CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED = False
    with patch("apps.tabchat.services.centrifugo_runtime_sample._redis") as redis_mock:
        centrifugo_runtime_sample.record_publish_event(
            centrifugo_runtime_sample.build_publish_context("chat:room-1", {"data": {"user_id": "u1"}}),
            publish_attempted=True,
        )
    redis_mock.assert_not_called()


def test_centrifugo_publish_sync_records_safe_samples(settings):
    settings.CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED = True
    fake = _FakeRedis()

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"result": {}}

    service = CentrifugoService()
    service.api_key = "secret-api-key"
    with patch("apps.tabchat.services.centrifugo_runtime_sample._redis", return_value=fake), \
         patch.object(service, "_get_session") as get_session:
        get_session.return_value.post.return_value = _Response()
        service.publish_sync(
            "chat:room-1",
            {
                "type": "im.message",
                "data": {
                    "conversation_id": "room-1",
                    "user_id": "user-1",
                    "workteam_id": "wt-1",
                    "content": "must not be recorded",
                    "token": "must-not-leak",
                },
            },
        )

        events = centrifugo_runtime_sample.read_publish_events(limit=10)

    assert len(events) == 2
    attempted = next(row for row in events if row["publish_attempted"] == "true")
    accepted = next(row for row in events if row["publish_accepted"] == "true")
    assert attempted["channel"] == "chat:room-1"
    assert attempted["channel_type"] == "chat"
    assert attempted["user_id"] == "user-1"
    assert attempted["room_id"] == "room-1"
    assert accepted["latency_ms"] != ""
    serialized = json.dumps(events, ensure_ascii=False)
    assert "must not be recorded" not in serialized
    assert "must-not-leak" not in serialized
    assert "secret-api-key" not in serialized
    source = inspect.getsource(centrifugo_runtime_sample)
    assert ".keys(" not in source
    assert ".scan(" not in source


def test_im_runtime_api_returns_unsupported_when_flag_disabled(settings):
    settings.CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED = False

    response = ops.ops_runtime_im_summary(_request())

    assert response["status"] == "unsupported"
    assert response["items"] == []


def test_collab_runtime_api_flag_false_returns_unsupported(settings):
    settings.COLLAB_RUNTIME_SNAPSHOT_ENABLED = False

    response = ops.ops_runtime_collab_summary(_request())

    assert response["status"] == "unsupported"
    assert response["items"] == []


def test_collab_runtime_api_reads_room_snapshot_without_keys_scan(settings):
    settings.COLLAB_RUNTIME_SNAPSHOT_ENABLED = True
    settings.COLLAB_EVENT_SAMPLE_ENABLED = True
    fake = _FakeRedis()
    room = {
        "room_key": "docs:doc-1",
        "resource_type": "docs",
        "resource_id": "doc-1",
        "active_connections": 1,
        "active_users": 1,
        "instance_id": "collab-live-test",
        "last_store_at": timezone.now().isoformat(),
        "store_failed_count": 0,
        "store_slow_count": 1,
        "redis_pubsub_status": "unknown",
        "status": "warning",
    }
    conn = {
        "connection_id": "conn-1",
        "user_id": "user-1",
        "resource_type": "docs",
        "resource_id": "doc-1",
        "room_key": "docs:doc-1",
        "instance_id": "collab-live-test",
        "client_type": "user",
        "connected_at": timezone.now().isoformat(),
        "last_seen_at": timezone.now().isoformat(),
        "status": "connected",
    }
    fake.set("ops:collab:room:docs:doc-1", json.dumps(room))
    fake.set("ops:collab:conn:conn-1", json.dumps(conn))
    now_score = timezone.now().timestamp()
    fake.zadd("ops:collab:index:rooms", {"docs:doc-1": now_score})
    fake.zadd("ops:collab:index:connections", {"conn-1": now_score})
    fake.xadd("ops:collab:events", {
        "event_type": "store_slow",
        "room_key": "docs:doc-1",
        "resource_type": "docs",
        "resource_id": "doc-1",
        "created_at": timezone.now().isoformat(),
    })

    with patch("apps.maintenance.admin_ops_api._collab_redis", return_value=fake):
        summary = ops.ops_runtime_collab_summary(_request())
        rooms = ops.ops_runtime_collab_rooms(_request())
        connections = ops.ops_runtime_collab_connections(_request())
        events = ops.ops_runtime_collab_events(_request())

    assert summary["items"][0]["current_rooms"] == 1
    assert summary["items"][0]["current_connections"] == 1
    assert summary["items"][0]["store_slow"] == 1
    assert rooms["items"][0]["room_key"] == "docs:doc-1"
    assert connections["items"][0]["connection_id"] == "conn-1"
    assert events["items"][0]["event_type"] == "store_slow"
    source = inspect.getsource(ops)
    assert "redis.keys(" not in source
    assert "redis.scan(" not in source


def _make_rag_failed_task(error_message="missing user_id / system organization context"):
    task = EmbeddingTask.objects.create(
        task_type="table",
        target_id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
        status="failed",
        retry_count=3,
        error_message=error_message,
    )
    EmbeddingTask.objects.filter(id=task.id).update(created_at=timezone.now() - timedelta(days=30))
    task.refresh_from_db()
    return task


def test_rag_terminal_failed_report_outputs_impact_counts():
    task = _make_rag_failed_task()
    out = StringIO()

    call_command(
        "ops_rag_terminal_failed_report",
        error_signature="user_id",
        created_before=(timezone.now() + timedelta(days=1)).isoformat(),
        limit=10,
        stdout=out,
    )

    data = json.loads(out.getvalue())
    assert data["total_count"] == 1
    assert data["by_task_name"]["rag.index_table_task"] == 1
    assert data["by_scene_key"]["rag_index_table"] == 1
    assert data["by_status"]["failed"] == 1
    assert str(task.id) in data["sample_ids"]


def test_rag_terminal_failed_resolve_defaults_to_dry_run_and_does_not_delete():
    task = _make_rag_failed_task()
    out = StringIO()

    call_command(
        "ops_rag_terminal_failed_resolve",
        error_signature="user_id",
        created_before=(timezone.now() + timedelta(days=1)).isoformat(),
        ticket_id="OPS-RAG-1",
        reason="历史 user_id 为空噪音",
        limit=10,
        stdout=out,
    )

    data = json.loads(out.getvalue())
    assert data["dry_run"] is True
    assert data["matched_count"] == 1
    assert data["resolved_count"] == 0
    assert EmbeddingTask.objects.filter(id=task.id).exists()
    assert not OpsRuntimeResolution.objects.filter(source="rag_embedding_task", target_id=str(task.id)).exists()


def test_rag_terminal_failed_resolve_requires_ticket_and_reason():
    _make_rag_failed_task()
    with pytest.raises(CommandError, match="ticket_id_required"):
        call_command(
            "ops_rag_terminal_failed_resolve",
            error_signature="user_id",
            created_before=(timezone.now() + timedelta(days=1)).isoformat(),
            reason="历史噪音",
        )
    with pytest.raises(CommandError, match="reason_required"):
        call_command(
            "ops_rag_terminal_failed_resolve",
            error_signature="user_id",
            created_before=(timezone.now() + timedelta(days=1)).isoformat(),
            ticket_id="OPS-RAG-2",
        )


def test_rag_terminal_failed_resolve_archives_overlay_and_audit_log_without_delete():
    task = _make_rag_failed_task()
    out = StringIO()

    call_command(
        "ops_rag_terminal_failed_resolve",
        error_signature="user_id",
        created_before=(timezone.now() + timedelta(days=1)).isoformat(),
        ticket_id="OPS-RAG-3",
        reason="历史 user_id 为空噪音",
        dry_run="false",
        limit=10,
        stdout=out,
    )

    data = json.loads(out.getvalue())
    assert data["dry_run"] is False
    assert data["resolved_count"] == 1
    assert EmbeddingTask.objects.filter(id=task.id, status="failed").exists()
    resolution = OpsRuntimeResolution.objects.get(source="rag_embedding_task", target_id=str(task.id))
    assert resolution.status == "archived"
    assert resolution.ticket_id == "OPS-RAG-3"
    log = OpsRuntimeActionLog.objects.get(source="rag_embedding_task", target_id=str(task.id))
    assert log.action_type == "cleanup"
    assert log.result == "ok"

    item = ops.RagEmbeddingTaskAdapter().item()
    assert item["terminal_failed_count"] == 0
    assert item["failed_count"] == 0
