"""LLM Wire Adapter — LLMProxy 入口的 wire-format 适配层。

W0 落地:错误文案模板表 + render_error API + 临时 image normalizer +
SSE error 透传。
W1a 落地:ResolvedCapabilities 数据模型 + 9 nested dataclass + JSON 序列化 +
``apps.services.llm.utils.capabilities.resolve_for_wire`` + capabilities_config['wire_adapter']
子键。(原 LLMModel.get_wire_capabilities() 薄包装方法已在 6c6b7a1ae「AI 能力统一宪法
v0.1 落地」中删除,所有调用方统一改走 utils helper。)
W1b 落地:
  - request_adapter.adapt_request:8 个 _normalize_* helpers + capability gate
  - image_fetcher:Redis L2 + 并发下载升级
  - feature_flag:LLM_WIRE_ADAPTER_ENABLED env + capabilities_config['wire_adapter']['disabled']
    （v0.1：原 LLMModel.wire_adapter_disabled 字段已删，灰度回滚改进 capabilities_config 子键）
  - stream_adapter / sdk_dispatcher:占位接口(W2 真实实装)
W1c 落地(本期):
  - capability_enums:字段 enum 权威值表 + helper 识别清单
  - validator:静态校验器(9 项校验项)
  - probes:6 个 dry-run probe + drift 判定框架
  - validate_wire_capabilities / llm_capability_test management commands
"""

from .error_messages import (
    ERROR_TEMPLATES,
    ImageFetchError,
    render_error,
)
from .feature_flag import is_wire_adapter_enabled
from .image_fetcher import (
    DEFAULT_MAX_COUNT_PER_REQUEST,
    DEFAULT_MAX_SIZE_BYTES,
    IMAGE_FETCH_TIMEOUT_S,
    fetch_image_to_data_url,
    normalize_image_urls,
)
from .request_adapter import (
    CapabilityGateError,
    adapt_request,
)
from .resolved_capabilities import (
    CachingCaps,
    DocumentCaps,
    ImageCaps,
    JsonModeCaps,
    LimitsCaps,
    MediaFilesApiCaps,
    ReasoningCaps,
    ResolvedCapabilities,
    SystemQuirk,
    ToolCaps,
    UsageCaps,
    VideoCaps,
    VideoFilesApiCaps,
    WireFormatCaps,
)
from .sdk_dispatcher import select_sdk_dispatch
from .stream_adapter import adapt_stream

__all__ = [
    # error_messages
    "ERROR_TEMPLATES",
    "ImageFetchError",
    "render_error",
    # resolved_capabilities (W1a)
    "ResolvedCapabilities",
    "SystemQuirk",
    "ImageCaps",
    "VideoCaps",
    "DocumentCaps",
    "MediaFilesApiCaps",
    "VideoFilesApiCaps",
    "ToolCaps",
    "WireFormatCaps",
    "CachingCaps",
    "JsonModeCaps",
    "ReasoningCaps",
    "UsageCaps",
    "LimitsCaps",
    # feature_flag (W1b)
    "is_wire_adapter_enabled",
    # request_adapter (W1b)
    "adapt_request",
    "CapabilityGateError",
    # stream_adapter (W1b stub)
    "adapt_stream",
    # sdk_dispatcher (W1b stub)
    "select_sdk_dispatch",
    # image_fetcher (W1b)
    "normalize_image_urls",
    "fetch_image_to_data_url",
    "DEFAULT_MAX_COUNT_PER_REQUEST",
    "DEFAULT_MAX_SIZE_BYTES",
    "IMAGE_FETCH_TIMEOUT_S",
]
