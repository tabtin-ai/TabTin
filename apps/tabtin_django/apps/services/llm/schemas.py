"""
LLM服务API数据模式
"""

from typing import List, Literal, Optional, Dict, Any, Union
from urllib.parse import urlparse
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator
from datetime import datetime
from decimal import Decimal


# 聊天相关模式
class ChatMessage(BaseModel):
    """聊天消息"""
    role: str = Field(..., description="角色: system, user, assistant")
    content: Union[str, List[Dict[str, Any]]] = Field(..., description="消息内容")

    @field_validator('role')
    @classmethod
    def validate_role(cls, v):
        if v not in ['system', 'user', 'assistant', 'tool']:
            raise ValueError('角色必须是 system, user, assistant 或 tool')
        return v


def _require_model_or_model_id(instance):
    """model 与 model_id 至少提供一个。"""
    if not instance.model and not instance.model_id:
        raise ValueError('必须提供 model 或 model_id')
    return instance


class ChatRequestBase(BaseModel):
    """聊天请求公共字段基类"""
    model_config = ConfigDict(protected_namespaces=())
    model: Optional[str] = Field(None, description="模型名称")
    model_id: Optional[str] = Field(None, description="模型 UUID（推荐）")
    messages: List[ChatMessage] = Field(..., min_length=1, description="消息列表")
    temperature: Optional[float] = Field(0.7, ge=0.0, le=2.0, description="温度参数")
    # max_tokens 在 OpenAI 协议下是"最大输出 Token"参数，与 LLMModel.context_window_tokens 不同义，
    # 这里保留作为请求级运行时参数；服务侧不再以 model.max_tokens 字段做容量约束。
    max_tokens: Optional[int] = Field(2000, ge=1, le=2_000_000, description="最大输出Token数（OpenAI 协议参数）")
    user_id: Optional[str] = Field(None, description="用户ID")
    organization_id: str = Field(..., description="组织ID（计费主体，必填）")
    # v0.1：use_case / source_app 字段已删（LLMUsageFact schema 0022 移除），
    # 业务调用方应改走 8 个 capability 入口 + scene_key（参见 02_调用契约.md）。
    # 兼容期：客户端仍传 use_case（旧字段名）会被 pydantic 忽略；下游代码访问
    # `payload.use_case` / `payload.source_app` 由本模型的兼容 property 返回 None。
    scene_key: Optional[str] = Field(None, description="场景标识（v0.1，对应 LLMUsageFact.scene_key）")
    response_format: Optional[Union[str, Dict[str, Any]]] = Field(None, description="响应格式")
    functions: Optional[List[Dict[str, Any]]] = Field(None, description="函数定义")
    function_call: Optional[Union[str, Dict[str, Any]]] = Field(None, description="函数调用策略")
    tools: Optional[List[Dict[str, Any]]] = Field(None, description="工具定义")
    tool_choice: Optional[Union[str, Dict[str, Any]]] = Field(None, description="工具选择策略")
    thinking: Optional[Dict[str, Any]] = Field(None, description="推理/思考配置")
    metadata: Optional[Dict[str, Any]] = Field(None, description="元信息")
    documents: Optional[List[str]] = Field(None, description="文档输入")
    api_variant: Optional[str] = Field(None, description="协议变体")
    use_responses_api: Optional[bool] = Field(None, description="是否启用 Responses API")
    previous_response_id: Optional[str] = Field(None, description="Responses API 上一轮 response_id")
    store: Optional[bool] = Field(None, description="Responses API 是否存储会话")
    include: Optional[List[str]] = Field(None, description="Responses API include 扩展项")
    prompt_cache_key: Optional[str] = Field(None, description="Prompt Caching 路由键")
    prompt_cache_retention: Optional[str] = Field(None, description="Prompt Caching 保留策略")
    provider_options: Optional[Dict[str, Any]] = Field(None, description="渠道自定义参数透传")

    @model_validator(mode='after')
    def validate_model_identity(self):
        return _require_model_or_model_id(self)

    # ──────────────────────────────────────────────
    # v0.1 兼容 property：use_case / source_app 字段已从 schema 删除，
    # 但仍有少量下游代码（如 api_async）访问；以 property 形式静默返回 None。
    # 待 Phase B 把所有下游引用迁到 scene_key 后，本兼容层一并删除。
    # ──────────────────────────────────────────────
    @property
    def use_case(self) -> Optional[str]:  # noqa: D401
        return None

    @property
    def source_app(self) -> Optional[str]:  # noqa: D401
        return None


class ChatRequest(ChatRequestBase):
    """聊天请求"""
    top_p: Optional[float] = Field(1.0, ge=0.0, le=1.0, description="Top-p参数")
    frequency_penalty: Optional[float] = Field(0.0, ge=-2.0, le=2.0, description="频率惩罚")
    presence_penalty: Optional[float] = Field(0.0, ge=-2.0, le=2.0, description="存在惩罚")
    stream: Optional[bool] = Field(False, description="是否流式响应")


_SSRF_BLOCKED_HOSTS = frozenset({
    'metadata.google.internal',
    'metadata.goog',
    '169.254.169.254',
    'fd00::',
})

_ALLOWED_IMAGE_URL_SCHEMES = frozenset({'http', 'https', 'data'})


def _is_private_ip(hostname: str) -> bool:
    """检测是否为私有/保留 IP 地址段，阻止 SSRF。"""
    import ipaddress
    try:
        addr = ipaddress.ip_address(hostname)
        return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved
    except ValueError:
        return False


class ChatVisionRequest(ChatRequestBase):
    """图片聊天请求"""
    image_urls: List[str] = Field(..., min_length=1, description="图片URL列表")
    # v0.1：use_case 字段已删；vision 调用走 vision capability_domain 入口或 scene_key='vision_*'。

    @field_validator('image_urls')
    @classmethod
    def validate_image_urls(cls, v):
        if len(v) > 10:
            raise ValueError('最多支持10张图片')
        for url in v:
            parsed = urlparse(url)
            if parsed.scheme not in _ALLOWED_IMAGE_URL_SCHEMES:
                raise ValueError(
                    f'不支持的 URL scheme: {parsed.scheme}，仅允许 http/https/data'
                )
            if parsed.scheme in ('http', 'https'):
                hostname = parsed.hostname or ''
                if hostname in _SSRF_BLOCKED_HOSTS or _is_private_ip(hostname):
                    raise ValueError('不允许访问内部网络地址')
        return v


class UsageInfo(BaseModel):
    """使用量信息"""
    input_tokens: int = Field(..., description="输入Token数")
    output_tokens: int = Field(..., description="输出Token数")
    total_tokens: int = Field(..., description="总Token数")
    cache_read_input_tokens: Optional[int] = Field(None, description="命中缓存的输入 Token 数")
    cache_creation_input_tokens: Optional[int] = Field(None, description="缓存写入输入 Token 数")
    reasoning_tokens: Optional[int] = Field(None, description="推理 Token 数")
    estimated: Optional[bool] = Field(None, description="是否为本地估算值（Provider 未返回 usage 时标记为 True）")


class CostInfo(BaseModel):
    """成本信息"""
    input_cost: Decimal = Field(..., description="输入成本")
    output_cost: Decimal = Field(..., description="输出成本")
    total_cost: Decimal = Field(..., description="总成本")
    cache_read_cost: Optional[Decimal] = Field(None, description="缓存命中成本")
    cache_write_cost: Optional[Decimal] = Field(None, description="缓存写入成本")


class ChatStreamChunk(BaseModel):
    """流式聊天响应片段"""
    content: str = Field(..., description="内容片段")
    finished: bool = Field(..., description="是否完成")
    usage: Optional[UsageInfo] = Field(None, description="使用量信息")
    cost: Optional[CostInfo] = Field(None, description="成本信息")
    response_time: Optional[float] = Field(None, description="响应时间")
    model: Optional[str] = Field(None, description="模型名称")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(None, description="工具调用列表（流式累计）")
    tool_calls_delta: Optional[List[Dict[str, Any]]] = Field(None, description="工具调用增量（单 chunk）")
    reasoning_details: Optional[List[Dict[str, Any]]] = Field(None, description="推理内容块")


class TokenEstimateRequest(BaseModel):
    """Token 估算请求"""
    model_config = ConfigDict(protected_namespaces=())
    model: Optional[str] = Field(None, description="模型名称")
    model_id: Optional[str] = Field(None, description="模型 UUID（推荐）")
    messages: List[ChatMessage] = Field(..., description="消息列表")
    user_id: Optional[str] = Field(None, description="用户ID")
    organization_id: str = Field(..., description="组织ID（计费主体，必填）")
    prefer_provider_api: bool = Field(True, description="优先使用渠道原生估算接口")

    @model_validator(mode='after')
    def validate_model_identity(self):
        return _require_model_or_model_id(self)


class FundingPreviewRequest(BaseModel):
    """客户端发送前的只读 LLM 资金预览请求。"""
    model_config = ConfigDict(protected_namespaces=())
    organization_id: str = Field(..., description="组织ID（计费主体）")
    model_id: str = Field(..., description="模型 UUID")
    estimated_tokens: int = Field(..., ge=0, le=10_000_000, description="预计总 Token 数")


# 模型相关模式
class ModelInfo(BaseModel):
    """模型信息（v0.1 schema 对齐 LLMModel）"""
    model_config = ConfigDict(protected_namespaces=())
    id: str = Field(..., description="模型ID")
    name: str = Field(..., description="模型名称")
    model_name: Optional[str] = Field(None, description="模型名称（兼容字段）")
    display_name: str = Field(..., description="显示名称")
    provider: str = Field(..., description="提供商")
    provider_display_name: str = Field(..., description="提供商显示名称")
    provider_id: Optional[str] = Field(None, description="提供商ID")
    provider_key: Optional[str] = Field(None, description="提供商渠道标识")
    provider_scope: Optional[str] = Field(None, description="提供商作用范围")
    provider_routing_enabled: Optional[bool] = Field(
        None, description="提供商是否参与路由（：客户端据此过滤禁用渠道）"
    )
    routing_enabled: Optional[bool] = Field(
        None, description="模型是否可路由（与 provider_routing_enabled 对齐）"
    )
    description: Optional[str] = Field(None, description="模型描述")
    # v0.1：mode 字段已删 → capability_domain；max_tokens → context_window_tokens；
    # 细粒度能力真值在 capabilities_config / resolved_capabilities；
    # 下列 supports_* 为 catalog 顶层兼容字段（ChatClient / Electron Host 门控仍读顶层）。
    # is_active 字段已删（路由由 routing_enabled + wave_status='ready' 表达）。
    capability_domain: Optional[str] = Field(None, description="能力域（chat/embedding/vision/asr/tts/image_gen/video_gen/audio_gen）")
    context_window_tokens: Optional[int] = Field(None, description="上下文总容量(Token)")
    max_input_tokens: Optional[int] = Field(None, description="最大输入Token数")
    max_output_tokens: Optional[int] = Field(None, description="最大输出Token数")
    supports_streaming: Optional[bool] = Field(None, description="是否支持流式输出")
    supports_function_calling: Optional[bool] = Field(None, description="是否支持工具调用")
    supports_vision: Optional[bool] = Field(None, description="是否支持图片输入")
    supports_video_input: Optional[bool] = Field(
        None, description="是否支持原生视频输入（video_url，）"
    )
    supports_document_input: Optional[bool] = Field(
        None, description="是否支持原生文档输入（file_url，）"
    )
    capabilities_config: Optional[Dict[str, Any]] = Field(None, description="扩展能力配置（含 wire/tool/image/limits 等）")
    resolved_capabilities: Optional[Dict[str, bool]] = Field(None, description="归一化能力快照")
    resolved_limits: Optional[Dict[str, Any]] = Field(None, description="归一化限制快照")
    # 子 Agent 模型自由度（Phase 4）：语义用途标签（便宜/快、长上下文、视觉、强/贵）。
    # 优先取 capabilities_config.usage_hint（运营只填一个用途标签），否则按能力 +
    # 成本档自动派生——不让运营手写自由文案（PRD §4 决策三 / 开放问题 3）。
    usage_hint: Optional[str] = Field(None, description="语义用途标签（子 Agent 选型提示，自动生成）")
    billing_type: str = Field(..., description="计费类型")
    input_price_per_1k: Optional[float] = Field(None, description="输入Token价格(每1K)")
    output_price_per_1k: Optional[float] = Field(None, description="输出Token价格(每1K)")
    price_per_request: Optional[float] = Field(None, description="每次请求价格")
    price_per_second: Optional[float] = Field(None, description="每秒价格")
    cost_per_1k_tokens: float = Field(..., description="每1K Token成本")
    has_tiered_pricing: Optional[bool] = Field(None, description="是否有阶梯计价")
    context_tiers: Optional[List[Dict[str, Any]]] = Field(
        None,
        description=(
            "上下文档位列表（与 tiered_pricing 共用底层数据，仅展示元信息）。"
            "每项含 id / label / is_default / max_input_tokens / tags / "
            "has_extra_headers / 单价等字段，extra_headers 内容已脱敏。"
        ),
    )
    runtime_controls: Optional[List[Dict[str, Any]]] = Field(
        None,
        description="模型运行时可调参数控件模板（如 reasoning_effort select）。",
    )
    runtime_profile: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Canonical Runtime Profile capability（W2e）。"
            "形状：{thinking:{supported,modes,default_mode}}；"
            "不含 provider / wire 参数。与 runtime_controls 并存。"
        ),
    )
    is_user_config: bool = Field(..., description="是否为用户配置")
    wave_status: Optional[str] = Field(None, description="Wave 上线状态（ready/w2_pending/w3_pending）")
    source: Optional[str] = Field(None, description="模型来源：None=DB录入, provider_declared=Provider静态声明")



# 统计相关模式
class StatisticsQuery(BaseModel):
    """统计查询参数"""
    start_date: Optional[str] = Field(None, description="开始日期 YYYY-MM-DD")
    end_date: Optional[str] = Field(None, description="结束日期 YYYY-MM-DD")
    model: Optional[str] = Field(None, description="模型名称")
    user_id: Optional[str] = Field(None, description="用户ID")


class StatisticsInfo(BaseModel):
    """统计信息"""
    date: str = Field(..., description="日期")
    model_name: str = Field(..., description="模型名称")
    user_id: Optional[str] = Field(None, description="用户ID")
    total_requests: int = Field(..., description="总请求数")
    successful_requests: int = Field(..., description="成功请求数")
    failed_requests: int = Field(..., description="失败请求数")
    total_input_tokens: Optional[int] = Field(None, description="总输入Token数")
    total_output_tokens: Optional[int] = Field(None, description="总输出Token数")
    total_tokens: int = Field(..., description="总Token数")
    total_cache_read_input_tokens: Optional[int] = Field(None, description="总缓存命中输入Token数")
    total_cache_creation_input_tokens: Optional[int] = Field(None, description="总缓存写入输入Token数")
    total_cost: Decimal = Field(..., description="总成本")
    avg_response_time: float = Field(..., description="平均响应时间")
    success_rate: float = Field(..., description="成功率")

    model_config = ConfigDict(protected_namespaces=())



# 请求记录相关模式
class RequestQuery(BaseModel):
    """请求记录查询参数"""
    page: int = Field(1, ge=1, description="页码")
    page_size: int = Field(20, ge=1, le=100, description="每页大小")
    status: Optional[str] = Field(None, description="状态筛选")
    model: Optional[str] = Field(None, description="模型筛选")
    user_id: Optional[str] = Field(None, description="用户ID筛选")
    start_date: Optional[str] = Field(None, description="开始日期")
    end_date: Optional[str] = Field(None, description="结束日期")


class RequestRecord(BaseModel):
    """请求记录"""
    id: str = Field(..., description="记录ID")
    request_id: str = Field(..., description="请求ID")
    model_name: str = Field(..., description="模型名称")
    user_id: Optional[str] = Field(None, description="用户ID")
    prompt: str = Field(..., description="用户提示词")
    response: str = Field(..., description="模型响应")
    status: str = Field(..., description="状态")
    usage: Optional[UsageInfo] = Field(None, description="使用量")
    cost: Optional[CostInfo] = Field(None, description="成本")
    response_time: float = Field(..., description="响应时间")
    created_at: datetime = Field(..., description="创建时间")
    completed_at: Optional[datetime] = Field(None, description="完成时间")
    error_message: Optional[str] = Field(None, description="错误消息")

    model_config = ConfigDict(protected_namespaces=())



# 配置相关模式
class ProviderConfigRequest(BaseModel):
    """提供商配置请求"""
    provider_name: str = Field(..., description="提供商名称")
    provider_key: Optional[str] = Field(None, description="渠道标识（可选）")
    api_key: str = Field(..., description="API密钥")
    base_url: str = Field(..., description="新模型默认 API Base URL")
    # 兼容旧客户端字段；服务端不再据此隐式创建模型。
    model_name: Optional[str] = Field(None, description="已弃用；请通过模型管理显式创建模型")

    model_config = ConfigDict(protected_namespaces=())



# 组织配置相关模式
class OrganizationProviderCreateRequest(BaseModel):
    """组织提供商配置请求"""
    provider_name: str = Field(..., description="提供商名称")
    provider_key: str = Field(..., description="渠道标识")
    display_name: Optional[str] = Field(None, description="显示名称")
    base_url: str = Field(..., description="新模型默认 API Base URL")
    api_key: str = Field(..., description="API密钥")
    scope: Literal['organization', 'user'] = Field('organization', description="配置范围：organization/user")

    model_config = ConfigDict(protected_namespaces=())


class OrganizationProviderUpdateRequest(BaseModel):
    """组织提供商配置更新请求（v0.1 schema）"""
    display_name: Optional[str] = Field(None, description="显示名称")
    base_url: Optional[str] = Field(None, description="API基础URL")
    api_key: Optional[str] = Field(None, description="API密钥")
    # v0.1：is_active → routing_enabled。
    routing_enabled: Optional[bool] = Field(None, description="是否参与路由（v0.1 替代 is_active）")

    model_config = ConfigDict(protected_namespaces=())

    @property
    def is_active(self) -> Optional[bool]:
        """v0.1 兼容 property：is_active 字段已删，访问时返回 None。"""
        return None


class OrganizationModelCreateRequest(BaseModel):
    """组织模型创建请求（v0.1 schema）"""
    provider_id: str = Field(..., description="提供商ID")
    model_name: str = Field(..., description="模型名称")
    display_name: str = Field(..., description="显示名称")
    description: Optional[str] = Field(None, description="模型描述")
    # endpoint 跟 Model 走；未显式填写时继承 Provider.default_base_url。
    base_url: Optional[str] = Field(None, description="HTTP/WS 端点 URL")
    # v0.1：max_tokens → context_window_tokens；
    # supports_streaming / supports_function_calling / supports_vision 等硬开关
    # 全部进 capabilities_config
    context_window_tokens: int = Field(..., ge=1, description="上下文总容量(Token)")
    max_input_tokens: Optional[int] = Field(None, ge=1, description="最大输入Token数")
    max_output_tokens: Optional[int] = Field(None, ge=1, description="最大输出Token数")
    capabilities_config: Optional[Dict[str, Any]] = Field(None, description="能力配置（wire/tool/image/limits）")
    billing_type: str = Field('token', description="计费类型")
    input_price_per_1k: Decimal = Field(Decimal('0'), description="输入Token价格(每1K)")
    output_price_per_1k: Decimal = Field(Decimal('0'), description="输出Token价格(每1K)")

    model_config = ConfigDict(protected_namespaces=())


class OrganizationModelUpdateRequest(BaseModel):
    """组织模型更新请求（v0.1 schema）"""
    model_name: Optional[str] = Field(None, description="模型名称")
    display_name: Optional[str] = Field(None, description="显示名称")
    description: Optional[str] = Field(None, description="模型描述")
    base_url: Optional[str] = Field(None, description="HTTP/WS 端点 URL；不传则保持原值")
    context_window_tokens: Optional[int] = Field(None, ge=1, description="上下文总容量(Token)")
    max_input_tokens: Optional[int] = Field(None, ge=1, description="最大输入Token数")
    max_output_tokens: Optional[int] = Field(None, ge=1, description="最大输出Token数")
    capabilities_config: Optional[Dict[str, Any]] = Field(None, description="能力配置（wire/tool/image/limits）")
    # v0.1：模型 is_active 字段已删（0022），下线模型直接 DELETE。

    model_config = ConfigDict(protected_namespaces=())


class OrganizationDefaultModelRequest(BaseModel):
    """设置组织默认模型"""
    model_id: str = Field(..., description="默认模型ID")

    model_config = ConfigDict(protected_namespaces=())


class UserDefaultModelRequest(BaseModel):
    """设置当前用户在指定组织内的默认模型"""
    model_id: Optional[str] = Field(None, description="当前用户默认模型ID；为空时跟随组织默认模型")

    model_config = ConfigDict(protected_namespaces=())


class OrganizationSubagentModelRequest(BaseModel):
    """设置组织默认子 Agent 模型策略。"""

    mode: Literal['inherit', 'inherit_main', 'fixed'] = Field(
        ...,
        description="inherit=跟随上级默认；inherit_main=跟随主 Agent；fixed=使用指定模型",
    )
    model_id: Optional[str] = Field(None, description="mode=fixed 时必填的模型 ID")

    @model_validator(mode='after')
    def validate_fixed_model(self):
        normalized_model_id = (self.model_id or '').strip()
        if self.mode == 'fixed' and not normalized_model_id:
            raise ValueError('mode=fixed 时 model_id 必填')
        self.model_id = normalized_model_id or None
        return self

    model_config = ConfigDict(protected_namespaces=())


# 密钥管理
class ProviderKeyCreateRequest(BaseModel):
    """创建渠道密钥"""
    label: str = Field(..., min_length=1, max_length=100, description="密钥标签")
    api_key: str = Field(..., min_length=1, max_length=500, description="API 密钥")
    key_type: str = Field('api_key', description="密钥类型: api_key / oauth / token")
    priority: int = Field(0, ge=-100, le=1000, description="优先级")

    model_config = ConfigDict(protected_namespaces=())


class ProviderKeyUpdateRequest(BaseModel):
    """更新渠道密钥（v0.1 schema）"""
    label: Optional[str] = Field(None, min_length=1, max_length=100, description="密钥标签")
    api_key: Optional[str] = Field(None, min_length=1, max_length=500, description="API 密钥")
    priority: Optional[int] = Field(None, ge=-100, le=1000, description="优先级")
    # v0.1：LLMProviderKey.is_active 字段已删（0022）；
    # 这里仅作为"启用/禁用密钥"前端开关：
    #   is_active=False → disabled_until=now+10y, disabled_reason='manual_disable'
    #   is_active=True  → disabled_until=None, disabled_reason=''
    is_active: Optional[bool] = Field(None, description="启用/禁用密钥（映射 disabled_until）")

    model_config = ConfigDict(protected_namespaces=())


# 管理员（Superuser）配置相关模式
_CAPABILITY_DOMAIN_LITERAL = Literal[
    'chat', 'embedding', 'vision', 'asr', 'tts',
    'image_gen', 'video_gen', 'audio_gen',
]


class AdminProviderCreateRequest(BaseModel):
    """管理员创建渠道配置"""
    name: str = Field(..., description="提供商名称")
    provider_key: Optional[str] = Field(None, description="渠道标识")
    display_name: str = Field(..., description="显示名称")
    base_url: str = Field(..., description="新模型默认 API Base URL")
    api_key: str = Field(..., description="API 密钥")
    # v0.1.x: 一个 Provider 可同时提供多个能力域（一个阿里云账号 → chat + embedding + vision ...）。
    # 至少 1 个 domain，每个 model 的 capability_domain 必须落在此集合内。
    capability_domains: List[_CAPABILITY_DOMAIN_LITERAL] = Field(
        ...,
        min_length=1,
        description="能力域集合（一个 Provider 可同时提供 chat/embedding/vision 等多种能力）",
    )
    scope: Literal['global', 'organization', 'user'] = Field('global', description="配置范围：global/organization/user")
    organization_id: Optional[str] = Field(None, description="组织ID（scope=organization 时必填）")
    user_id: Optional[str] = Field(None, description="用户ID（scope=user 时必填）")
    # v0.1：is_active 字段已删；下线 provider 直接 DELETE，
    # 启用/禁用语义由 routing_enabled 表达。
    routing_enabled: bool = Field(True, description="是否参与路由（v0.1 替代 is_active）")
    priority: int = Field(0, description="优先级")
    rate_limit: int = Field(60, description="每分钟请求限制")

    model_config = ConfigDict(protected_namespaces=())


class AdminProviderUpdateRequest(BaseModel):
    """管理员更新渠道配置（v0.1 schema）"""
    provider_key: Optional[str] = Field(None, description="渠道标识")
    display_name: Optional[str] = Field(None, description="显示名称")
    base_url: Optional[str] = Field(None, description="新模型默认 API Base URL")
    api_key: Optional[str] = Field(None, description="API 密钥")
    # 允许通过 PATCH 修改能力域集合（如新增/移除某个 domain 时同步 SceneBinding）
    capability_domains: Optional[List[_CAPABILITY_DOMAIN_LITERAL]] = Field(
        None,
        min_length=1,
        description="能力域集合（如填则全量替换）",
    )
    # v0.1：is_active → routing_enabled。
    routing_enabled: Optional[bool] = Field(None, description="是否参与路由（v0.1 替代 is_active）")
    priority: Optional[int] = Field(None, description="优先级")
    rate_limit: Optional[int] = Field(None, description="每分钟请求限制")

    model_config = ConfigDict(protected_namespaces=())


class AdminModelCreateRequest(BaseModel):
    """管理员创建模型配置"""
    provider_id: str = Field(..., description="提供商ID")
    model_name: str = Field(..., description="模型名称")
    display_name: str = Field(..., description="显示名称")
    description: Optional[str] = Field(None, description="模型描述")
    # 可显式覆盖；省略时继承 Provider.default_base_url。
    base_url: Optional[str] = Field(None, description="HTTP/WS 端点 URL")
    capability_domain: Optional[_CAPABILITY_DOMAIN_LITERAL] = Field(
        None,
        description=(
            "能力域（默认取 provider.capability_domains 首项）；"
            "若填写必须落在 provider.capability_domains 集合内"
        ),
    )
    context_window_tokens: int = Field(..., ge=1, description="上下文总容量(Token)")
    max_input_tokens: Optional[int] = Field(None, ge=1, description="最大输入Token数")
    max_output_tokens: Optional[int] = Field(None, ge=1, description="最大输出Token数")
    capabilities_config: Optional[Dict[str, Any]] = Field(None, description="能力配置（wire/tool/image/limits）")
    billing_type: str = Field('token', description="计费类型")
    input_price_per_1k: Decimal = Field(Decimal('0'), description="输入Token价格(每1K)")
    output_price_per_1k: Decimal = Field(Decimal('0'), description="输出Token价格(每1K)")
    price_per_request: Decimal = Field(Decimal('0'), description="每次请求价格")
    price_per_second: Decimal = Field(Decimal('0'), description="每秒价格")
    custom_billing_config: Optional[Dict[str, Any]] = Field(None, description="自定义计费配置")
    # v0.1：is_active 字段已删，下线模型直接 DELETE。

    model_config = ConfigDict(protected_namespaces=())


class AdminModelUpdateRequest(BaseModel):
    """管理员更新模型配置（v0.1.x Phase 2.5：可编辑 base_url）"""
    model_name: Optional[str] = Field(None, description="模型名称")
    display_name: Optional[str] = Field(None, description="显示名称")
    description: Optional[str] = Field(None, description="模型描述")
    # v0.1.x Phase 2.5：base_url 可编辑（不传则不动）
    base_url: Optional[str] = Field(None, description="HTTP/WS 端点 URL；不传则保持原值")
    capability_domain: Optional[_CAPABILITY_DOMAIN_LITERAL] = Field(
        None,
        description="能力域（若填写必须落在 provider.capability_domains 集合内）",
    )
    context_window_tokens: Optional[int] = Field(None, ge=1, description="上下文总容量(Token)")
    max_input_tokens: Optional[int] = Field(None, ge=1, description="最大输入Token数")
    max_output_tokens: Optional[int] = Field(None, ge=1, description="最大输出Token数")
    capabilities_config: Optional[Dict[str, Any]] = Field(None, description="能力配置（wire/tool/image/limits）")
    billing_type: Optional[str] = Field(None, description="计费类型")
    input_price_per_1k: Optional[Decimal] = Field(None, description="输入Token价格(每1K)")
    output_price_per_1k: Optional[Decimal] = Field(None, description="输出Token价格(每1K)")
    price_per_request: Optional[Decimal] = Field(None, description="每次请求价格")
    price_per_second: Optional[Decimal] = Field(None, description="每秒价格")
    custom_billing_config: Optional[Dict[str, Any]] = Field(None, description="自定义计费配置")
    # v0.1：is_active 字段已删，下线模型直接 DELETE。

    model_config = ConfigDict(protected_namespaces=())


class AdminProviderRuntimeUpdateRequest(BaseModel):
    """管理员更新渠道运行态配置"""
    routing_enabled: Optional[bool] = Field(None, description="是否参与路由")
    routing_weight: Optional[int] = Field(None, ge=1, le=1000, description="轮询权重")
    health_check_enabled: Optional[bool] = Field(None, description="启用健康检查")
    health_check_interval_sec: Optional[int] = Field(None, ge=10, le=3600, description="健康检查间隔(秒)")

    model_config = ConfigDict(protected_namespaces=())


class AdminUsageBudgetPolicyUpdateRequest(BaseModel):
    """管理员更新用量预算阈值策略"""
    organization_id: str = Field(..., description="组织ID")
    warning_threshold_percent: Optional[Decimal] = Field(None, ge=0, le=500, description="预警阈值(%)")
    critical_threshold_percent: Optional[Decimal] = Field(None, ge=0, le=500, description="严重阈值(%)")
    is_active: Optional[bool] = Field(None, description="是否启用")

    model_config = ConfigDict(protected_namespaces=())
