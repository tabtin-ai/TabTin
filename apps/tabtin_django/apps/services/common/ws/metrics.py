"""
Prometheus metrics for WebSocket Gateway.

Usage:
  from apps.services.common.ws.metrics import ws_metrics

Expose via a dedicated endpoint in urls.py:
  from apps.services.common.ws.metrics import metrics_view
  path('metrics/', metrics_view)

Security:
  Access is restricted by IP whitelist (localhost + private ranges)
  and an optional METRICS_TOKEN setting for Bearer auth.

Multi-process 部署（R5-21 修复）：
  生产 gunicorn 多 worker 时，env 注入 `PROMETHEUS_MULTIPROC_DIR`，
  本模块的 `metrics_view` 会自动用 `MultiProcessCollector` 聚合各 worker
  的指标，避免单 worker REGISTRY 数据失真。所有 Gauge 必须显式声明
  `multiprocess_mode`（livesum/max/min/sum）—— ws_connections_total /
  ws_subscription_count 已补齐；fts/metrics.py 也已合规。
"""

import ipaddress
import logging
import os

from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST
from django.conf import settings
from django.http import HttpResponse

_logger = logging.getLogger(__name__)

# G-073: configurable whitelist via settings.METRICS_ALLOWED_NETWORKS.
# Defaults to localhost + RFC1918 private ranges. Override in settings to restrict further.
_DEFAULT_NETWORKS = [
    '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
]


def _build_allowed_networks():
    raw = getattr(settings, 'METRICS_ALLOWED_NETWORKS', None) or _DEFAULT_NETWORKS
    nets = []
    for n in raw:
        try:
            nets.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            _logger.warning("[Metrics] invalid network in METRICS_ALLOWED_NETWORKS: %s", n)
    return nets


_ALLOWED_NETWORKS = _build_allowed_networks()


# ---- WebSocket connection metrics ----
# R5-21 修复：multi-process 模式下 Gauge 必须声明 multiprocess_mode；
# 否则 prometheus_client 在 multiprocess 启用时直接 ValueError。
# 'livesum' 语义：所有活着 worker 的本地值相加（活跃连接数语义贴合）。
ws_connections_total = Gauge(
    'tabtin_ws_connections_total',
    'Current number of active WebSocket connections',
    ['scope'],  # user / session / device
    multiprocess_mode='livesum',
)

ws_connections_opened = Counter(
    'tabtin_ws_connections_opened_total',
    'Total WebSocket connections opened',
    ['role'],  # electron / mobile / daemon / admin / channel
)

ws_connections_closed = Counter(
    'tabtin_ws_connections_closed_total',
    'Total WebSocket connections closed',
    ['role', 'code'],
)

ws_auth_failures = Counter(
    'tabtin_ws_auth_failures_total',
    'Total WebSocket authentication failures',
    ['reason'],  # invalid_token / timeout / permission_denied / connection_limit
)

# ---- Message metrics ----
ws_messages_received = Counter(
    'tabtin_ws_messages_received_total',
    'Total WebSocket messages received',
    ['type'],
)

ws_messages_sent = Counter(
    'tabtin_ws_messages_sent_total',
    'Total WebSocket messages sent to clients',
    ['type'],
)

# ---- Subscription metrics ----
ws_subscription_count = Gauge(
    'tabtin_ws_subscription_count',
    'Current number of active topic subscriptions across all connections',
    ['topic_prefix'],  # e.g. agent.stream / table.open / channel.inbound
    multiprocess_mode='livesum',
)

# ---- Device heartbeat metrics ----
device_heartbeats = Counter(
    'tabtin_device_heartbeats_total',
    'Total device heartbeat requests',
    ['result'],  # ok / debounced / not_found / error
)

action_dispatch_latency = Histogram(
    'tabtin_action_dispatch_latency_seconds',
    'Action dispatch latency (publish to result)',
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0],
)


# L_OBS_1: 断路器开启时 _group_send_with_retry 直接 return（不抛），上层
# publish_ws_event / publish_to_user 的 try/except 拦不到，会误调
# record_message_sent 报送成功并 return True。这条 counter 让"跳过"行为
# 可观测：监控 dashboard 上 sent_total 与 skipped_total 比例陡增 = 实时
# 分发链路异常（断路器持续开），即使没有 ERROR 日志也能告警。
ws_publish_skipped_breaker_open = Counter(
    'tabtin_ws_publish_skipped_breaker_open_total',
    'group_send skipped because channel-layer circuit breaker is OPEN',
    ['type'],
)

relay_batches_received_total = Counter(
    'relay_batches_received_total',
    'Total relay_events batches received',
    ['protocol_version'],
)

relay_events_received_total = Counter(
    'relay_events_received_total',
    'Total relay_events sub-events received',
    ['protocol_version'],
)

relay_batch_event_count = Histogram(
    'relay_batch_event_count',
    'Number of sub-events in a relay_events batch',
    buckets=[1, 5, 10, 15, 25, 50, 100, 200, 500],
)

relay_batch_payload_bytes = Histogram(
    'relay_batch_payload_bytes',
    'Serialized payload size in bytes for relay_events batches',
    buckets=[512, 1024, 4096, 16_384, 65_536, 131_072, 262_144, 524_288, 1_000_000],
)

relay_network_delay_ms = Histogram(
    'relay_network_delay_ms',
    'Milliseconds from client-created timestamp to server receive time for relay_events',
    buckets=[10, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000],
)

relay_server_queue_wait_ms = Histogram(
    'relay_server_queue_wait_ms',
    'Milliseconds between relay_events receive time and handler processing start',
    buckets=[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 120_000],
)

relay_processing_duration_ms = Histogram(
    'relay_processing_duration_ms',
    'Milliseconds spent processing a relay_events batch before ACK or NAK',
    buckets=[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 120_000],
)

relay_sync_failed_total = Counter(
    'relay_sync_failed_total',
    'Total relay_events batches whose critical sync write failed',
    ['reason'],
)

relay_events_skipped_total = Counter(
    'relay_events_skipped_total',
    'Total relay_events sub-events skipped by reason',
    ['reason'],
)

relay_nak_total = Counter(
    'relay_nak_total',
    'Total relay_events NAK responses by reason',
    ['reason'],
)

relay_ws_timestamp_rejected_total = Counter(
    'relay_ws_timestamp_rejected_total',
    'Total WebSocket envelopes rejected for relay timestamp drift',
    ['protocol_version'],
)

_RELAY_REASON_PREFIXES = (
    'db_write_error',
    'persist_message_write_error',
    'state_snapshot_write_error',
    'revert_finalize_failed',
    'sync_write_exception',
    'unknown',
)


def normalize_relay_metric_reason(reason: str | None) -> str:
    """Map dynamic relay errors to low-cardinality metric label values."""
    if not reason:
        return 'unknown'
    reason_text = str(reason)
    for prefix in _RELAY_REASON_PREFIXES:
        if reason_text == prefix or reason_text.startswith(f'{prefix} ') or reason_text.startswith(f'{prefix}:'):
            return prefix
    return 'other'


def record_message_sent(msg_type: str) -> None:
    """Increment ws_messages_sent counter after successful downstream publish."""
    ws_messages_sent.labels(type=msg_type).inc()


def record_publish_skipped_breaker_open(msg_type: str) -> None:
    """L_OBS_1: 断路器开启时跳过 group_send 的可观测计数。"""
    ws_publish_skipped_breaker_open.labels(type=msg_type).inc()


def record_message_received(msg_type: str) -> None:
    """Increment ws_messages_received counter on upstream message receipt.

    Gateway.receive() should call this after successful envelope parsing.
    """
    ws_messages_received.labels(type=msg_type).inc()


def record_relay_batch_received(
    *,
    protocol_version: str,
    event_count: int,
    payload_bytes: int,
    network_delay_ms: int | None,
) -> None:
    relay_batches_received_total.labels(protocol_version=protocol_version).inc()
    relay_events_received_total.labels(protocol_version=protocol_version).inc(max(event_count, 0))
    relay_batch_event_count.observe(max(event_count, 0))
    relay_batch_payload_bytes.observe(max(payload_bytes, 0))
    if network_delay_ms is not None:
        relay_network_delay_ms.observe(max(network_delay_ms, 0))


def record_relay_batch_processed(
    *,
    server_queue_wait_ms: int,
    processing_duration_ms: int,
    sync_ok: bool,
    sync_error_code: str | None,
    skipped_reasons: dict[str, int],
    nak_code: str | None,
) -> None:
    relay_server_queue_wait_ms.observe(max(server_queue_wait_ms, 0))
    relay_processing_duration_ms.observe(max(processing_duration_ms, 0))
    if not sync_ok:
        relay_sync_failed_total.labels(reason=normalize_relay_metric_reason(sync_error_code)).inc()
    for reason, count in skipped_reasons.items():
        if count > 0:
            relay_events_skipped_total.labels(reason=reason).inc(count)
    if nak_code:
        relay_nak_total.labels(reason=normalize_relay_metric_reason(nak_code)).inc()


def record_relay_ws_timestamp_rejected(protocol_version: str) -> None:
    relay_ws_timestamp_rejected_total.labels(protocol_version=protocol_version).inc()


def _is_allowed_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
        return any(ip in net for net in _ALLOWED_NETWORKS)
    except ValueError:
        return False


def _collect_metrics_payload() -> bytes:
    """Multi-process 时聚合所有 worker；单进程时走默认 REGISTRY。

    R5-21 修复：env `PROMETHEUS_MULTIPROC_DIR` 注入 → MultiProcessCollector
    把各 worker 写到该目录的 db file 聚合，给出全集群正确数据。

    单进程（开发 / Celery / 测试）→ 走默认 REGISTRY，行为与之前一致。
    """
    if os.environ.get('PROMETHEUS_MULTIPROC_DIR'):
        try:
            from prometheus_client import CollectorRegistry
            from prometheus_client.multiprocess import MultiProcessCollector
            registry = CollectorRegistry()
            MultiProcessCollector(registry)
            return generate_latest(registry)
        except Exception:  # pragma: no cover - 严重异常也别崩 endpoint
            _logger.exception(
                "[Metrics] MultiProcessCollector failed; "
                "falling back to single-process REGISTRY (注意：数据可能失真)",
            )
    return generate_latest()


def metrics_view(request):
    """Django view that exposes Prometheus metrics.

    Access control: localhost/private IPs always allowed; others need
    a valid Bearer token matching settings.METRICS_TOKEN.

    Multi-process 部署：
        env 注入 `PROMETHEUS_MULTIPROC_DIR` 时自动用 MultiProcessCollector
        聚合各 gunicorn worker 的指标。开发 / 测试默认行为不变。
    """
    remote_addr = request.META.get('REMOTE_ADDR', '')
    token = getattr(settings, 'METRICS_TOKEN', None)

    if not _is_allowed_ip(remote_addr):
        if not token:
            return HttpResponse('Forbidden', status=403)
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        if auth_header != f'Bearer {token}':
            return HttpResponse('Forbidden', status=403)

    return HttpResponse(
        _collect_metrics_payload(),
        content_type=CONTENT_TYPE_LATEST,
    )
