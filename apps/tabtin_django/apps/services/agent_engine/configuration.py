"""
Multiagent 配置中心。

from_settings() 使用模块级缓存，避免热路径上反复解析 Django settings。
缓存 TTL 30 秒，进程内自动刷新；测试中可调用 invalidate_config_cache() 强制失效。

**命名迁移（W11 → W13）**：所有 settings 属性对外契约已从 ``ORCHESTRATION_*``
统一为 ``AGENT_ENGINE_*``。过渡期通过 :mod:`apps.services.agent_engine.legacy_env`
的 ``agent_engine_setting`` / ``agent_engine_env`` 实现双名兼容：新名优先，
legacy ``ORCHESTRATION_*`` 兜底，命中时打出一次性 ``DeprecationWarning``。
"""

from typing import Optional, Dict, List, Any
import json
import logging
import threading
import time as _time
from pydantic import BaseModel, Field, ConfigDict
from django.conf import settings

from apps.services.agent_engine.legacy_env import (
    MISSING,
    agent_engine_setting,
)

logger = logging.getLogger(__name__)

_config_cache: Optional["OrchestrationConfiguration"] = None
_config_cache_ts: float = 0.0
_config_cache_lock = threading.Lock()
_CONFIG_CACHE_TTL = 30.0

SUBAGENT_SPAWN_TOOL_NAMES: frozenset = frozenset({
    "spawn_subagent",
    "spawn_parallel_subagents",
    "task",
    "resume_subagent",
})


def invalidate_config_cache() -> None:
    """强制失效配置缓存（供测试 / 动态配置变更使用）。"""
    global _config_cache, _config_cache_ts
    _config_cache = None
    _config_cache_ts = 0.0


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _parse_json_setting(
    attr_name: str,
    default: Any,
    expected_type: type = dict,
) -> Any:
    """从 Django settings 读取可能为 JSON 字符串的配置项（支持 legacy 回退）。

    - ``attr_name`` 期望为新名（AGENT_ENGINE_*）
    - 缺失时回退至 ORCHESTRATION_* legacy 名（由 ``agent_engine_setting`` 处理）
    - 支持 str -> json.loads 自动解析；类型不匹配时回退到 default
    """
    raw = agent_engine_setting(attr_name, MISSING)
    if raw is MISSING or raw is None:
        return default
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.debug("[config] %s JSON parsing failed, using default", attr_name)
            return default
    if not isinstance(raw, expected_type):
        return default
    return raw


def _sanitize_str_dict(raw: dict) -> Dict[str, str]:
    """将 dict 的 key/value 统一为 stripped str，过滤空值。"""
    return {
        str(k).strip(): str(v).strip()
        for k, v in raw.items()
        if str(k).strip() and str(v).strip()
    }


def _sanitize_str_list(raw: list) -> List[str]:
    """将 list 元素统一为 stripped str，过滤空值。"""
    return [str(name).strip() for name in raw if str(name).strip()]


class OrchestrationConfiguration(BaseModel):
    """
    Multiagent 配置（统一入口）。

    W11 精简后只保留有活跃消费方的字段：
    - LLM / 结构化输出
    - 子 Agent 配置（模型选择、思维级别、工具黑白名单、并发控制）
    - LiteLLM provider 别名
    - Prompt cache（key_scope / retention）
    - 工具结果存储
    - AI 分类器缓存
    - 内部模型 ID / 记忆系统
    - 消息去重 Debounce
    - 持久化清理
    """

    model_config = ConfigDict(
        protected_namespaces=()
    )

    # --- LLM / 结构化输出 ---

    structured_output_retries: int = Field(
        default=3,
        description="Structured Output 最大重试次数"
    )
    default_model_id: Optional[str] = Field(
        default=None,
        description="默认模型 UUID（可选）"
    )

    # --- 子 Agent 配置 ---

    subagent_default_model_id: Optional[str] = Field(
        default=None,
        description="子 Agent 默认模型 UUID（可选，全局兜底）"
    )
    # 注：subagent_standard_model_id / subagent_advanced_model_id 两个死字段已于
    # 子 Agent 计费治本 Phase 0（2026-05）删除——它们指向 registry 不存在的
    # scene_key（_sub_agent_standard / _sub_agent_advanced），且云端 task 工具
    # model='standard'/'advanced' 路径随 W10 子 Agent 下沉客户端而废弃。对应的
    # DB 列（ChatGlobalConfig）早已随 migration 0032 DeleteModel 整表删除。
    subagent_model_by_agent: Dict[str, str] = Field(
        default_factory=dict,
        description="子 Agent 模型覆盖（按 agent_name）",
    )
    subagent_model_by_app: Dict[str, str] = Field(
        default_factory=dict,
        description="子 Agent 模型覆盖（按 app_id）",
    )
    subagent_default_thinking_level: Optional[str] = Field(
        default=None,
        description="子 Agent 默认思维级别（off/low/medium/high）",
    )
    subagent_thinking_by_agent: Dict[str, str] = Field(
        default_factory=dict,
        description="子 Agent 思维级别覆盖（按 agent_name）",
    )
    subagent_thinking_by_app: Dict[str, str] = Field(
        default_factory=dict,
        description="子 Agent 思维级别覆盖（按 app_id）",
    )
    subagent_allowlist: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="子 Agent 调用白名单（父 agent -> 允许的子 agent 列表）",
    )
    subagent_tool_allowlist: List[str] = Field(
        default_factory=list,
        description="子 Agent 工具 allowlist（可选，非空时进入 allow-only 模式）",
    )
    subagent_tool_denylist: List[str] = Field(
        default_factory=lambda: sorted(SUBAGENT_SPAWN_TOOL_NAMES),
        description="子 Agent 工具硬隔离黑名单（denylist），防止子 Agent 嵌套 spawn 导致资源耗尽",
    )
    subagent_max_active_per_parent: int = Field(
        default=2,
        description="单个 parent_thread_id 允许的最大并发子任务数",
    )
    subagent_queue_limit: int = Field(
        default=20,
        description="单个 parent_thread_id 的子任务排队上限",
    )
    subagent_global_queue_limit: int = Field(
        default=200,
        description="全局子任务排队上限",
    )
    subagent_result_ttl: int = Field(
        default=3600,
        description="子 Agent 结果保留 TTL（秒）",
    )

    # --- LiteLLM ---

    litellm_provider_aliases: Dict[str, str] = Field(
        default_factory=lambda: {
            "qwen": "dashscope",
            "claude": "anthropic",
            "codex": "openai",
            "openai-codex": "openai",
            "openai_codex": "openai",
        },
        description=(
            "多智能体 provider → LiteLLM provider 映射。"
            "用于兼容渠道标识（provider_key）与 LiteLLM provider 名不一致的场景。"
        ),
    )

    # --- Prompt Cache ---

    prompt_cache_key_scope: str = Field(
        default="thread",
        description="Prompt cache key 粒度（thread/organization/user/model）",
    )
    prompt_cache_retention: Optional[str] = Field(
        default=None,
        description="Prompt cache retention（如 in_memory/24h）",
    )

    # --- 消息去重 Debounce ---

    debounce_pttl_buffer_ms: int = Field(
        default=50,
        description="Debounce PTTL 缓冲毫秒数（等待 remaining_ms + buffer 后再 drain）",
    )
    debounce_max_wait_retries: int = Field(
        default=10,
        description="Debounce 等待循环最大重试次数",
    )

    # --- 工具结果存储 ---

    tool_result_store_max_entries: int = Field(
        default=20,
        description="tool_result_store 的最大持久化条目数（LRU 驱逐）",
    )

    # --- AI 分类器 ---

    classifier_cache_ttl: int = Field(
        default=60,
        description="AI 分类器结果缓存 TTL（秒）",
    )

    # --- 内部模型 ---

    internal_model_id: Optional[str] = Field(
        default=None,
        description="内部辅助 LLM 调用的默认模型 ID（记忆压缩/分类器等）",
    )

    # --- 持久化 ---

    max_cleanup_retries: int = Field(
        default=5,
        description="持久化清理最大重试次数",
    )

    @classmethod
    def from_settings(cls) -> "OrchestrationConfiguration":
        global _config_cache, _config_cache_ts
        now = _time.monotonic()
        if _config_cache is not None and (now - _config_cache_ts) < _CONFIG_CACHE_TTL:
            return _config_cache
        with _config_cache_lock:
            if _config_cache is not None and (now - _config_cache_ts) < _CONFIG_CACHE_TTL:
                return _config_cache
            instance = cls._build_from_settings()
            _config_cache = instance
            _config_cache_ts = _time.monotonic()
            return instance

    @staticmethod
    def _load_db_overrides() -> Dict[str, Any]:
        """从 EngineRuntimeConfig 读取管理员在 AdminDash 设置的运行时覆盖值。

        宪法 v0.1 §5.8：旧 chat 全局配置 50 字段拆 4 路。子 Agent 运行时模型解析
        归 LLMSceneBinding（`_sub_agent` 场景）治理。

        历史死字段清理记录（子 Agent 计费治本 Phase 0，2026-05）：
        subagent_standard/advanced_model_id 两个 pydantic 死字段 + env 读取已删除
        （它们指向 registry 不存在的 scene_key _sub_agent_standard/_sub_agent_advanced）；
        对应的 ChatGlobalConfig DB 两列早已随 migration 0032 的 DeleteModel 整表删除，
        替代的 EngineRuntimeConfig 不含这两列，故无需新出删列迁移。

        本函数只关心 EngineRuntimeConfig 上保留的 24 个运行时参数
        （ 第三波删除 3 个上下文孤儿字段后的口径）。
        """
        try:
            from apps.chat.conversation.models import EngineRuntimeConfig
            cfg = EngineRuntimeConfig.get_config()
            overrides: Dict[str, Any] = {
                "subagent_max_active": cfg.subagent_max_active,
                "subagent_queue_limit": cfg.subagent_queue_limit,
                "subagent_global_queue_limit": cfg.subagent_global_queue_limit,
            }
            return overrides
        except Exception as exc:
            logger.debug("[config] Failed to load EngineRuntimeConfig overrides: %s", exc)
            return {}

    @classmethod
    def _build_from_settings(cls) -> "OrchestrationConfiguration":
        _DEFAULT_SUBAGENT_DENYLIST = sorted(SUBAGENT_SPAWN_TOOL_NAMES)
        _DEFAULT_PROVIDER_ALIASES = {
            "qwen": "dashscope",
            "claude": "anthropic",
            "codex": "openai",
            "openai-codex": "openai",
            "openai_codex": "openai",
        }

        db_overrides = cls._load_db_overrides()

        allowlist = _parse_json_setting("AGENT_ENGINE_SUBAGENT_ALLOWLIST", {}, dict)
        denylist = _parse_json_setting(
            "AGENT_ENGINE_SUBAGENT_TOOL_DENYLIST", _DEFAULT_SUBAGENT_DENYLIST, list,
        )
        tool_allowlist = _parse_json_setting(
            "AGENT_ENGINE_SUBAGENT_TOOL_ALLOWLIST", [], list,
        )
        model_by_agent = _parse_json_setting("AGENT_ENGINE_SUBAGENT_MODEL_BY_AGENT", {}, dict)
        model_by_app = _parse_json_setting("AGENT_ENGINE_SUBAGENT_MODEL_BY_APP", {}, dict)
        thinking_by_agent = _parse_json_setting("AGENT_ENGINE_SUBAGENT_THINKING_BY_AGENT", {}, dict)
        thinking_by_app = _parse_json_setting("AGENT_ENGINE_SUBAGENT_THINKING_BY_APP", {}, dict)
        litellm_provider_aliases = _parse_json_setting(
            "AGENT_ENGINE_LITELLM_PROVIDER_ALIASES", {}, dict,
        )

        merged_provider_aliases = {
            **_DEFAULT_PROVIDER_ALIASES,
            **{
                str(k).strip().lower(): str(v).strip().lower()
                for k, v in litellm_provider_aliases.items()
                if str(k).strip() and str(v).strip()
            },
        }

        def _db_or(settings_key: str, db_key: str, default):
            """settings 显式设置优先（支持 legacy 回退） > DB 覆盖值 > 硬编码默认值。"""
            val = agent_engine_setting(settings_key, MISSING)
            if val is not MISSING:
                return val
            return db_overrides.get(db_key, default)

        return cls(
            structured_output_retries=getattr(settings, "STRUCTURED_OUTPUT_RETRIES", 3),
            default_model_id=agent_engine_setting("AGENT_ENGINE_DEFAULT_MODEL_ID", None),
            # 子 Agent 配置
            # subagent_default_model_id：保留 settings env 兜底（部署期固定 override）。
            # 注：standard/advanced 两档死字段已删（子 Agent 计费治本 Phase 0，2026-05）。
            # 即使老部署仍带 AGENT_ENGINE_SUBAGENT_STANDARD/ADVANCED_MODEL_ID env，
            # 这里已不再读取，残留 env 值会被安全无视，不会导致启动报错（R10）。
            subagent_default_model_id=agent_engine_setting("AGENT_ENGINE_SUBAGENT_DEFAULT_MODEL_ID", None),
            subagent_model_by_agent=_sanitize_str_dict(model_by_agent),
            subagent_model_by_app=_sanitize_str_dict(model_by_app),
            subagent_default_thinking_level=agent_engine_setting(
                "AGENT_ENGINE_SUBAGENT_DEFAULT_THINKING_LEVEL", None,
            ),
            subagent_thinking_by_agent=_sanitize_str_dict(thinking_by_agent),
            subagent_thinking_by_app=_sanitize_str_dict(thinking_by_app),
            subagent_allowlist=allowlist if isinstance(allowlist, dict) else {},
            subagent_tool_allowlist=_sanitize_str_list(tool_allowlist),
            subagent_tool_denylist=_sanitize_str_list(denylist),
            subagent_max_active_per_parent=int(
                _db_or("AGENT_ENGINE_SUBAGENT_MAX_ACTIVE_PER_PARENT", "subagent_max_active", 2)
            ),
            subagent_queue_limit=int(
                _db_or("AGENT_ENGINE_SUBAGENT_QUEUE_LIMIT", "subagent_queue_limit", 20)
            ),
            subagent_global_queue_limit=int(
                _db_or("AGENT_ENGINE_SUBAGENT_GLOBAL_QUEUE_LIMIT", "subagent_global_queue_limit", 200)
            ),
            subagent_result_ttl=int(
                _db_or("AGENT_ENGINE_SUBAGENT_RESULT_TTL", "subagent_result_ttl", 3600)
            ),
            # LiteLLM
            litellm_provider_aliases=merged_provider_aliases,
            # Prompt Cache
            prompt_cache_key_scope=str(
                agent_engine_setting("AGENT_ENGINE_PROMPT_CACHE_KEY_SCOPE", "thread")
            ).strip().lower() or "thread",
            prompt_cache_retention=str(
                agent_engine_setting("AGENT_ENGINE_PROMPT_CACHE_RETENTION", "") or ""
            ).strip() or None,
            # 消息去重 Debounce
            debounce_pttl_buffer_ms=int(
                _db_or("AGENT_ENGINE_DEBOUNCE_PTTL_BUFFER_MS", "debounce_pttl_buffer_ms", 50)
            ),
            debounce_max_wait_retries=int(
                _db_or("AGENT_ENGINE_DEBOUNCE_MAX_WAIT_RETRIES", "debounce_max_wait_retries", 10)
            ),
            # 工具结果存储
            tool_result_store_max_entries=int(
                agent_engine_setting("AGENT_ENGINE_TOOL_RESULT_STORE_MAX_ENTRIES", 20)
            ),
            # AI 分类器
            classifier_cache_ttl=int(
                agent_engine_setting("AGENT_ENGINE_CLASSIFIER_CACHE_TTL", 60)
            ),
            # 内部模型
            internal_model_id=agent_engine_setting("AGENT_ENGINE_INTERNAL_MODEL_ID", None),
            # 持久化
            max_cleanup_retries=int(
                agent_engine_setting("AGENT_ENGINE_MAX_CLEANUP_RETRIES", 5)
            ),
        )


__all__ = [
    "OrchestrationConfiguration",
    "invalidate_config_cache",
    "SUBAGENT_SPAWN_TOOL_NAMES",
]
