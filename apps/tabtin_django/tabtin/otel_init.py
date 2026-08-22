"""OpenTelemetry SDK 启动初始化（R5-03 修复）。

为什么单独成模块（不放 settings.py）：
    1. settings.py 是 Django 模块加载的"配置语义"层；不该执行 OTel SDK
       注册的"运行时副作用"
    2. wsgi.py / asgi.py / celery.py 三个进程入口都需要 OTel 在业务模块
       import 之前 set_tracer_provider；本模块的 `setup_otel()` 是 idempotent
    3. 测试场景下 setup 不被调用 → 完全不影响测试隔离

启用条件（env）：
    - **OTEL_EXPORTER_OTLP_ENDPOINT=https://...**  ← 必须；不设则本模块 noop
    - OTEL_SERVICE_NAME=tabtin-django               ← 可选；默认 tabtin-django
    - OTEL_EXPORTER_OTLP_HEADERS=Authentication=...  ← 可选；阿里云 ARMS 需要
    - OTEL_RESOURCE_ATTRIBUTES=env=prod,version=...  ← 可选；常用

部署示例（阿里云 ARMS）：
    K8s deployment.spec.template.spec.containers[].env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://tracing-analysis-dc-bj.aliyuncs.com:8090"
        - name: OTEL_EXPORTER_OTLP_HEADERS
          value: "Authentication=<your-token>"
        - name: OTEL_SERVICE_NAME
          value: "tabtin-django-prod"
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: "deployment.environment=production,service.namespace=tabtin"

部署示例（自建 Jaeger）：
    OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger-collector.observability:4317
    OTEL_EXPORTER_OTLP_PROTOCOL=grpc

设计原则：
    - **零侵入**：未设 OTEL_EXPORTER_OTLP_ENDPOINT → setup_otel() 直接 return
      → fts/otel_trace.py / agent_engine/middleware/otel_trace.py 内的
      `_tracer.start_span(...)` 走默认 NoOpTracerProvider，完全不发 span
    - **idempotent**：多次调用 setup_otel() 只 install 一次（用模块级 flag）
    - **失败 swallow**：exporter 配错不应该让进程启动失败；只 log error
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

# 全局 idempotent flag（模块级单例）
_INSTALLED: bool = False


def setup_otel() -> bool:
    """初始化 OTel SDK（idempotent）。

    Returns:
        True  → SDK 真注册了（exporter 已 wire-up）
        False → 跳过（env 未配 / 已注册过 / 异常）
    """
    global _INSTALLED
    if _INSTALLED:
        return True

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        # 开发 / 测试默认路径：不注册 SDK，让所有 start_span() 走 NoOp
        logger.debug(
            "[OTel] OTEL_EXPORTER_OTLP_ENDPOINT 未设置；OTel SDK 不启动 "
            "(span 走 NoOpTracerProvider，零开销零网络)",
        )
        return False

    from tabtin.startup_policy import (
        StartupCapability,
        resolve_endpoint_setting,
        resolve_startup_policy,
    )

    policy = resolve_startup_policy(os.environ)
    if not policy.allows(
        StartupCapability.TELEMETRY,
        explicitly_configured=True,
    ):
        return False
    try:
        resolve_endpoint_setting(
            os.environ,
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            saas_default="",
        )
    except ValueError:
        logger.warning("[OTel] Community company endpoint blocked; telemetry disabled")
        return False

    try:
        from opentelemetry import trace as _otel_trace
        from opentelemetry.sdk.resources import (
            SERVICE_NAME,
            SERVICE_NAMESPACE,
            Resource,
        )
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        logger.error(
            "[OTel] OTEL_EXPORTER_OTLP_ENDPOINT 已设置但 opentelemetry-sdk 未安装；"
            "运行 `pip install opentelemetry-api opentelemetry-sdk "
            "opentelemetry-exporter-otlp-proto-grpc` 后重启",
        )
        return False

    # exporter 选择：默认 grpc（OTLP 标准；阿里云 ARMS / Jaeger / Tempo 都支持）
    # 如果 endpoint 是 http://...:4318/v1/traces，用 http 而不是 grpc
    protocol = os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc").strip().lower()
    try:
        if protocol == "http/protobuf":
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )
        else:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
                OTLPSpanExporter,
            )
    except ImportError:
        logger.error(
            "[OTel] OTLP exporter package 缺失；endpoint=%s protocol=%s",
            endpoint, protocol,
        )
        return False

    # 构造 Resource（service.name / namespace / 自定义 attribute）
    service_name = (
        os.environ.get("OTEL_SERVICE_NAME", "").strip() or "tabtin-django"
    )
    resource_attrs: dict = {
        SERVICE_NAME: service_name,
        SERVICE_NAMESPACE: "tabtin",
    }
    # OTEL_RESOURCE_ATTRIBUTES=key1=v1,key2=v2 也合并进来
    extra_raw = os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").strip()
    if extra_raw:
        for pair in extra_raw.split(","):
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            k, v = k.strip(), v.strip()
            if k:
                resource_attrs[k] = v
    resource = Resource.create(resource_attrs)

    # 装配
    try:
        provider = TracerProvider(resource=resource)
        # OTLP exporter 自动从 OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS
        # 等环境变量读取配置（不需要显式传参）
        exporter = OTLPSpanExporter()
        # BatchSpanProcessor 默认 schedule_delay=5000ms / max_export_batch=512
        # 适合大多数场景；超高吞吐时可用 OTEL_BSP_SCHEDULE_DELAY 环境变量调
        processor = BatchSpanProcessor(exporter)
        provider.add_span_processor(processor)
        _otel_trace.set_tracer_provider(provider)
    except Exception:
        logger.exception(
            "[OTel] SDK 注册失败 endpoint=%s protocol=%s; span 仍走 NoOp",
            endpoint, protocol,
        )
        return False

    _INSTALLED = True
    logger.info(
        "[OTel] SDK installed: service=%s endpoint=%s protocol=%s "
        "(span 将通过 BatchSpanProcessor 异步发到 collector)",
        service_name, endpoint, protocol,
    )
    return True


def is_installed() -> bool:
    return _INSTALLED


def reset_for_test() -> None:
    """仅供测试使用：重置 _INSTALLED 让 setup_otel 可重新跑。"""
    global _INSTALLED
    _INSTALLED = False


__all__ = ["setup_otel", "is_installed", "reset_for_test"]
