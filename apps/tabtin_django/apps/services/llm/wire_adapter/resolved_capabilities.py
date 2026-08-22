"""LLM Wire Adapter · ResolvedCapabilities 数据模型(W1a 落地)。

W1a 范围(harness 总控 § D3 / D5):

* 把散在 6 家 service.py + provider_profiles.py + LLMModel 离散布尔字段的 capability
  真值统一写到 ``LLMModel.capabilities_config["wire_adapter"]`` 子键。
* 引入新的非 frozen ``ResolvedCapabilities``,W1+/W2 wire-format 适配可逐字段 mutate
  (区别于现有 frozen ``ModelCapabilities``,后者保留给 service.py 直调路径不动)。
* 8 组 nested dataclass(image / tool / wire / caching / json_mode / reasoning /
  usage / limits)+ 顶层 wave_status / is_configured + 3 个 SystemQuirk Enum。

设计要点:

* **非 frozen**:wire_adapter 出口前可能根据 model 实际配置覆盖单字段
  (例 OpenAI gpt-4o-mini 关闭 parallel_tool_use;Qwen 默认关 parallel 必须显式开)。
* **to_json / from_json**:JSON 序列化进 ``capabilities_config["wire_adapter"]``,
  反向加载时丢弃未知字段 + 记录 warn。
* **wave_status**:`'ready'` / `'w2_pending'` / `'w3_pending'`,Electron model picker
  消费(ready 可选;pending 标灰)。
* **is_configured**:False 时表示 fallback 到默认值(harness sanity check 要求
  active model is_configured=False 时启动期 logger.error)。

参考:总控 § 1.4(6 家真实 spec)+ § 6(6 家初值表,W1a migration 0015 写入)。
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from enum import Enum
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SystemQuirk Enum(系统消息处理特例,源自总控 § 1.4 + dogfood 验证)
# ---------------------------------------------------------------------------

class SystemQuirk(str, Enum):
    """系统消息处理特例。

    用于 wire-format 适配时识别 model 对 system message 的特殊处理:

    - ``QWQ_STRIP_TO_USER``:Qwen QwQ/QwQ-Plus 系列 system 不生效,需把 system
      内容拼到首条 user message 前缀。
    - ``QVQ_DROP``:Qwen QVQ(视觉推理)系列直接 drop system,不前置拼接。
    - ``MINIMAX_EXTRA_ROLES_PASSTHROUGH``:MiniMax 专属 ``user_system`` /
      ``group`` 角色,需透传不归一为 OpenAI 标准 role。
    """

    QWQ_STRIP_TO_USER = "qwq_strip_to_user"
    QVQ_DROP = "qvq_drop"
    MINIMAX_EXTRA_ROLES_PASSTHROUGH = "minimax_extra_roles_passthrough"


# ---------------------------------------------------------------------------
# 8 组 nested dataclass
# ---------------------------------------------------------------------------

@dataclass
class MediaFilesApiCaps:
    """``upload_mode=files_api`` 时的上游 Files API 参数（image/video 共用，provider 可配）。

    相对 ``ProxyContext.api_base`` 拼 endpoint；响应 ``id_field`` 拼成
    ``{url_scheme}{file_id}`` 写回 ``image_url`` / ``video_url``。
    """

    endpoint: str = "/files"
    purpose: str = "file"
    url_scheme: str = "ms://"
    id_field: str = "id"
    timeout_s: float = 180.0


# 兼容旧名（ 视频路径曾用 VideoFilesApiCaps）
VideoFilesApiCaps = MediaFilesApiCaps


@dataclass
class ImageCaps:
    """图像输入能力。

    - ``enabled``:是否支持图片输入。
    - ``input_via``:接受的传输形式 tuple(``"base64"``/``"url"``/``"file_id"``)。
      Kimi K2.5 dogfood bug:对 https URL 拒绝,只接受 base64 — 此处需声明
      ``("base64",)`` 而非 ``("base64", "url")``。
    - ``formats``:接受的图片 MIME 类型 tuple。
    - ``max_count_per_request``:单次请求最多多少张图。
    - ``max_size_bytes``:单图大小上限(字节)。
    - ``max_size_mb``(W1a-fix v2 别名):单图大小上限(MB),便于人读 + W1b
      WireAdapter 直接消费;若两者都填,以 ``max_size_bytes`` 为准。
    - ``request_shape``:请求体里图片 part 的形态:
      * ``"openai_image_url"``:``{type:'image_url', image_url:{url:...}}``
      * ``"anthropic_image_source"``:``{type:'image', source:{type, media_type, data}}``
    - ``upload_mode``: 本机/不可达 URL 的适配策略（**由 wire_adapter.image 配置**，
      不写死 provider_key；默认 ``inline_base64`` 对齐  与官方图片 base64 示例）:
      * ``none`` — 不主动改写（仅公网可达 URL 有意义）
      * ``files_api`` — 读字节 → Files API → ``files_api.url_scheme`` 引用
      * ``inline_base64`` — 读字节 → ``data:image/...;base64,...``
    - ``files_api`` / ``native_url_prefixes``: 同 VideoCaps。
    """

    enabled: bool = False
    input_via: Tuple[str, ...] = field(default_factory=tuple)
    formats: Tuple[str, ...] = field(default_factory=tuple)
    max_count_per_request: Optional[int] = None
    max_size_bytes: Optional[int] = None
    max_size_mb: Optional[int] = None
    request_shape: str = "openai_image_url"
    upload_mode: str = "inline_base64"
    files_api: MediaFilesApiCaps = field(default_factory=MediaFilesApiCaps)
    native_url_prefixes: Tuple[str, ...] = field(
        default_factory=lambda: ("data:image/",)
    )


@dataclass
class VideoCaps:
    """视频输入能力。

    - ``enabled`` / ``input_via``: wire gate（``url`` / ``file_id`` / ``base64``）。
    - ``upload_mode``: 不可达 URL 的适配策略（**由 provider 的 wire_adapter.video 配置**，
      不写死 provider_key）:
      * ``none`` — 透传 ``video_url``（仅公网可达 URL 有意义）
      * ``files_api`` — 读字节 → multipart 上传 → ``files_api.url_scheme`` 引用
      * ``inline_base64`` — 读字节 → ``data:video/...;base64,...``（官方小视频示例）
    - ``files_api``: ``upload_mode=files_api`` 时使用。
    - ``max_size_bytes`` / ``max_size_mb``: 单视频上限。
    - ``native_url_prefixes``: 已是上游原生形态、跳过上传的 URL 前缀。
    """

    enabled: bool = False
    input_via: Tuple[str, ...] = field(default_factory=tuple)
    upload_mode: str = "none"
    files_api: MediaFilesApiCaps = field(
        default_factory=lambda: MediaFilesApiCaps(purpose="video")
    )
    max_size_bytes: Optional[int] = None
    max_size_mb: Optional[int] = None
    native_url_prefixes: Tuple[str, ...] = field(
        default_factory=lambda: ("data:video/",)
    )


@dataclass
class DocumentCaps:
    """文档附件能力（ 方案1：Files API file-extract → 注入文本）。

    Moonshot/Kimi ``chat/completions`` **不接受** content 里的 ``type:file`` part；
    官方路径是 ``POST /files``（purpose=file-extract）→ ``GET /files/{id}/content``
    → 把提取文本放进 ``role=system`` 消息。

    - ``enabled``: 是否允许对话文档附件进入 wire 适配。
    - ``upload_mode``:
      * ``none`` — 透传 ``type:file``（仅当上游原生支持时；Moonshot 会 400）
      * ``file_extract`` — 读字节 → Files API extract → 注入 system 文本并剥离 file part
    - ``files_api``: ``upload_mode=file_extract`` 时的上传参数（默认 purpose=file-extract）。
    - ``max_size_bytes`` / ``max_size_mb``: 单文档字节上限。
    - ``max_extract_chars``: 注入文本字符上限（超出截断，避免撑爆上下文）。
    - ``inject_role``: 注入消息角色（Moonshot 官方为 ``system``）。
    - ``cache_extracted_text``: 按内容哈希缓存提取结果，避免多轮重复 upload。
    """

    enabled: bool = False
    upload_mode: str = "none"
    files_api: MediaFilesApiCaps = field(
        default_factory=lambda: MediaFilesApiCaps(purpose="file-extract")
    )
    max_size_bytes: Optional[int] = None
    max_size_mb: Optional[int] = None
    max_extract_chars: Optional[int] = 200_000
    inject_role: str = "system"
    cache_extracted_text: bool = True


@dataclass
class ToolCaps:
    """工具调用能力。

    - ``enabled``:是否支持 function/tool calling。
    - ``choice_modes``:支持的 ``tool_choice`` 模式 tuple
      (``"auto"`` / ``"required"`` / ``"none"`` / ``"specific"``)。
    - ``parallel_default``:默认并行调用是否开启。OpenAI/Claude 默认 True;
      Qwen DashScope 默认 False(必须显式 ``parallel_tool_calls=true``)。
    - ``parallel_param_name``:并行 toggle 参数名。OpenAI ``parallel_tool_calls``,
      Anthropic 反向 ``disable_parallel_tool_use``。
    - ``parallel_param_inverted``:True 表示参数语义反向(disable_xxx=true 等价
      于 parallel=false)。
    - ``param_field``(W1a-fix v2):tool definition 里参数 schema 的字段名。
      OpenAI / Gemini / Qwen / Moonshot 走 ``"parameters"``;
      Anthropic / MiniMax 走 ``"input_schema"``。W2 wire-format 适配用。
    - ``max_tools``(W1a-fix v2):单次请求最多挂多少 tools(None 表示无明确限制)。
      Moonshot 文档明示 128;OpenAI 文档明示 128;其他保守填 None。
    """

    enabled: bool = False
    choice_modes: Tuple[str, ...] = field(default_factory=tuple)
    parallel_default: bool = False
    parallel_param_name: str = "parallel_tool_calls"
    parallel_param_inverted: bool = False
    param_field: str = "parameters"
    max_tools: Optional[int] = None


@dataclass
class WireFormatCaps:
    """请求/响应 wire-format 协议形态。

    - ``request_protocol``:请求协议
      (``"openai_chat_completions"`` / ``"anthropic_messages"`` /
      ``"gemini_generate_content"``)。
    - ``response_protocol``:响应协议(同上)。
    - ``system_placement``:system message 放置形式
      (``"messages_first_role_system"`` 主流 / ``"top_level_system_field"``
      Anthropic / ``"minimax_user_system_role"`` MiniMax / ``"unsupported"``)。
    - ``system_quirks``:SystemQuirk 列表(string 形式存,Enum 值)。
      MiniMax 含 ``"minimax_extra_roles_passthrough"``;Qwen QwQ 系列含
      ``"qwq_strip_to_user"``。
    - ``stream_supported``:是否支持流式。
    - ``upstream_path``(W1a-fix v2):请求实际打到上游 base_url 之后的 URL path。
      OpenAI 兼容端 ``"/chat/completions"``;Anthropic SDK 路径 ``"/v1/messages"``;
      Gemini 原生 ``"/v1beta/models/{model}:generateContent"``(W2 才接通)。
      ZenMux 等聚合网关:统一 ``"/chat/completions"`` 出口,无论上游真实协议。
    - ``streaming_protocol``(W1a-fix v2):流式 chunk 编码协议形态。
      ``"openai_delta"`` 主流 SSE(data: {choices:[{delta:{...}}]}) /
      ``"anthropic_sse"`` Anthropic event-name SSE
      (event: content_block_delta / message_delta 等) /
      ``"gemini_sse"`` Gemini stream / ``"none"`` 不支持流式。
    - ``streaming_emits_usage``(W1a-fix v2):流式末尾是否会单独 emit usage 块。
      OpenAI / Moonshot / Qwen 默认在 final chunk 带 usage(True);
      Anthropic SSE 在 ``message_delta`` 带 usage(True);
      MiniMax anthropic 端同理(True);默认 True。
    - ``system_message_style``(W1a-fix v2 字段对齐别名):同 ``system_placement``,
      W1b WireAdapter 入口若希望直接用此字段名也可访问。两者保持同步即可。
    """

    request_protocol: str = "openai_chat_completions"
    response_protocol: str = "openai_chat_completions"
    system_placement: str = "messages_first_role_system"
    system_quirks: Tuple[str, ...] = field(default_factory=tuple)
    stream_supported: bool = True
    upstream_path: Optional[str] = None
    streaming_protocol: Optional[str] = None
    streaming_emits_usage: bool = True
    system_message_style: Optional[str] = None


@dataclass
class CachingCaps:
    """Prompt 缓存能力。

    - ``mode``:缓存类型
      (``"automatic_implicit"`` 全自动如 OpenAI/Kimi /
      ``"explicit_cache_control"`` 显式如 Anthropic /
      ``"context_cache"`` Gemini extra_body /
      ``"none"`` 不支持)。
    - ``min_tokens``(W1a-fix v2 别名):触发缓存的最低 token 数(同
      ``min_tokens_for_cache``,旧字段保留,新字段加供 W1b WireAdapter 直接读)。
    - ``min_tokens_for_cache``:触发缓存的最低 token 数(OpenAI 1024,Kimi 自动)。
    - ``cache_ttl_param``:显式缓存 TTL 参数路径
      (例 Anthropic ``cache_control.ttl``)。
    - ``cache_control_strip``(W1a-fix v2):转发到上游前是否需要剥离客户端发来
      的 ``cache_control`` block。Anthropic 原生端 False(透传);ZenMux 等
      不支持显式 cache_control 的兼容端 True(strip)。默认 False(透传)。
    """

    mode: str = "none"
    min_tokens_for_cache: Optional[int] = None
    min_tokens: Optional[int] = None
    cache_ttl_param: Optional[str] = None
    cache_control_strip: bool = False


@dataclass
class JsonModeCaps:
    """JSON / 结构化输出能力。

    - ``mode``:支持形式
      (``"json_schema"`` 标准 / ``"json_object"`` 弱 schema /
      ``"text_only"`` Qwen QwQ 不支持 schema / ``"none"``)。
    - ``modes``(W1a-fix v2):支持的所有 mode 集合。OpenAI 全套
      ``("json_schema","json_object")`` 同时支持;Qwen 只 ``("json_object",)``;
      Anthropic ``("json_schema",)`` 通过 output_config。空 tuple = 不支持。
    - ``strict_supported``:是否支持 strict mode(OpenAI 4o 起)。
    - ``schema_field``(W1a-fix v2):上游接收 schema 的字段路径。
      OpenAI ``"response_format.json_schema.schema"``;
      Anthropic ``"output_config.json_schema.schema"``;
      None = mode 为 json_object 或 none。
    - ``schema_fallback``(W1a-fix v2):若 schema 不被支持,是否降级为
      prompt-only 提示词约束(由 wire_adapter 把 schema 拼到 system 里)。
      Qwen / MiniMax 默认 True(无 schema 字段时由 wire_adapter 兜底);
      OpenAI / Anthropic / Moonshot / Gemini 已有原生 schema 字段,默认 False。
    """

    mode: str = "none"
    modes: Tuple[str, ...] = field(default_factory=tuple)
    strict_supported: bool = False
    schema_field: Optional[str] = None
    schema_fallback: bool = False


@dataclass
class ReasoningCaps:
    """推理 / Thinking / Chain-of-Thought 输出能力。

    - ``enabled``:是否支持 reasoning content。
    - ``surface``:reasoning 在响应里的位置
      (``"hidden"`` OpenAI o1 隐藏 /
      ``"thinking_block"`` Anthropic content_block /
      ``"delta_reasoning_content"`` Moonshot/Qwen delta.reasoning_content /
      ``"think_tag_inline"`` MiniMax OpenAI 端 ``<think>`` 标签内嵌 /
      ``"extra_body_thinking_config"`` Gemini)。
    - ``format``(W1a-fix v2 别名):reasoning 输出归类 token,语义同 ``surface``
      但用 W1b WireAdapter 期望的字段名。
      ``"hidden"`` / ``"thinking_block"`` / ``"reasoning_content_field"`` /
      ``"think_tag_inline"`` / ``"thinking_config"``。两者保持同步。
    - ``budget_param``:reasoning 预算参数名(``"reasoning_effort"`` OpenAI o1
      / ``"thinking.budget_tokens"`` Anthropic / None)。
    - ``param_path``(W1a-fix v2):请求侧开启 reasoning 的参数挂点
      (Anthropic ``"thinking"`` 顶层;Gemini ``"extra_body.google.thinking_config"``;
      OpenAI ``"reasoning_effort"``;Doubao ``"thinking+reasoning_effort"``;
      Moonshot/Qwen None — delta 输出无显式开关)。
    - ``visible_to_client``(W1a-fix v2):reasoning 是否对终端用户可见。
      Moonshot K2.5 / Qwen / Anthropic / MiniMax = True(用户可看 thinking);
      OpenAI o1 = False(隐藏)。默认 True。
    - ``budget_map``(Runtime Profile Phase 1):canonical effort 档位 → 该模型的
      ``thinking.budget_tokens`` 取值。仅 ``param_path="thinking"``(Claude 风)
      路径消费。``None`` = 用 ``request_adapter`` 内的默认表。
      不同 Claude / Kimi 型号的合理 budget 不同(且受 ``max_tokens`` 约束),
      故留 per-model 覆盖口子;Phase 1 不给任何模型写值,只通读取能力。
    """

    enabled: bool = False
    surface: str = "hidden"
    format: Optional[str] = None
    budget_param: Optional[str] = None
    param_path: Optional[str] = None
    visible_to_client: bool = True
    budget_map: Optional[Dict[str, int]] = None


@dataclass
class UsageCaps:
    """Token usage 上报形态。

    - ``input_tokens_field``:输入 token 字段名
      (``"prompt_tokens"`` OpenAI / ``"input_tokens"`` Anthropic)。
    - ``input_field``(W1a-fix v2 别名):同 ``input_tokens_field`` 的简短别名,
      W1b WireAdapter 直接读。两者保持同步。
    - ``output_tokens_field``:输出 token 字段名。
    - ``output_field``(W1a-fix v2 别名):同 ``output_tokens_field`` 的简短别名。
    - ``cache_read_field``:缓存命中输入 token 字段位置
      (``"prompt_tokens_details.cached_tokens"`` OpenAI 嵌套 /
      ``"cache_read_input_tokens"`` Anthropic 顶层 /
      ``"cached_tokens"`` Moonshot 顶层 / None)。
    - ``cached_path``(W1a-fix v2 别名):同 ``cache_read_field``,W1b 期望字段名。
    - ``cache_write_field``:缓存写入 token 字段名。
    - ``cache_creation_path``(W1a-fix v2 别名):同 ``cache_write_field``。
    - ``extra_metrics``:渠道特有指标 tuple(MiniMax 含 ``"total_characters"``)。
    - ``extra_fields``(W1a-fix v2 别名):同 ``extra_metrics``,W1b 期望字段名。
    """

    input_tokens_field: str = "prompt_tokens"
    output_tokens_field: str = "completion_tokens"
    cache_read_field: Optional[str] = None
    cache_write_field: Optional[str] = None
    extra_metrics: Tuple[str, ...] = field(default_factory=tuple)
    input_field: Optional[str] = None
    output_field: Optional[str] = None
    cached_path: Optional[str] = None
    cache_creation_path: Optional[str] = None
    extra_fields: Tuple[str, ...] = field(default_factory=tuple)


@dataclass
class LimitsCaps:
    """各类容量上限。

    - ``context_window_tokens``:上下文窗口总容量。
    - ``context_window``(W1a-fix v2 别名):同 ``context_window_tokens``。
    - ``max_output_tokens``:单次最大生成 token 数。
    - ``max_documents_per_request``:单请求最大文档数。
    - ``max_tool_recursion_depth``:工具递归深度上限(渠道 hard limit,默认 None)。
    - ``request_payload_max_mb``(W1a-fix v2):上游 HTTP body 大小上限(MB)。
      多数 chat API 支持 25-30MB,Claude 32MB,默认 None 表示无明确文档限制。
    - ``silent_drop_params``(W1a-fix v2):上游会**静默丢弃**的请求参数 tuple。
      Gemini OpenAI 兼容层不支持 ``logit_bias`` / ``top_logprobs`` /
      ``frequency_penalty`` 等,但接收时不报错只 silent drop。
      wire_adapter 出口前剥离,避免假成功。
    - ``extra_routing_headers``(W1a-fix v2):上游需要的额外路由 header dict
      (例 ZenMux 可能要 ``X-Zenmux-Provider`` 等);默认空 dict。
    """

    context_window_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_documents_per_request: Optional[int] = None
    max_tool_recursion_depth: Optional[int] = None
    context_window: Optional[int] = None
    request_payload_max_mb: Optional[int] = None
    silent_drop_params: Tuple[str, ...] = field(default_factory=tuple)
    extra_routing_headers: Dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# ResolvedCapabilities(顶层非 frozen 容器)
# ---------------------------------------------------------------------------

@dataclass
class ResolvedCapabilities:
    """LLMProxy wire_adapter 用的统一 capability 视图(W1a 引入)。

    构造方式:

    * 配置侧:``ResolvedCapabilities.from_json(model.capabilities_config["wire_adapter"])``
    * 默认值:``ResolvedCapabilities()`` 全保守 + ``is_configured=False``,wire_adapter
      只允许走最小集合(text-only,无 image / tool / cache),避免 dogfood 类
      hang 事故扩散。

    顶层字段:

    - ``wave_status``:``"ready"`` 默认 / ``"w2_pending"`` / ``"w3_pending"``。
      Electron model picker 消费,w2/w3 pending 显示标灰提示。
    - ``is_configured``:True 表示该 model 在 W1a migration 0015 已预填或 admin
      手工补齐,wire_adapter 可放心走 capability 驱动适配;False 表示走默认保守
      路径(LLMProxy 启动期 logger.error 提示)。
    """

    image: ImageCaps = field(default_factory=ImageCaps)
    video: VideoCaps = field(default_factory=VideoCaps)
    document: DocumentCaps = field(default_factory=DocumentCaps)
    tool: ToolCaps = field(default_factory=ToolCaps)
    wire: WireFormatCaps = field(default_factory=WireFormatCaps)
    caching: CachingCaps = field(default_factory=CachingCaps)
    json_mode: JsonModeCaps = field(default_factory=JsonModeCaps)
    reasoning: ReasoningCaps = field(default_factory=ReasoningCaps)
    usage: UsageCaps = field(default_factory=UsageCaps)
    limits: LimitsCaps = field(default_factory=LimitsCaps)
    wave_status: str = "ready"
    is_configured: bool = False

    # ------------------------------------------------------------------
    # JSON 序列化
    # ------------------------------------------------------------------
    def to_json(self) -> Dict[str, Any]:
        """序列化成 JSON 兼容 dict,用于写入 ``capabilities_config["wire_adapter"]``。

        tuple 字段会变成 list(JSON 不支持 tuple),from_json 反向再 cast 回 tuple。
        """
        return _dataclass_to_json(self)

    @classmethod
    def from_json(cls, data: Optional[Dict[str, Any]]) -> "ResolvedCapabilities":
        """从 ``capabilities_config["wire_adapter"]`` 反序列化。

        - ``data`` 为 None / 空 dict → 返回默认值(``is_configured=False``)。
        - 字段缺失 → 用 dataclass 默认值。
        - 未知字段 → ``logger.warning`` 记录后忽略。
        """
        if not data:
            return cls()
        if not isinstance(data, dict):
            logger.warning(
                "[wire_adapter] ResolvedCapabilities.from_json 收到非 dict 类型 %s,回退默认值",
                type(data).__name__,
            )
            return cls()
        return _json_to_dataclass(cls, data)


# ---------------------------------------------------------------------------
# 序列化辅助函数(支持 tuple ↔ list 互转,unknown field 丢弃 + warn)
# ---------------------------------------------------------------------------

def _dataclass_to_json(obj: Any) -> Any:
    """递归把 dataclass 转 JSON-safe dict;tuple 转 list。"""
    if is_dataclass(obj):
        result: Dict[str, Any] = {}
        for f in fields(obj):
            result[f.name] = _dataclass_to_json(getattr(obj, f.name))
        return result
    if isinstance(obj, tuple):
        return [_dataclass_to_json(item) for item in obj]
    if isinstance(obj, list):
        return [_dataclass_to_json(item) for item in obj]
    if isinstance(obj, Enum):
        return obj.value
    return obj


def _json_to_dataclass(dc_class: Any, data: Dict[str, Any]) -> Any:
    """递归把 dict 还原回 dataclass 实例。

    - 对每个 dataclass field 取 ``data[field.name]`` 或默认值。
    - tuple 类型字段把 list cast 回 tuple。
    - nested dataclass 字段递归调用。
    - data 中存在但 dc_class 没声明的字段 → ``logger.warning`` + 忽略。
    """
    field_names = {f.name for f in fields(dc_class)}
    unknown = set(data.keys()) - field_names
    if unknown:
        logger.warning(
            "[wire_adapter] %s.from_json 忽略未知字段: %s",
            dc_class.__name__,
            sorted(unknown),
        )

    init_kwargs: Dict[str, Any] = {}
    for f in fields(dc_class):
        if f.name not in data:
            continue
        raw = data[f.name]

        # nested dataclass(根据 default_factory 推断)
        if is_dataclass(f.type) and isinstance(raw, dict):
            init_kwargs[f.name] = _json_to_dataclass(f.type, raw)
            continue

        # 当 type 是字符串(future annotations) - 通过 default_factory / default
        # 实例 type 探测
        nested_class = _detect_nested_dataclass(dc_class, f.name)
        if nested_class is not None and isinstance(raw, dict):
            init_kwargs[f.name] = _json_to_dataclass(nested_class, raw)
            continue

        # tuple 字段(JSON 里是 list)
        if _field_default_is_tuple(dc_class, f.name) and isinstance(raw, list):
            init_kwargs[f.name] = tuple(raw)
            continue

        init_kwargs[f.name] = raw

    return dc_class(**init_kwargs)


def _detect_nested_dataclass(dc_class: Any, field_name: str) -> Optional[type]:
    """通过 default_factory 探测 nested dataclass 类型(适配 future annotations)。"""
    for f in fields(dc_class):
        if f.name != field_name:
            continue
        factory = f.default_factory  # type: ignore[attr-defined]
        if factory is None:
            return None
        if factory is field:  # MISSING sentinel
            return None
        try:
            sample = factory()
        except Exception:
            return None
        if is_dataclass(sample):
            return type(sample)
    return None


def _field_default_is_tuple(dc_class: Any, field_name: str) -> bool:
    """判定 field 默认值是否为 tuple(用于 list ↔ tuple 反序列化)。"""
    for f in fields(dc_class):
        if f.name != field_name:
            continue
        factory = f.default_factory  # type: ignore[attr-defined]
        if factory is None:
            return False
        try:
            sample = factory()
        except Exception:
            return False
        return isinstance(sample, tuple)
    return False


__all__ = [
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
    "ResolvedCapabilities",
]


# 兼容 dataclass-light asdict 调用(不需要,留个引用避免 lint 报警)
_ASDICT_KEEP_REF = asdict
