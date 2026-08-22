"""LLM Wire Adapter · Feature Flag(W1b 落地,harness 总控 § D10)。

判定 LLMProxy 在某次请求是否走新的 wire_adapter 路径,综合两层信号:

1. **环境变量 ``LLM_WIRE_ADAPTER_ENABLED``**:全局开关,默认 ON。
   设为 ``false`` / ``0`` / ``off`` / ``no`` 时 LLMProxy 回退仅做图片
   ``normalize_image_urls`` 兜底,wire_adapter 不接管 system/tool/json/reasoning
   等其他适配。

2. **LLMModel.capabilities_config['wire_adapter']['disabled']**:个体覆盖。
   设 True 时该 model 的请求绕过 wire_adapter,即使 env 是 ON。用于灰度回滚单 model
   (例:某 model wire_adapter 配置异常但不想全局关闭)。
   v0.1：原 ``LLMModel.wire_adapter_disabled`` 顶层布尔字段已删（migration 0022），
   灰度开关迁入 ``capabilities_config`` 子键。仍保留对实例级 ``wire_adapter_disabled``
   属性的兜底（dict 透传 / 单测 SimpleNamespace 等场景）。

W1 末稳定后(总控 § D10)整个 flag 删除,wire_adapter 永远 ON。

⚠️ **运维警示:flag=false 时 wire_adapter 完整适配链不工作**

当 ``LLM_WIRE_ADAPTER_ENABLED=false`` 或单 model 设了
``capabilities_config['wire_adapter']['disabled']=True`` 时,LLMProxy **仅**做兜底图片归一
(``image_fetcher.normalize_image_urls``),**不做** system / tool / json /
reasoning 适配。新 provider 上线时如果不小心把这个 flag 关了,可能踩到:

- 工具调用格式没适配,LLM 拿到错误的 tool 配额
- system message 风格没对齐,prompt 行为漂移
- json_object 模式没声明,模型不强制输出 JSON
- reasoning 字段没传,推理模型节奏混乱

**建议**:新 provider 上线流程务必先 ``LLM_WIRE_ADAPTER_ENABLED=true`` 验证
capability 适配通过,再视情况灰度回滚个别 model 而不是全局关闭。

设计取舍:
- ``LLM_WIRE_ADAPTER_ENABLED`` 默认 ON 是因为 wire_adapter 路径功能比兜底
  路径**多**(image / system / tool / json / reasoning 全套)。默认 OFF 等于
  wire_adapter 实装白做,违反 spec。
- env 检查放在每次请求(而非 module 级 const),让运维可以热改 env 并 SIGHUP
  worker 立刻生效,不必重启。
- env disabled 第一次命中打 ``logger.warning``(让监控看到这条罕见操作),
  之后转 ``logger.info`` 避免日志膨胀;model-instance 灰度是预期行为,始终
  ``logger.info``。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)


# Env 关闭值的认可集合(case-insensitive)。
_DISABLE_TOKENS = {"false", "0", "off", "no", "disable", "disabled"}

# 进程内"是否已就 env disabled 发过 warning"标记。第一次命中触发 warning
# 让运维监控/告警系统看到罕见状态切换;之后转 info 避免每次请求日志膨胀。
# 跨进程不共享(每个 worker 独立);worker SIGHUP 重启后会重置。
_env_disabled_warned: bool = False


def is_wire_adapter_enabled(model_instance: Optional[Any]) -> bool:
    """综合判定当前请求是否走 wire_adapter 路径。

    Args:
        model_instance: 可选 LLMModel 实例。None 时只判 env(用于尚未解析到
            model 的更早期场景,目前不使用,W1b 留接口)。

    Returns:
        True = wire_adapter 接管,LLMProxy 调 ``adapt_request``。
        False = LLMProxy 回退仅 ``image_fetcher.normalize_image_urls`` 兜底。
    """
    global _env_disabled_warned
    env_value = os.environ.get("LLM_WIRE_ADAPTER_ENABLED", "true").strip().lower()
    if env_value in _DISABLE_TOKENS:
        if not _env_disabled_warned:
            # 第一次发现 env disabled —— 打 warning 让运维监控看到。
            # 这通常是临时灰度回滚或紧急关闭操作;运维应该尽快把 flag 重新
            # 打开(否则 system/tool/json/reasoning 适配链一直停摆)。
            logger.warning(
                "[wire_adapter][feature_flag] DISABLED by env "
                "LLM_WIRE_ADAPTER_ENABLED=%s — wire_adapter 完整适配链(system/"
                "tool/json/reasoning)不工作,仅做图片 URL → base64 兜底转换。"
                "新 provider 上线时务必先开启此 flag 验证 capability 适配。",
                env_value,
            )
            _env_disabled_warned = True
        else:
            logger.info(
                "[wire_adapter][feature_flag] disabled by env "
                "LLM_WIRE_ADAPTER_ENABLED=%s",
                env_value,
            )
        return False

    if model_instance is not None:
        # v0.1：LLMModel.wire_adapter_disabled 字段已删（0022），灰度回滚改为
        # 在 capabilities_config['wire_adapter']['disabled'] 显式标记。
        config = getattr(model_instance, "capabilities_config", None) or {}
        wa = config.get("wire_adapter") if isinstance(config, dict) else None
        disabled = False
        if isinstance(wa, dict):
            disabled = bool(wa.get("disabled"))
        # 兼容仍有 wire_adapter_disabled 属性透传（dict / 旧实例）
        if not disabled:
            disabled = bool(getattr(model_instance, "wire_adapter_disabled", False))
        if disabled:
            model_label = (
                getattr(model_instance, "model_name", None)
                or str(getattr(model_instance, "id", "?"))
            )
            logger.info(
                "[wire_adapter][feature_flag] disabled by model %s "
                "(capabilities_config['wire_adapter']['disabled']=True)",
                model_label,
            )
            return False

    return True


__all__ = ["is_wire_adapter_enabled"]
