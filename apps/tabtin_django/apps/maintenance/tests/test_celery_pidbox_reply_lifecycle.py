"""Real Redis coverage for Celery pidbox reply queue lifetimes."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from io import StringIO
from pathlib import Path
from uuid import uuid4

import pytest
import redis
from django.core.management import call_command
from django.test import override_settings
from kombu import Connection, Producer
from kombu.pidbox import Mailbox
from tabtin.celery_redis_transport import PIDBOX_REPLY_SUFFIX


_DJANGO_ROOT = Path(__file__).resolve().parents[3]


def _redis_server_binary() -> str:
    configured = os.getenv("TABTIN_TEST_REDIS_SERVER_BIN", "").strip()
    binary = configured or shutil.which("redis-server")
    if not binary:
        pytest.skip("set TABTIN_TEST_REDIS_SERVER_BIN to run real Redis tests")
    return binary


def _unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def disposable_redis_url() -> Iterator[str]:
    port = _unused_port()
    with tempfile.TemporaryDirectory(prefix="tabtin-pidbox-redis-") as data_dir:
        process = subprocess.Popen(
            [
                _redis_server_binary(),
                "--port",
                str(port),
                "--bind",
                "127.0.0.1",
                "--protected-mode",
                "yes",
                "--save",
                "",
                "--appendonly",
                "no",
                "--dir",
                data_dir,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        url = f"redis://127.0.0.1:{port}/0"
        client = redis.Redis.from_url(url)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if client.ping():
                    break
            except redis.ConnectionError:
                time.sleep(0.02)
        else:
            process.terminate()
            raise RuntimeError("disposable Redis did not become ready")

        try:
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


def _connection(url: str, *, prefix: str, ttl: int) -> Connection:
    return Connection(
        url,
        transport="tabtin.celery_redis_transport:Transport",
        transport_options={
            "global_keyprefix": prefix,
            "pidbox_reply_ttl": ttl,
        },
    )


def _publish_reply(connection: Connection, payload: object) -> tuple[str, object]:
    channel = connection.channel()
    mailbox = Mailbox(
        "celery",
        connection=connection,
        reply_queue_ttl=300.0,
        reply_queue_expires=10.0,
    )
    queue = mailbox.reply_queue(channel)
    queue.declare()
    Producer(channel).publish(
        payload,
        exchange=mailbox.reply_exchange,
        routing_key=mailbox.oid,
        declare=[mailbox.reply_exchange],
        headers={"ticket": "probe", "clock": 1},
        serializer="json",
    )
    return queue.name, channel


def _wait_until_missing(client: redis.Redis, key: str, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not client.exists(key):
            return
        time.sleep(0.02)
    pytest.fail(f"Redis key did not expire: {key}")


def test_pidbox_reply_gets_real_ttl_and_expires_without_queue_delete(
    disposable_redis_url: str,
) -> None:
    """Removing the transport TTL write must leave this key at TTL=-1."""
    prefix = f"pidbox-{uuid4().hex}:"
    raw_client = redis.Redis.from_url(disposable_redis_url)

    with _connection(disposable_redis_url, prefix=prefix, ttl=1) as connection:
        queue_name, _channel = _publish_reply(connection, {"ok": "pong"})
        key = f"{prefix}{queue_name}"
        assert raw_client.type(key) == b"list"
        assert 0 < raw_client.pttl(key) <= 1_000

    _wait_until_missing(raw_client, key)


def test_normal_reply_cleanup_still_deletes_queue_and_binding(
    disposable_redis_url: str,
) -> None:
    """Breaking Kombu's normal queue_delete path must leave list or binding state."""
    prefix = f"pidbox-{uuid4().hex}:"
    raw_client = redis.Redis.from_url(disposable_redis_url)

    with _connection(disposable_redis_url, prefix=prefix, ttl=30) as connection:
        queue_name, channel = _publish_reply(connection, {"ok": "pong"})
        key = f"{prefix}{queue_name}"
        binding_key = f"{prefix}_kombu.binding.reply.celery.pidbox"
        assert raw_client.exists(key)
        assert raw_client.scard(binding_key) == 1

        channel.after_reply_message_received(queue_name)

        assert not raw_client.exists(key)
        assert raw_client.scard(binding_key) == 0


def test_transport_does_not_add_ttl_to_an_ordinary_task_queue(
    disposable_redis_url: str,
) -> None:
    """Broadening the suffix guard must not expire normal Celery task queues."""
    prefix = f"pidbox-{uuid4().hex}:"
    raw_client = redis.Redis.from_url(disposable_redis_url)

    with _connection(disposable_redis_url, prefix=prefix, ttl=1) as connection:
        channel = connection.channel()
        channel._put(
            "ordinary-task-queue",
            {"body": "payload", "properties": {"priority": 0}},
        )

    key = f"{prefix}ordinary-task-queue"
    assert raw_client.type(key) == b"list"
    assert raw_client.ttl(key) == -1


def test_each_slow_reply_refreshes_the_ttl_window(
    disposable_redis_url: str,
) -> None:
    """Dropping EXPIRE refresh must let a valid slow final reply disappear early."""
    prefix = f"pidbox-{uuid4().hex}:"
    raw_client = redis.Redis.from_url(disposable_redis_url)

    with _connection(disposable_redis_url, prefix=prefix, ttl=3) as connection:
        queue_name, channel = _publish_reply(connection, {"worker": 1})
        key = f"{prefix}{queue_name}"
        first_pttl = raw_client.pttl(key)
        time.sleep(1.1)
        decayed_pttl = raw_client.pttl(key)
        mailbox = Mailbox("celery", connection=connection)
        Producer(channel).publish(
            {"worker": 2},
            exchange=mailbox.reply_exchange,
            routing_key=queue_name.split(".", 1)[0],
            declare=[mailbox.reply_exchange],
            headers={"ticket": "probe", "clock": 2},
            serializer="json",
        )
        refreshed_pttl = raw_client.pttl(key)

    assert 0 < first_pttl <= 3_000
    assert 0 < decayed_pttl < first_pttl
    assert refreshed_pttl > decayed_pttl
    assert refreshed_pttl > 2_500


def test_transport_connection_loss_still_allows_redis_auto_cleanup(
    disposable_redis_url: str,
) -> None:
    """A broken collector connection must not make its reply list permanent."""
    prefix = f"pidbox-{uuid4().hex}:"
    raw_client = redis.Redis.from_url(disposable_redis_url)

    with _connection(disposable_redis_url, prefix=prefix, ttl=2) as connection:
        queue_name, channel = _publish_reply(connection, {"ok": "pong"})
        key = f"{prefix}{queue_name}"
        assert 0 < raw_client.pttl(key) <= 2_000
        channel.client.connection_pool.disconnect()

    assert raw_client.exists(key)
    _wait_until_missing(raw_client, key, timeout=4)


def test_project_celery_connections_use_the_bounded_redis_transport() -> None:
    """Removing the broker transport wiring must expose plain Kombu Redis again."""
    from tabtin.celery import app
    from tabtin.celery_redis_transport import Channel

    connection = app.connection_for_write()

    assert connection.transport.Channel is Channel
    assert connection.transport_options["pidbox_reply_ttl"] == app.conf.control_queue_ttl
    assert app.control.mailbox.reply_queue_ttl == app.conf.control_queue_ttl


def test_invalid_pidbox_reply_ttl_fails_closed(disposable_redis_url: str) -> None:
    """Clamping zero to one second would hide an invalid deployment setting."""
    prefix = f"pidbox-{uuid4().hex}:"
    with _connection(disposable_redis_url, prefix=prefix, ttl=0) as connection:
        channel = connection.channel()
        with pytest.raises(ValueError, match="positive number"):
            channel._put(
                f"{uuid4()}.reply.celery.pidbox",
                {"body": "payload", "properties": {"priority": 0}},
            )


def test_orphan_sweeper_is_bounded_and_preserves_bound_or_expiring_replies(
    disposable_redis_url: str,
) -> None:
    """Weakening any delete guard must remove one of the protected fixtures."""
    from apps.maintenance.celery_pidbox_replies import (
        collect_pidbox_reply_metrics,
        sweep_orphan_pidbox_replies,
    )

    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    binding_key = f"{prefix}_kombu.binding.reply.celery.pidbox"
    orphan_queue = f"{uuid4()}.reply.celery.pidbox"
    bound_queue = f"{uuid4()}.reply.celery.pidbox"
    expiring_queue = f"{uuid4()}.reply.celery.pidbox"
    orphan_key = f"{prefix}{orphan_queue}"
    bound_key = f"{prefix}{bound_queue}"
    expiring_key = f"{prefix}{expiring_queue}"
    ordinary_key = f"{prefix}ordinary-task-queue"

    client.lpush(orphan_key, b"orphan")
    client.lpush(bound_key, b"bound")
    client.lpush(expiring_key, b"expiring")
    client.expire(expiring_key, 30)
    client.lpush(ordinary_key, b"ordinary")
    separator = "\x06\x16"
    client.sadd(binding_key, separator.join(["route", "", bound_queue]))
    time.sleep(1.1)

    metrics = collect_pidbox_reply_metrics(
        client,
        global_keyprefix=prefix,
        safe_idle_seconds=1,
        scan_count=2,
        max_scanned_keys=20,
        time_budget_seconds=2,
    )
    result = sweep_orphan_pidbox_replies(
        client,
        global_keyprefix=prefix,
        safe_idle_seconds=1,
        scan_count=2,
        max_scanned_keys=20,
        max_deleted=5,
        time_budget_seconds=2,
    )

    assert metrics.reply_key_count == 3
    assert metrics.total_bytes > 0
    assert metrics.without_ttl_count == 2
    assert metrics.orphan_candidate_count == 1
    assert metrics.oldest_idle_seconds >= 1
    assert metrics.scan_complete is True
    assert result.deleted_count == 1
    assert not client.exists(orphan_key)
    assert client.exists(bound_key)
    assert client.exists(expiring_key)
    assert client.exists(ordinary_key)
    assert client.scard(binding_key) == 1


def test_metrics_mark_scan_incomplete_when_key_limit_stops_a_batch(
    disposable_redis_url: str,
) -> None:
    """Reporting a partial bounded scan as complete would make metrics misleading."""
    from apps.maintenance.celery_pidbox_replies import collect_pidbox_reply_metrics

    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    for _ in range(3):
        client.lpush(f"{prefix}{uuid4()}.reply.celery.pidbox", b"payload")

    metrics = collect_pidbox_reply_metrics(
        client,
        global_keyprefix=prefix,
        safe_idle_seconds=1,
        scan_count=100,
        max_scanned_keys=2,
        time_budget_seconds=2,
    )

    assert metrics.scanned_key_count == 2
    assert metrics.scan_complete is False


def test_management_command_exposes_lifecycle_metrics_without_sweeping(
    disposable_redis_url: str,
) -> None:
    """Removing an output field must hide a required low-cost signal."""
    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    queue = f"{uuid4()}.reply.celery.pidbox"
    client.lpush(f"{prefix}{queue}", b"orphan")
    output = StringIO()

    with override_settings(
        CELERY_BROKER_URL=disposable_redis_url,
        CELERY_BROKER_TRANSPORT_OPTIONS={"global_keyprefix": prefix},
    ):
        call_command(
            "celery_pidbox_replies",
            safe_idle_seconds=1,
            scan_count=10,
            max_scanned_keys=20,
            time_budget_seconds=1.0,
            stdout=output,
        )

    payload = json.loads(output.getvalue())
    assert payload["celery_pidbox_reply_key_count"] == 1
    assert payload["celery_pidbox_reply_total_bytes"] > 0
    assert payload["celery_pidbox_reply_without_ttl"] == 1
    assert payload["celery_pidbox_reply_orphan_candidate"] == 0
    assert payload["celery_pidbox_reply_oldest_idle_seconds"] >= 0
    assert payload["sweep_applied"] is False
    assert client.exists(f"{prefix}{queue}")


def test_sigkill_before_collector_finally_still_allows_redis_auto_cleanup(
    disposable_redis_url: str,
) -> None:
    """Removing EXPIRE must make the SIGKILL-created key survive indefinitely."""
    prefix = f"pidbox-{uuid4().hex}:"
    script = r"""
import os
import time
from kombu import Connection, Producer
from kombu.pidbox import Mailbox

url = os.environ["PIDBOX_REDIS_URL"]
prefix = os.environ["PIDBOX_KEY_PREFIX"]
with Connection(
    url,
    transport="tabtin.celery_redis_transport:Transport",
    transport_options={"global_keyprefix": prefix, "pidbox_reply_ttl": 2},
) as connection:
    channel = connection.channel()
    mailbox = Mailbox("celery", connection=connection)
    queue = mailbox.reply_queue(channel)
    queue.declare()
    Producer(channel).publish(
        {"worker@probe": {"ok": "pong"}},
        exchange=mailbox.reply_exchange,
        routing_key=mailbox.oid,
        declare=[mailbox.reply_exchange],
        headers={"ticket": "probe", "clock": 1},
        serializer="json",
    )
    print(queue.name, flush=True)
    time.sleep(60)
"""
    environment = dict(os.environ)
    environment.update(
        PIDBOX_REDIS_URL=disposable_redis_url,
        PIDBOX_KEY_PREFIX=prefix,
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script],
        cwd=_DJANGO_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    queue_name = process.stdout.readline().strip()
    assert queue_name.endswith(".reply.celery.pidbox")
    key = f"{prefix}{queue_name}"
    client = redis.Redis.from_url(disposable_redis_url)
    assert 0 < client.pttl(key) <= 2_000

    process.kill()
    process.wait(timeout=3)

    assert client.exists(key)
    _wait_until_missing(client, key, timeout=4)


def test_mingle_hello_large_reply_payload_is_bounded_by_ttl(
    disposable_redis_url: str,
) -> None:
    """Bypassing the reply suffix path must leave a large hello payload permanent."""
    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    revoked = {str(uuid4()): time.time() for _ in range(5_000)}
    payload = {"worker@probe": {"clock": 42, "revoked": revoked}}

    with _connection(disposable_redis_url, prefix=prefix, ttl=2) as connection:
        queue_name, _channel = _publish_reply(connection, payload)
        key = f"{prefix}{queue_name}"
        assert client.memory_usage(key) > 100_000
        assert 0 < client.pttl(key) <= 2_000

    _wait_until_missing(client, key, timeout=4)


@pytest.mark.parametrize("reply_count", [100, 500, 1_000])
def test_many_abandoned_reply_lists_cannot_accumulate_permanently(
    disposable_redis_url: str,
    reply_count: int,
) -> None:
    """Removing list expiry must leave every abnormal reply key after the wait."""
    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    with _connection(disposable_redis_url, prefix=prefix, ttl=2) as connection:
        channel = connection.channel()
        for index in range(reply_count):
            channel._put(
                f"{index}.{uuid4()}.reply.celery.pidbox",
                {"body": "x" * 1_024, "properties": {"priority": 0}},
            )

    keys = list(client.scan_iter(match=f"{prefix}*{PIDBOX_REPLY_SUFFIX}"))
    initial_bytes = sum(int(client.memory_usage(key) or 0) for key in keys)
    ttl_values = [client.ttl(key) for key in keys]
    assert len(keys) == reply_count
    assert initial_bytes > 0
    assert ttl_values.count(-1) == 0
    remaining = keys
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        remaining = list(client.scan_iter(match=f"{prefix}*{PIDBOX_REPLY_SUFFIX}"))
        if not remaining:
            break
        time.sleep(0.02)
    final_bytes = sum(int(client.memory_usage(key) or 0) for key in remaining)
    print(
        f"PIDBOX_SCALE count={reply_count} initial_keys={len(keys)} "
        f"initial_bytes={initial_bytes} ttl_min={min(ttl_values)} "
        f"ttl_without_expiry={ttl_values.count(-1)} "
        f"final_keys={len(remaining)} final_bytes={final_bytes}",
    )
    assert remaining == []


_WORKER_PROBE_SCRIPT = r"""
import os
import time
from uuid import uuid4

from celery import Celery
from celery.worker import state as worker_state
from kombu.pidbox import Mailbox

url = os.environ["PIDBOX_REDIS_URL"]
prefix = os.environ["PIDBOX_KEY_PREFIX"]
hostname = os.environ["PIDBOX_WORKER_HOSTNAME"]
app = Celery("pidbox_probe", broker=url, backend=url)
app.conf.update(
    broker_transport="tabtin.celery_redis_transport:Transport",
    broker_transport_options={"global_keyprefix": prefix, "pidbox_reply_ttl": 3},
    control_queue_ttl=3.0,
    control_queue_expires=10.0,
    task_default_queue="pidbox-probe",
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    worker_send_task_events=False,
    task_send_sent_event=False,
)

@app.task(name="pidbox_probe.add")
def add(left, right):
    return left + right

if os.environ.get("PIDBOX_LARGE_REVOKED") == "1":
    inserted = time.monotonic()
    worker_state.revoked.update({str(uuid4()): inserted for _ in range(20_000)})

if os.environ.get("PIDBOX_DELAY_COLLECT") == "1":
    original_collect = Mailbox._collect

    def delayed_collect(self, *args, **kwargs):
        time.sleep(5)
        return original_collect(self, *args, **kwargs)

    Mailbox._collect = delayed_collect

app.worker_main([
    "worker",
    "--loglevel=WARNING",
    "--pool=solo",
    "--concurrency=1",
    f"--hostname={hostname}",
    "--queues=pidbox-probe",
    "--without-gossip",
])
"""


def _start_probe_worker(
    url: str,
    prefix: str,
    hostname: str,
    *,
    large_revoked: bool = False,
    delay_collect: bool = False,
) -> subprocess.Popen:
    environment = dict(os.environ)
    environment.update(
        PIDBOX_REDIS_URL=url,
        PIDBOX_KEY_PREFIX=prefix,
        PIDBOX_WORKER_HOSTNAME=hostname,
        PIDBOX_LARGE_REVOKED="1" if large_revoked else "0",
        PIDBOX_DELAY_COLLECT="1" if delay_collect else "0",
    )
    return subprocess.Popen(
        [sys.executable, "-c", _WORKER_PROBE_SCRIPT],
        cwd=_DJANGO_ROOT,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _reply_list_keys(client: redis.Redis, prefix: str) -> list[bytes]:
    return [
        key
        for key in client.scan_iter(match=f"{prefix}*{PIDBOX_REPLY_SUFFIX}")
        if client.type(key) == b"list"
    ]


def test_real_worker_task_beat_inspect_and_mingle_paths(
    disposable_redis_url: str,
) -> None:
    """Bypassing the project transport must strand the killed Mingle reply list."""
    from celery import Celery
    from celery.beat import ScheduleEntry, Scheduler

    prefix = f"pidbox-{uuid4().hex}:"
    client = redis.Redis.from_url(disposable_redis_url)
    app = Celery("pidbox_probe", broker=disposable_redis_url, backend=disposable_redis_url)
    app.conf.update(
        broker_transport="tabtin.celery_redis_transport:Transport",
        broker_transport_options={"global_keyprefix": prefix, "pidbox_reply_ttl": 3},
        control_queue_ttl=3.0,
        control_queue_expires=10.0,
        task_default_queue="pidbox-probe",
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
    )

    @app.task(name="pidbox_probe.add")
    def add(left, right):
        return left + right

    first = _start_probe_worker(
        disposable_redis_url,
        prefix,
        "pidbox-first@localhost",
        large_revoked=True,
    )
    second: subprocess.Popen | None = None
    try:
        deadline = time.monotonic() + 15
        ping_reply = None
        while time.monotonic() < deadline:
            try:
                ping_reply = app.control.inspect(
                    destination=["pidbox-first@localhost"],
                    timeout=0.5,
                ).ping()
            except Exception:
                ping_reply = None
            if ping_reply:
                break
            time.sleep(0.2)
        assert ping_reply == {"pidbox-first@localhost": {"ok": "pong"}}
        assert _reply_list_keys(client, prefix) == []

        task_result = app.send_task(
            "pidbox_probe.add",
            args=(2, 3),
            queue="pidbox-probe",
        )
        assert task_result.get(timeout=10) == 5

        scheduler = Scheduler(app=app, lazy=True)
        entry = ScheduleEntry(
            name="pidbox-probe-beat",
            task="pidbox_probe.add",
            args=(4, 5),
            schedule=60,
            app=app,
        )
        beat_result = scheduler.apply_async(entry)
        assert app.AsyncResult(beat_result.id).get(timeout=10) == 9

        second = _start_probe_worker(
            disposable_redis_url,
            prefix,
            "pidbox-second@localhost",
            delay_collect=True,
        )
        deadline = time.monotonic() + 10
        mingle_keys: list[bytes] = []
        while time.monotonic() < deadline:
            mingle_keys = _reply_list_keys(client, prefix)
            if mingle_keys:
                break
            assert second.poll() is None
            time.sleep(0.005)

        assert len(mingle_keys) == 1
        mingle_key = mingle_keys[0]
        assert client.memory_usage(mingle_key) > 1_000_000
        assert 0 < client.pttl(mingle_key) <= 3_000

        second.kill()
        second.wait(timeout=3)
        assert client.exists(mingle_key)
        _wait_until_missing(client, mingle_key, timeout=5)
    finally:
        if second is not None:
            _stop_process(second)
        _stop_process(first)
