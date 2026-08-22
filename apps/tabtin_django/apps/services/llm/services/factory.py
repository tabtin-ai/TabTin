"""
LLM服务工厂

Service 类通过 ProviderRegistry 查找（延迟加载 + 缓存），
未注册的 Provider 降级到 OpenAIService（OpenAI 兼容协议）。
"""

from collections import defaultdict
from typing import Dict, Any, List, Optional
from django.conf import settings
from apps.services.agent_engine.configuration import OrchestrationConfiguration
from django.core.cache import cache
import logging

from .base import BaseLLMService
from .capability_guard import (
    apply_llm_provider_filter,
    get_llm_capable_provider_names,
    pick_first_llm_provider,
    provider_supports_llm_capability,
)
from .routing_pool import select_model_from_pool
from ..utils.capabilities import resolve_model_capabilities, resolve_model_limits

logger = logging.getLogger(__name__)


def _provider_supports_llm_capability(provider_name: Optional[str]) -> bool:
    """兼容旧调用方，委托到 capability_guard。"""
    return provider_supports_llm_capability(provider_name)


def _compute_tiers_user_selectable(tiers: List[Dict[str, Any]]) -> bool:
    """判断一组档位是否属于「用户可切换」语义（而非"纯按用量自动阶梯"）。

    两种档位在 tiered_pricing 里同居，本字段把它们区分开：

    - **自动阶梯计费**（legacy）：只为 Gemini/Qwen 等模型按输入长度自动切价，
      用户不感知、不选择，前端**不应**显示切档芯片。典型特征是：
      每档只有 max_input_tokens + 价格，没有 extra_headers / tags / is_default。

    - **用户可切档**（Context Tier，如 ZenMux Claude 1M Beta）：运营明确希望
      用户主动选择一个变体（通过 tags=['beta'] 或 extra_headers 注入
      anthropic-beta Header 等方式区分），前端**必须**显示芯片让用户选择。

    判断规则（三者任一满足即为"用户可切换"）：
      1. 存在非空 extra_headers（上游行为有差异）
      2. 存在非空 tags（运营明确打标签）
      3. 存在显式 is_default=True 的档（运营刻意配了默认/非默认区分）

    单档（len(tiers) <= 1）一律视为不可切换（没得选）。
    """
    if len(tiers) <= 1:
        return False
    for tier in tiers:
        if tier.get('extra_headers'):
            return True
        if tier.get('tags'):
            return True
        if tier.get('is_default') is True:
            return True
    return False


def _serialize_context_tiers_for_client(custom_billing_config: dict) -> List[Dict[str, Any]]:
    """从模型 custom_billing_config 提取上下文档位元数据，下发给客户端。

    返回前会脱敏：extra_headers 的具体 key/value 不下发，只返回布尔标记
    has_extra_headers，避免暴露上游 beta header 等敏感配置。

    每个 tier 上附加 is_user_selectable（整组同值），客户端据此决定是否
    显示切档 UI。详见 _compute_tiers_user_selectable 的规则说明。
    """
    try:
        from .billing import get_model_context_tiers
    except ImportError:
        return []

    tiers = get_model_context_tiers(custom_billing_config)
    is_user_selectable = _compute_tiers_user_selectable(tiers)
    serialized: List[Dict[str, Any]] = []
    for tier in tiers:
        extra_headers = tier.get('extra_headers') or {}
        max_input = tier.get('max_input_tokens')
        applies_above = tier.get('applies_above_tokens')
        item: Dict[str, Any] = {
            'id': tier.get('id'),
            'label': tier.get('label'),
            'is_default': bool(tier.get('is_default')),
            'max_input_tokens': int(max_input) if max_input is not None else None,
            'tags': list(tier.get('tags') or []),
            'has_extra_headers': bool(extra_headers),
            'is_user_selectable': is_user_selectable,
        }
        try:
            input_price = tier.get('input_price_per_1k')
            output_price = tier.get('output_price_per_1k')
            if input_price is not None:
                item['input_price_per_1k'] = float(input_price)
            if output_price is not None:
                item['output_price_per_1k'] = float(output_price)
        except (TypeError, ValueError):
            pass
        if applies_above is not None:
            try:
                item['applies_above_tokens'] = int(applies_above)
            except (TypeError, ValueError):
                pass
        try:
            over_input = tier.get('over_input_price_per_1k')
            over_output = tier.get('over_output_price_per_1k')
            if over_input is not None:
                item['over_input_price_per_1k'] = float(over_input)
            if over_output is not None:
                item['over_output_price_per_1k'] = float(over_output)
        except (TypeError, ValueError):
            pass
        serialized.append(item)
    return serialized


def _serialize_runtime_controls_for_client(
    capabilities_config: dict,
    resolved_caps: dict,
) -> List[Dict[str, Any]]:
    """下发模型运行时可调参数模板。

    产品语义：catalog 负责告诉客户端「这个模型有哪些可调旋钮」；客户端只
    渲染控件和记录选择，不按 provider 或 wire_adapter 猜参数。只有模型能力
    配置显式声明了 ``capabilities_config.runtime_controls`` 时才下发控件。
    """
    del resolved_caps
    configured = capabilities_config.get("runtime_controls")
    if isinstance(configured, list):
        controls: List[Dict[str, Any]] = []
        for item in configured:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key") or "").strip()
            kind = str(item.get("kind") or "select").strip()
            label = str(item.get("label") or key).strip()
            if not key or not label or kind != "select":
                continue
            control = {
                "key": key,
                "label": label,
                "kind": kind,
                "param_path": item.get("param_path") or key,
                "default_value": item.get("default_value"),
                "visibility": item.get("visibility") or "model_menu",
            }
            if item.get("description") is not None:
                control["description"] = item.get("description")
            options = item.get("options")
            if isinstance(options, list):
                control["options"] = [
                    {
                        "value": opt.get("value"),
                        "label": str(opt.get("label") or opt.get("value") or "默认"),
                        **(
                            {"description": opt.get("description")}
                            if opt.get("description") is not None else {}
                        ),
                    }
                    for opt in options
                    if isinstance(opt, dict)
                ]
            controls.append(control)
        if controls:
            return controls

    return []


def _build_global_runtime_profile_peers(
    models_by_provider: Dict[Any, List[Any]],
    provider_query,
) -> Dict[str, Dict[str, Any]]:
    """同 model_name 的全局 ready 模型 capabilities_config（供 BYOK 继承）。

    仅收录显式声明了 ``runtime_profile`` 的条目；无声明不进索引，避免
    把「无能力」误当成可继承声明。
    """
    peers: Dict[str, Dict[str, Any]] = {}
    for provider in provider_query:
        if getattr(provider, "scope", None) != "global":
            continue
        for model in models_by_provider.get(provider.pk, []):
            if (getattr(model, "wave_status", None) or "ready") != "ready":
                continue
            cfg = model.capabilities_config or {}
            if not isinstance(cfg, dict):
                continue
            declared = cfg.get("runtime_profile")
            if not isinstance(declared, dict) or not declared:
                continue
            name = getattr(model, "model_name", None)
            if not isinstance(name, str) or not name or name in peers:
                continue
            peers[name] = cfg
    return peers


def _serialize_runtime_profile_for_client(
    capabilities_config: dict,
    *,
    global_peer_capabilities_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Catalog ``runtime_profile``：canonical thinking modes，不含 provider 参数。"""
    from apps.services.llm.runtime_profile.catalog import (
        serialize_runtime_profile_for_client,
    )

    return serialize_runtime_profile_for_client(
        capabilities_config,
        global_peer_capabilities_config=global_peer_capabilities_config,
    )


def _pick_first_llm_provider(provider_queryset):
    """兼容旧调用方，委托到 capability_guard。"""
    return pick_first_llm_provider(provider_queryset)


class LLMServiceFactory:
    """LLM服务工厂类"""

    @classmethod
    def _resolve_service_class(cls, provider_name: str) -> type:
        """从 ProviderRegistry 获取 Service 类，未注册时降级到 OpenAIService。"""
        if not _provider_supports_llm_capability(provider_name):
            raise ValueError(f"Provider '{provider_name}' 不支持 LLM 能力")
        from apps.services.llm.registry import ProviderRegistry
        return ProviderRegistry.get_service_class(provider_name)

    @classmethod
    def create_service(cls, provider_name: str, provider_config: Dict[str, Any]) -> BaseLLMService:
        """
        创建LLM服务实例

        Args:
            provider_name: 提供商名称
            provider_config: 提供商配置

        Returns:
            BaseLLMService: LLM服务实例

        Raises:
            ValueError: 不支持的提供商或配置无效
        """
        service_class = cls._resolve_service_class(provider_name)

        try:
            cls._validate_provider_config(provider_name, provider_config)
            service = service_class(provider_config)
            logger.info("成功创建 %s 服务实例", provider_name)
            return service

        except Exception as e:
            logger.error("创建 %s 服务失败: %s", provider_name, e)
            raise ValueError(f"创建 {provider_name} 服务失败: {str(e)}")

    @classmethod
    def _validate_provider_config(cls, provider_name: str, config: Dict[str, Any]) -> None:
        """
        验证提供商配置

        通用字段检查在此完成，provider 特有验证委托给 Service 类。

        Args:
            provider_name: 提供商名称
            config: 配置信息

        Raises:
            ValueError: 配置无效时
        """
        from apps.services.llm.registry import ProviderRegistry

        meta = ProviderRegistry.get(provider_name)
        api_key_required = meta.api_key_required if meta else True

        if not config.get('base_url'):
            raise ValueError(f"{provider_name} 配置缺少必需字段: base_url")

        if api_key_required and not config.get('api_key'):
            raise ValueError(f"{provider_name} 配置缺少必需字段: api_key")

        if not api_key_required and not config.get('api_key'):
            config['api_key'] = 'not-needed'

        service_class = cls._resolve_service_class(provider_name)
        service_class.validate_provider_config(provider_name, config)

    @classmethod
    def get_supported_providers(cls) -> List[str]:
        """获取支持的 LLM 提供商列表（DB 优先，空时回退 Registry）。"""
        db_names = get_llm_capable_provider_names()
        if db_names:
            return sorted(db_names)
        try:
            from apps.services.llm.registry import ProviderRegistry
            return sorted(
                name for name, meta in ProviderRegistry._providers.items()
                if "llm" in meta.capability_domains
            )
        except Exception:
            return []

    @classmethod
    def is_provider_supported(cls, provider_name: str) -> bool:
        """检查是否支持指定提供商。"""
        from apps.services.llm.registry import ProviderRegistry
        return (
            ProviderRegistry.is_registered(provider_name)
            and _provider_supports_llm_capability(provider_name)
        )


def get_llm_service(provider_name: Optional[str] = None,
                   user_id: Optional[str] = None,
                   model_name: Optional[str] = None,
                   model_id: Optional[str] = None,
                   organization_id: Optional[str] = None) -> BaseLLMService:
    """
    获取LLM服务实例

    Args:
        provider_name: 指定提供商名称，为空时使用默认配置
        user_id: 用户ID，用于获取用户专属配置
        model_name: 模型名称（已弃用，请使用model_id）
        model_id: 模型UUID，优先使用此参数

    Returns:
        BaseLLMService: LLM服务实例

    Raises:
        ValueError: 配置无效或服务创建失败
    """
    try:
        # 获取提供商配置
        config = _get_provider_config(provider_name, user_id, model_name, model_id, organization_id)

        # 创建服务实例
        return LLMServiceFactory.create_service(config['name'], config)

    except Exception as e:
        logger.error("获取LLM服务失败: %s", e)
        raise


def get_available_models(user_id: Optional[str] = None,
                        organization_id: Optional[str] = None,
                        include_inactive: bool = False,
                        include_declared: bool = False) -> List[Dict[str, Any]]:
    """
    获取可用的模型列表

    Args:
        user_id: 用户ID

    Returns:
        List[Dict]: 模型列表
    """
    cache_key = _build_models_cache_key(
        organization_id,
        user_id,
        include_inactive,
        include_declared,
    )
    cached_models = cache.get(cache_key)

    if cached_models:
        return cached_models

    models = []

    try:
        # 从数据库获取模型配置
        from django.db import models as django_models
        from ..models import LLMModel, LLMProvider

        # 构建查询条件
        provider_query = LLMProvider.objects.all() if include_inactive else LLMProvider.objects.filter(routing_enabled=True)
        provider_query = apply_llm_provider_filter(provider_query)
        # scope=user 是个人维度：跟随 user_id 跨组织可见。
        # 存量行可能仍带 organization_id，列表/选模不得再按创建组织过滤。
        if organization_id:
            if user_id:
                provider_query = provider_query.filter(
                    django_models.Q(scope='global') |
                    django_models.Q(scope='organization', organization_id=organization_id) |
                    django_models.Q(scope='user', user_id=user_id)
                )
            else:
                provider_query = provider_query.filter(
                    django_models.Q(scope='global') |
                    django_models.Q(scope='organization', organization_id=organization_id)
                )
        else:
            if user_id:
                provider_query = provider_query.filter(
                    django_models.Q(scope='global') |
                    django_models.Q(scope='user', user_id=user_id)
                )
            else:
                provider_query = provider_query.filter(scope='global')

        # Catalog 组序由 Provider 遍历顺序决定；前端再按 provider 名字分组。
        # 同 priority 时必须 global → organization → user，否则新建 BYOK/自定义
        # 渠道会因 created_at 最新把同名平台组整段顶到系统渠道前面。
        provider_query = provider_query.order_by(
            '-priority',
            django_models.Case(
                django_models.When(scope='global', then=django_models.Value(0)),
                django_models.When(scope='organization', then=django_models.Value(1)),
                django_models.When(scope='user', then=django_models.Value(2)),
                default=django_models.Value(3),
                output_field=django_models.IntegerField(),
            ),
            '-created_at',
        )

        # 一次性查询所有相关模型（消除 N+1）
        all_models_qs = LLMModel.objects.filter(provider__in=provider_query).select_related('provider')
        if not include_inactive:
            all_models_qs = all_models_qs.filter(
                provider__routing_enabled=True,
                wave_status='ready',
            )

        models_by_provider = defaultdict(list)
        for m in all_models_qs:
            models_by_provider[m.provider_id].append(m)

        # BYOK / org 模型：同名全局 ready 的 runtime_profile 声明可继承（D5）
        global_runtime_peers = _build_global_runtime_profile_peers(
            models_by_provider,
            provider_query,
        )

        for provider in provider_query:
            for model in models_by_provider.get(provider.pk, []):
                context_window_tokens = model.context_window_tokens
                # v0.1 schema：supports_* / multimodal_limits / max_image_* /
                # supported_image_formats 等硬开关字段已删（migration 0022），
                # 全部进 capabilities_config，由 resolve_model_capabilities 统一兜底。
                # 保留旧字段名以兼容前端 ChatClient / OrganizationModelSettings 等消费方。
                capabilities_config = model.capabilities_config or {}
                resolved_caps = resolve_model_capabilities(model)
                resolved_limits = resolve_model_limits(model)
                multimodal_limits = capabilities_config.get('multimodal_limits') or {}
                peer_cfg = None
                if getattr(provider, "scope", None) != "global":
                    peer_cfg = global_runtime_peers.get(model.model_name)
                model_info = {
                    'id': str(model.id),
                    'name': model.model_name,
                    'model_name': model.model_name,
                    'display_name': model.display_name,
                    'provider': provider.name,
                    'provider_display_name': provider.display_name,
                    'provider_id': str(provider.id),
                    'provider_key': provider.provider_key,
                    'provider_scope': provider.scope,
                    'provider_routing_enabled': provider.routing_enabled,
                    'description': model.description,
                    'base_url': model.base_url,
                    # v0.1：mode 字段已删，capability_domain 是新的真值来源；
                    # 这里把它当作前端旧 mode 字段的兼容输出（chat / vision / ...）。
                    'mode': model.capability_domain,
                    'capability_domain': model.capability_domain,
                    'max_tokens': context_window_tokens,
                    'context_window_tokens': context_window_tokens,
                    'max_input_tokens': model.max_input_tokens_resolved,
                    'max_output_tokens': model.max_output_tokens_resolved,
                    'supports_streaming': resolved_caps.get('supports_streaming', False),
                    'supports_function_calling': resolved_caps.get('supports_function_calling', False),
                    'supports_vision': resolved_caps.get('supports_vision', False),
                    'supports_video_input': resolved_caps.get('supports_video_input', False),
                    # ：对话附件原生 file_url 直传门控（与 supports_video_input 对称）
                    'supports_document_input': resolved_caps.get('supports_document_input', False),
                    'max_image_size': capabilities_config.get('max_image_size'),
                    'max_images_per_request': capabilities_config.get('max_images_per_request'),
                    'supported_image_formats': capabilities_config.get('supported_image_formats') or [],
                    'capabilities_config': capabilities_config,
                    'multimodal_limits': multimodal_limits,
                    'resolved_capabilities': resolved_caps,
                    'resolved_limits': resolved_limits,
                    'wave_status': model.wave_status,
                    'billing_type': model.billing_type,
                    'input_price_per_1k': float(model.input_price_per_1k),
                    'output_price_per_1k': float(model.output_price_per_1k),
                    'price_per_request': float(model.price_per_request),
                    'price_per_second': float(model.price_per_second),
                    'cost_per_1k_tokens': float(model.cost_per_1k_tokens),
                    'has_tiered_pricing': bool(
                        (model.custom_billing_config or {}).get('tiered_pricing', {}).get('tiers')
                    ),
                    'tiered_pricing': (model.custom_billing_config or {}).get('tiered_pricing'),
                    # 上下文档位（如 ZenMux 1M 长上下文）— 与 tiered_pricing.tiers
                    # 共用底层数据，但前端只关心呈现给用户的元信息：id / label /
                    # is_default / max_input_tokens / tags / 是否带 extra_headers
                    # （extra_headers 内容本身敏感，不下发到客户端）。
                    'context_tiers': _serialize_context_tiers_for_client(
                        model.custom_billing_config or {}
                    ),
                    'runtime_controls': _serialize_runtime_controls_for_client(
                        capabilities_config,
                        resolved_caps,
                    ),
                    # W2e：canonical Runtime Profile capability；与 runtime_controls 并存
                    'runtime_profile': _serialize_runtime_profile_for_client(
                        capabilities_config,
                        global_peer_capabilities_config=peer_cfg,
                    ),
                    'is_user_config': provider.scope == 'user',
                    # ：与 provider_routing_enabled 对齐；include_inactive 时不得硬编码 True。
                    'routing_enabled': bool(provider.routing_enabled),
                }
                models.append(model_info)

        # Provider 静态声明模型只适合“可配置模型目录”展示；聊天运行时只能选择
        # DB 中真实可路由的 LLMModel，否则 session.current_model_id 无法落 UUID。
        if include_declared:
            _merge_provider_declared_models(models)

        # 缓存结果（5分钟）
        cache.set(cache_key, models, 300)

    except Exception as e:
        logger.error("获取可用模型失败: %s", e)
        raise

    return models


def _merge_provider_declared_models(models: List[Dict[str, Any]]) -> None:
    """将 Provider 静态声明的模型追加到列表中（DB 已有的跳过）。

    就地修改 models 列表，不返回新列表。
    """
    from apps.services.llm.registry import ProviderRegistry
    from apps.services.llm.providers.model_metadata import (
        merge_authoritative_model_capabilities,
    )

    db_model_keys = {(m.get('provider'), m.get('model_name')) for m in models}

    for name, meta in ProviderRegistry._providers.items():
        if "llm" not in meta.capability_domains:
            continue
        if not meta.static_models:
            continue
        for decl in meta.static_models:
            if (name, decl.model_name) in db_model_keys:
                continue
            # v0.1：catalog 同时输出 'mode' 与 'capability_domain'，让前端按 capability_domain
            # 过滤的新代码与读 'mode' 的旧代码都能命中。declared model 的 ``decl.mode``
            # 仍取 chat/completion 等旧值，capability_domain 直接归一到 'chat'。
            decl_mode = (decl.mode or 'chat').lower()
            if decl_mode in {"chat", "completion"}:
                decl_domain = "chat"
            else:
                decl_domain = decl_mode
            declared_capabilities = merge_authoritative_model_capabilities(
                provider_name=name,
                provider_scope="global",
                model_name=decl.model_name,
                capabilities_config={},
            )
            declared_resolved_capabilities = {
                "supports_streaming": decl.supports_streaming,
                "supports_function_calling": decl.supports_function_calling,
                "supports_vision": decl.supports_vision,
                "supports_video_input": decl.supports_video_input,
                "supports_document_input": decl.supports_document_input,
            }
            if decl.supports_json_mode is not None:
                declared_resolved_capabilities["supports_json_mode"] = (
                    decl.supports_json_mode
                )
            models.append({
                'id': f"declared:{name}:{decl.model_name}",
                'name': decl.model_name,
                'model_name': decl.model_name,
                'display_name': decl.display_name or decl.model_name,
                'provider': name,
                'provider_display_name': meta.display_name,
                'provider_id': None,
                'provider_key': None,
                'provider_scope': None,
                'provider_routing_enabled': True,
                'description': '',
                'mode': decl.mode,
                'capability_domain': decl_domain,
                'max_tokens': decl.context_window_tokens,
                'context_window_tokens': decl.context_window_tokens,
                'max_input_tokens': None,
                'max_output_tokens': decl.max_output_tokens,
                'supports_streaming': decl.supports_streaming,
                'supports_function_calling': decl.supports_function_calling,
                'supports_vision': decl.supports_vision,
                'supports_video_input': decl.supports_video_input,
                'supports_document_input': decl.supports_document_input,
                **(
                    {'supports_json_mode': decl.supports_json_mode}
                    if decl.supports_json_mode is not None
                    else {}
                ),
                'max_image_size': None,
                'max_images_per_request': 0,
                'supported_image_formats': [],
                'capabilities_config': declared_capabilities,
                'multimodal_limits': {},
                'resolved_capabilities': declared_resolved_capabilities,
                'resolved_limits': {},
                'billing_type': 'token',
                'input_price_per_1k': decl.input_price_per_1k,
                'output_price_per_1k': decl.output_price_per_1k,
                'price_per_request': 0.0,
                'price_per_second': 0.0,
                'cost_per_1k_tokens': (decl.input_price_per_1k + decl.output_price_per_1k) / 2,
                'has_tiered_pricing': False,
                'tiered_pricing': None,
                'is_user_config': False,
                'routing_enabled': True,
                'source': 'provider_declared',
            })


def _build_models_cache_key(
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    include_inactive: bool = False,
    include_declared: bool = False,
) -> str:
    """
    构建含版本号的缓存 key。

    版本号存储在 ``llm_models_ver_{organization_key}`` 中，
    invalidate_models_cache 通过递增版本号使所有旧 key 自然失效，
    **无需依赖 Redis 的 delete_pattern**。

    全局版本号（``llm_models_ver_global``）始终嵌入所有 key，
    确保全局 Provider/Model 变更能立即使所有 organization 缓存失效。
    """
    global_ver = cache.get("llm_models_ver_global") or 0
    organization_key = organization_id or 'global'
    ws_ver = 0
    if organization_id:
        ws_ver = cache.get(f"llm_models_ver_{organization_key}") or 0
    declared_key = 'with_declared' if include_declared else 'db_only'
    key = f"llm_models_gv{global_ver}_v{ws_ver}_{organization_key}_{user_id or 'global'}_{declared_key}"
    if include_inactive:
        key = f"{key}_all"
    return key


def invalidate_models_cache(organization_id: Optional[str] = None,
                           user_id: Optional[str] = None) -> None:
    """
    使模型缓存失效。

    通过递增版本号实现：新的 get_available_models 查询将命中新 key，
    旧 key 在 TTL 到期后被缓存后端自动回收。
    兼容任何 Django cache backend（LocMem / Memcached / Redis 等）。
    """
    try:
        organization_key = organization_id or 'global'
        ver_keys = {f"llm_models_ver_{organization_key}"}
        # 如果是特定 organization，同时使全局版本失效（全局列表可能包含该 ws 数据）
        if organization_id:
            ver_keys.add("llm_models_ver_global")

        for ver_key in ver_keys:
            try:
                cache.incr(ver_key)
            except ValueError:
                # key 不存在或非整型，重新初始化
                cache.set(ver_key, 1, None)
    except Exception as exc:
        logger.warning("模型缓存清理失败: %s", exc)


def filter_models_by_member_tier(
    models: List[Dict[str, Any]],
    organization_id: str,
    user_id: str,
) -> List[Dict[str, Any]]:
    """根据成员预算策略的 max_model_tier 过滤模型列表。

    无策略 / 策略为 enterprise / 豁免角色时不做过滤。
    失败时 fallback 到不过滤，避免阻断主流程。
    """
    try:
        from apps.services.billing.services.member_budget_service import MemberBudgetService

        user_role = MemberBudgetService.resolve_user_role(organization_id, user_id)
        policy = MemberBudgetService.get_effective_policy(
            organization_id, user_id, user_role=user_role,
        )
        if not policy or policy.max_model_tier == "enterprise":
            return models

        _TIER = MemberBudgetService.MODEL_TIER_ORDER
        allowed_tier_val = _TIER.get(policy.max_model_tier, 3)
        return [
            m for m in models
            if _TIER.get(
                MemberBudgetService.compute_model_cost_tier(
                    m.get("cost_per_1k_tokens", 0)
                ), 1,
            ) <= allowed_tier_val
        ]
    except Exception as exc:
        logger.warning("模型列表成员策略过滤失败，回退到不过滤: %s", exc)
        return models


def validate_provider_config(provider_name: str,
                            user_id: Optional[str] = None,
                            organization_id: Optional[str] = None,
                            provider_key: Optional[str] = None) -> Dict[str, Any]:
    """
    验证提供商配置

    Args:
        provider_name: 提供商名称
        user_id: 用户ID

    Returns:
        Dict: 验证结果
    """
    try:
        # 获取配置
        config = _get_provider_config(
            provider_name,
            user_id,
            organization_id=organization_id,
            provider_key=provider_key
        )

        # 创建服务实例并验证
        service = LLMServiceFactory.create_service(config['name'], config)
        result = service.validate_config()

        logger.info("提供商 %s 配置验证完成: %s", provider_name, result['valid'])
        return result

    except Exception as e:
        logger.error("提供商 %s 配置验证失败: %s", provider_name, e)
        return {
            "valid": False,
            "error": str(e)
        }


def _get_provider_config(provider_name: Optional[str] = None,
                        user_id: Optional[str] = None,
                        model_name: Optional[str] = None,
                        model_id: Optional[str] = None,
                        organization_id: Optional[str] = None,
                        provider_key: Optional[str] = None) -> Dict[str, Any]:
    """
    获取提供商配置

    Args:
        provider_name: 提供商名称
        user_id: 用户ID
        model_name: 模型名称（已弃用）
        model_id: 模型UUID，优先使用

    Returns:
        Dict: 提供商配置
    """
    from ..models import LLMProvider, LLMModel

    model = None  # 显式初始化，避免后续使用 'model' in locals()
    explicit_non_llm_provider = bool(provider_name) and not _provider_supports_llm_capability(provider_name)

    try:
        if explicit_non_llm_provider:
            raise ValueError(f"Provider '{provider_name}' 不支持 LLM 能力")

        # 优先使用 model_id，其次使用 model_name
        if model_id:
            model = LLMModel.objects.select_related('provider').get(
                id=model_id,
                provider__routing_enabled=True
            )
            provider = model.provider
            if not _provider_supports_llm_capability(provider.name):
                raise ValueError(f"Provider '{provider.name}' 不支持 LLM 能力")
            # E13-1: UNHEALTHY 且在冷却期内的 Provider 直接拒绝，避免注定超时的请求
            from .runtime import RUNTIME_STATUS_UNHEALTHY, RUNTIME_STATUS_DEGRADED, RUNTIME_STATUS_HEALTHY
            if provider.runtime_status == RUNTIME_STATUS_UNHEALTHY:
                from django.utils import timezone as _tz
                cooldown_until = provider.runtime_cooldown_until
                if cooldown_until is None or _tz.now() < cooldown_until:
                    raise ValueError(
                        f"Provider '{provider.display_name}' 处于熔断冷却期 "
                        f"(runtime_status={provider.runtime_status})"
                    )

            # R5: degraded 状态下尝试通过路由池寻找更健康的替代
            if provider.runtime_status == RUNTIME_STATUS_DEGRADED:
                from .capability_guard import CHAT_MODEL_MODES as _CHAT_MODES
                alternative = select_model_from_pool(
                    model_name=model.model_name,
                    organization_id=organization_id,
                    user_id=user_id,
                    allowed_modes=_CHAT_MODES,
                )
                if alternative and alternative.provider.runtime_status == RUNTIME_STATUS_HEALTHY:
                    logger.info(
                        "model_id=%s 的 Provider 处于 degraded，切换到 healthy 替代: model_id=%s provider=%s",
                        model_id, alternative.id, alternative.provider.display_name,
                    )
                    model = alternative
                    provider = alternative.provider
        elif model_name:
            from .capability_guard import CHAT_MODEL_MODES as _CHAT_MODES
            model = select_model_from_pool(
                model_name=model_name,
                organization_id=organization_id,
                user_id=user_id,
                provider_name=provider_name,
                provider_key=provider_key,
                require_active=True,
                allowed_modes=_CHAT_MODES,
            )
            if not model:
                raise LLMModel.DoesNotExist(f"model_name={model_name} not found")
            provider = model.provider
        else:
            # 构建提供商查询
            provider_query = apply_llm_provider_filter(
                LLMProvider.objects.filter(routing_enabled=True),
            )

            if provider_name:
                provider_query = provider_query.filter(name=provider_name)
            if provider_key:
                provider_query = provider_query.filter(provider_key=provider_key)

            provider = None
            if organization_id:
                if user_id:
                    # 个人渠道跨组织跟随 user_id
                    user_provider = _pick_first_llm_provider(provider_query.filter(
                        scope='user',
                        user_id=user_id,
                    ))
                    if user_provider:
                        provider = user_provider
                if not provider:
                    provider = _pick_first_llm_provider(provider_query.filter(
                        scope='organization',
                        organization_id=organization_id
                    ))
                if not provider:
                    provider = _pick_first_llm_provider(provider_query.filter(scope='global'))
            else:
                if user_id:
                    provider = _pick_first_llm_provider(provider_query.filter(
                        scope='user',
                        user_id=user_id,
                    ))
                if not provider:
                    provider = _pick_first_llm_provider(provider_query.filter(scope='global'))

            if provider:
                from .capability_guard import CHAT_MODEL_MODES as _CHAT_MODES
                model = LLMModel.objects.filter(
                    provider=provider,
                    capability_domain='chat',
                ).order_by('-created_at').first()

        if not provider:
            # 回退到环境变量配置
            return _get_fallback_config(provider_name)

        # 多 Key 选择：优先使用 ProviderKey 表中的 Key，否则回退 Provider.api_key
        resolved_api_key = provider.api_key
        resolved_key_obj = None
        try:
            from .key_manager import select_provider_key
            selected_key = select_provider_key(str(provider.id))
            if selected_key:
                resolved_api_key = selected_key.api_key
                resolved_key_obj = selected_key
        except Exception as e:
            logger.debug("ProviderKey 选择失败，回退到 Provider.api_key: %s", e)

        # 构建配置
        orchestration_config = OrchestrationConfiguration.from_settings()
        # v0.1：model.supports_function_calling 字段已删，统一从 capabilities_config 解析。
        resolved_caps = resolve_model_capabilities(model) if model else {}
        # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）。
        # 没有 model 的兜底场景（_get_default_model_for_provider 路径）会用 LiteLLM 默认 endpoint。
        config = {
            'name': provider.name,
            'api_key': resolved_api_key,
            'base_url': model.base_url if model else '',
            'model_name': model.model_name if model else _get_default_model_for_provider(provider.name),
            'max_retries': 3,
            'retry_delay': 1,
            'context_window_tokens': model.context_window_tokens if model else None,
            'max_input_tokens': model.max_input_tokens_resolved if model else None,
            'max_output_tokens': model.max_output_tokens_resolved if model else None,
            'structured_output_retries': orchestration_config.structured_output_retries,
            'supports_function_calling': resolved_caps.get('supports_function_calling') if model else None,
            'input_price_per_1k': float(model.input_price_per_1k) if model else 0,
            'output_price_per_1k': float(model.output_price_per_1k) if model else 0,
            'custom_billing_config': (model.custom_billing_config or {}) if model else {},
            'provider_obj': provider,
            'model_obj': model,
            'provider_key_obj': resolved_key_obj,
        }

        return config

    except LLMModel.DoesNotExist as e:
        if model_id:
            logger.error("指定 model_id 不存在或不可用: %s", model_id)
            raise ValueError(f"指定 model_id 不存在或不可用: {model_id}") from e
        if model_name:
            logger.error("指定 model_name 不存在或不可用: %s", model_name)
            raise ValueError(f"指定 model_name 不存在或不可用: {model_name}") from e
        logger.warning("从数据库获取模型失败，使用环境变量: %s", e)
        return _get_fallback_config(provider_name)
    except Exception as e:
        if model_id or model_name:
            logger.error("按指定模型获取配置失败: %s", e)
            raise
        if explicit_non_llm_provider:
            logger.error("指定 provider 不支持 LLM 能力: %s", provider_name)
            raise ValueError(f"Provider '{provider_name}' 不支持 LLM 能力") from e
        logger.warning("从数据库获取配置失败，使用环境变量: %s", e)
        return _get_fallback_config(provider_name)


def _resolve_settings_chain(setting_names: tuple, default=""):
    """按优先级尝试多个 Django settings 属性名，返回第一个非空值或 default。"""
    for name in setting_names:
        val = getattr(settings, name, None)
        if val is not None and val != "":
            return val
    return default


def _resolve_prefix_setting(prefixes: tuple, suffix: str, default=None):
    """对每个 prefix 尝试 getattr(settings, f'{prefix}_{suffix}')，返回第一个非 None 值。"""
    for prefix in prefixes:
        val = getattr(settings, f"{prefix}_{suffix}", None)
        if val is not None:
            return val
    return default


def _get_fallback_config(provider_name: Optional[str] = None) -> Dict[str, Any]:
    """
    获取回退配置（从 Django settings / 环境变量）。

    通过 ProviderRegistry 中各 Provider 声明的 fallback_* 字段动态解析，
    无需 per-provider if-elif。
    """
    from apps.services.llm.registry import ProviderRegistry

    if not provider_name:
        # v0.1 合规修订：原 `getattr(settings, 'LLM_DEFAULT_PROVIDER', 'openai')`
        # 违反宪法 §A.3 业务感命名 env。此 fallback 路径仅在 DB 故障 + provider_name
        # 为空双重条件下触发（极罕见兜底），硬编码 'openai' 已足够；调用方需要切其他
        # provider 时显式传 provider_name 参数，不再依赖 env override。
        provider_name = 'openai'

    if not _provider_supports_llm_capability(provider_name):
        logger.warning(
            "Provider '%s' 不支持 LLM 能力，fallback 降级到 openai",
            provider_name,
        )
        provider_name = 'openai'

    meta = ProviderRegistry.get(provider_name)

    if meta and meta.fallback_api_key_envs:
        api_key = _resolve_settings_chain(meta.fallback_api_key_envs, "")
        base_url = _resolve_settings_chain(meta.fallback_base_url_envs, meta.default_base_url)
        model_name = _resolve_settings_chain(meta.fallback_model_envs, meta.default_model_name or "default")

        orchestration_config = OrchestrationConfiguration.from_settings()
        return {
            'name': meta.name,
            'api_key': api_key,
            'base_url': base_url,
            'model_name': model_name,
            'max_retries': 3,
            'retry_delay': 1,
            'context_window_tokens': _resolve_prefix_setting(
                meta.fallback_settings_prefixes, 'CONTEXT_WINDOW_TOKENS',
            ),
            'max_input_tokens': _resolve_prefix_setting(
                meta.fallback_settings_prefixes, 'MAX_INPUT_TOKENS',
            ),
            'max_output_tokens': _resolve_prefix_setting(
                meta.fallback_settings_prefixes, 'MAX_OUTPUT_TOKENS',
            ),
            'structured_output_retries': orchestration_config.structured_output_retries,
            'supports_function_calling': None,
        }

    if provider_name != 'openai':
        logger.warning(
            "未知提供商 '%s' 无 fallback 配置，降级到默认 openai 配置",
            provider_name,
        )
        return _get_fallback_config('openai')

    # openai 也未注册 fallback — 最终硬编码兜底（安全网）
    orchestration_config = OrchestrationConfiguration.from_settings()
    return {
        'name': 'openai',
        'api_key': getattr(settings, 'OPENAI_API_KEY', ''),
        'base_url': getattr(settings, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        'model_name': getattr(settings, 'OPENAI_MODEL', getattr(settings, 'OPENAI_DEFAULT_MODEL', 'gpt-4o')),
        'max_retries': 3,
        'retry_delay': 1,
        'context_window_tokens': getattr(settings, 'OPENAI_CONTEXT_WINDOW_TOKENS', None),
        'max_input_tokens': getattr(settings, 'OPENAI_MAX_INPUT_TOKENS', None),
        'max_output_tokens': getattr(settings, 'OPENAI_MAX_OUTPUT_TOKENS', None),
        'structured_output_retries': orchestration_config.structured_output_retries,
        'supports_function_calling': None,
    }


def _build_scene_cache_key(scene_key: str) -> str:
    """构建含版本号的 SceneBinding 缓存 key，支持即时失效。"""
    ver = cache.get("llm_scene_ver") or 0
    return f"llm:scene:v{ver}:{scene_key}"


def invalidate_scene_cache() -> None:
    """
    使所有 SceneBinding 缓存立即失效（版本号递增）。

    管理员修改 SceneBinding、Provider 进入/脱离 UNHEALTHY 时均应调用。
    兼容任何 Django cache backend。
    """
    try:
        cache.incr("llm_scene_ver")
    except ValueError:
        cache.set("llm_scene_ver", 1, None)


def _get_default_model_for_provider(provider_name: str) -> str:
    """从 ProviderRegistry 获取提供商的默认模型（优先读 settings 覆盖）。"""
    from apps.services.llm.registry import ProviderRegistry

    meta = ProviderRegistry.get(provider_name)
    if meta:
        return _resolve_settings_chain(meta.fallback_model_envs, meta.default_model_name or "default")
    return "default"
