"""
Structured Output 包装器。
"""

from typing import List, Dict, Any, Type
import logging
import uuid

from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from pydantic import BaseModel

from apps.services.llm.utils.structured_output import parse_llm_json, validate_structured_output

logger = logging.getLogger(__name__)

_OPENAI_COMPATIBLE_PROVIDERS = frozenset({"openai", "codex", "moonshot", "qwen", "deepseek", "zenmux"})


class StructuredOutputBillingError(RuntimeError):
    """Raised when structured output cannot be delivered because billing failed."""


class StructuredOutputWrapper:
    """
    Structured Output 包装器（基于 LangChain ChatOpenAI）。
    """

    def __init__(
        self,
        service,
        schema_cls: Type[BaseModel],
        max_retries: int,
        user_id: str = "",
        organization_id: str = "",
    ):
        self.service = service
        self.schema_cls = schema_cls
        self.max_retries = max_retries
        # 请求发起人，仅用于审计/预检；扣费主体由 _billing_organization_id 决定。
        self._billing_user_id = user_id
        self._billing_organization_id = organization_id

    def chat(self, messages: List[Dict[str, str]], **kwargs) -> BaseModel:
        """
        返回 Pydantic 对象；失败时回退 JSON 解析。
        """
        self._precheck()

        # FND-41: 非 OpenAI 兼容 provider 直接走 fallback，避免静默降级
        if not self.service.supports_structured_output() or not self._is_openai_compatible():
            if not self._is_openai_compatible():
                logger.info(
                    "[StructuredOutput] provider '%s' 不兼容 ChatOpenAI，使用 fallback 路径",
                    getattr(self.service, "provider_name", "unknown"),
                )
            return self._fallback(messages, **kwargs)

        try:
            max_output_tokens = self.service._resolve_max_output_tokens(kwargs)
            try:
                messages = self.service._check_and_truncate_messages(messages, max_output_tokens)
            except ValueError as exc:
                logger.warning("[StructuredOutput] token limit 预检查失败，回退 JSON 解析: %s", exc)
                return self._fallback(messages, **kwargs)

            model_kwargs = dict(kwargs)
            model_kwargs["max_tokens"] = max_output_tokens
            model = self._build_model(**model_kwargs)
            structured_model = model.with_structured_output(self.schema_cls, include_raw=True)

            # FND-39: 手动重试循环，累计每次尝试的 token 消耗
            accumulated_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
            last_error = None

            for attempt in range(max(1, self.max_retries)):
                try:
                    raw_response = structured_model.invoke(self._to_lc_messages(messages))
                except Exception as exc:
                    logger.warning(
                        "[StructuredOutput] 主路径第 %d/%d 次调用异常: %s",
                        attempt + 1,
                        self.max_retries,
                        exc,
                    )
                    last_error = exc
                    continue

                raw_msg = raw_response.get("raw") if isinstance(raw_response, dict) else None
                self._accumulate_usage(raw_msg, accumulated_usage)

                parsing_error = raw_response.get("parsing_error") if isinstance(raw_response, dict) else None
                if parsing_error:
                    logger.warning(
                        "[StructuredOutput] 主路径第 %d/%d 次解析失败: %s",
                        attempt + 1,
                        self.max_retries,
                        parsing_error,
                    )
                    last_error = parsing_error
                    continue

                parsed = raw_response.get("parsed") if isinstance(raw_response, dict) else raw_response
                self._charge_accumulated_usage(accumulated_usage)

                if isinstance(parsed, BaseModel):
                    return parsed
                return validate_structured_output(self.schema_cls, parsed)

            self._charge_accumulated_usage(accumulated_usage)
            if last_error:
                raise last_error
            raise RuntimeError("structured output: max retries exhausted")

        except StructuredOutputBillingError:
            raise
        except Exception as exc:
            logger.warning("[StructuredOutput] structured 输出失败，回退 JSON 解析: %s", exc)
            return self._fallback(messages, **kwargs)

    def _is_openai_compatible(self) -> bool:
        provider = (getattr(self.service, "provider_name", "") or "").lower()
        return provider in _OPENAI_COMPATIBLE_PROVIDERS

    def _build_model(self, **kwargs) -> ChatOpenAI:
        model_kwargs = {
            "model": self.service.model_name,
            "api_key": self.service.api_key,
            "base_url": self.service.base_url,
        }
        if kwargs.get("temperature") is not None:
            model_kwargs["temperature"] = kwargs.get("temperature")
        if kwargs.get("max_tokens") is not None:
            model_kwargs["max_tokens"] = kwargs.get("max_tokens")
        return ChatOpenAI(**model_kwargs)

    def _to_lc_messages(self, messages: List[Dict[str, str]]):
        converted = []
        for message in messages:
            role = message.get("role")
            content = message.get("content", "")
            if role == "system":
                converted.append(SystemMessage(content=content))
            elif role == "assistant":
                converted.append(AIMessage(content=content))
            else:
                converted.append(HumanMessage(content=content))
        return converted

    def _fallback(self, messages: List[Dict[str, str]], **kwargs) -> BaseModel:
        raw = self.service.chat(messages, **kwargs)
        if not raw.get("success"):
            raise RuntimeError(raw.get("error", "structured output fallback failed"))
        self._charge_fallback_usage(raw)
        content = raw.get("content", "")
        parsed = parse_llm_json(content)
        if parsed is None:
            raise ValueError("structured output fallback parse failed")
        return validate_structured_output(self.schema_cls, parsed)

    def _precheck(self) -> None:
        """统一四层预检，不通过则抛出语义化异常。

        抛出 BudgetExceededException / InsufficientBalanceError 而非 RuntimeError，
        让调用方可按类型捕获并返回友好错误，避免 500。
        """
        if not self._billing_user_id and not self._billing_organization_id:
            return
        if self._billing_user_id and not (self._billing_organization_id or "").strip():
            from .billed_call import InsufficientBalanceError
            raise InsufficientBalanceError(
                user_id=self._billing_user_id,
                organization_id="",
                reason="缺少组织信息，无法执行 LLM 调用",
            )
        try:
            from apps.services.billing.services.billing_precheck import billing_precheck
            from .billed_call import InsufficientBalanceError
            from .billing import BudgetExceededException

            precheck = billing_precheck(
                self._billing_organization_id or "",
                self._billing_user_id or "",
                context="structured_output",
                source="auto_task",
            )
            if precheck.blocked:
                if precheck.layer == "budget":
                    raise BudgetExceededException(
                        organization_id=self._billing_organization_id,
                        budget_status="critical",
                    )
                raise InsufficientBalanceError(
                    user_id=self._billing_user_id,
                    organization_id=self._billing_organization_id or "",
                )
        except (ImportError, BudgetExceededException, InsufficientBalanceError):
            raise
        except Exception:
            logger.warning("[StructuredOutput] precheck 异常，放行（D1）", exc_info=True)

    def _accumulate_usage(self, raw_msg, accumulated: Dict[str, int]) -> None:
        """从 AIMessage 中提取 usage 并累加到 accumulated。"""
        if raw_msg is None:
            return
        try:
            metadata = getattr(raw_msg, "response_metadata", None) or {}
            token_usage = metadata.get("token_usage") or metadata.get("usage") or {}
            if not token_usage:
                usage_metadata = getattr(raw_msg, "usage_metadata", None)
                if usage_metadata:
                    token_usage = {
                        "prompt_tokens": getattr(usage_metadata, "input_tokens", 0),
                        "completion_tokens": getattr(usage_metadata, "output_tokens", 0),
                    }
            if not token_usage:
                return

            pt = token_usage.get("input_tokens") or token_usage.get("prompt_tokens", 0)
            ct = token_usage.get("output_tokens") or token_usage.get("completion_tokens", 0)
            accumulated["input_tokens"] += pt
            accumulated["output_tokens"] += ct
            accumulated["total_tokens"] += token_usage.get("total_tokens", pt + ct)
        except Exception:
            logger.debug("[StructuredOutput] usage 提取失败", exc_info=True)

    def _charge_accumulated_usage(self, accumulated: Dict[str, int]) -> None:
        """对累计的 token 消耗执行计费。"""
        if not self._billing_user_id and not self._billing_organization_id:
            return
        if accumulated["total_tokens"] <= 0:
            return
        try:
            result = {
                "success": True,
                "usage": {
                    "input_tokens": accumulated["input_tokens"],
                    "output_tokens": accumulated["output_tokens"],
                    "prompt_tokens": accumulated["input_tokens"],
                    "completion_tokens": accumulated["output_tokens"],
                    "total_tokens": accumulated["total_tokens"],
                },
            }
            from .billed_call import safe_charge_usage
            call_id = uuid.uuid4().hex
            charged = safe_charge_usage(
                llm_service=self.service,
                result=result,
                user_id=self._billing_user_id,
                organization_id=self._billing_organization_id,
                source="structured_output:main",
                biz_id=f"structured_output:main:{call_id}",
            )
            if not charged:
                raise StructuredOutputBillingError(
                    "structured output billing failed; result not delivered"
                )
        except StructuredOutputBillingError:
            raise
        except Exception:
            logger.debug("[StructuredOutput] 累计计费失败", exc_info=True)
            raise StructuredOutputBillingError(
                "structured output billing failed; result not delivered"
            )

    def _charge_fallback_usage(self, result: dict) -> None:
        if not self._billing_user_id and not self._billing_organization_id:
            return
        try:
            from .billed_call import safe_charge_usage
            call_id = uuid.uuid4().hex
            charged = safe_charge_usage(
                llm_service=self.service,
                result=result,
                user_id=self._billing_user_id,
                organization_id=self._billing_organization_id,
                source="structured_output:fallback",
                biz_id=f"structured_output:fallback:{call_id}",
            )
            if not charged:
                raise StructuredOutputBillingError(
                    "structured output fallback billing failed; result not delivered"
                )
        except StructuredOutputBillingError:
            raise
        except Exception:
            logger.warning("[StructuredOutput] fallback 计费失败", exc_info=True)
            raise StructuredOutputBillingError(
                "structured output fallback billing failed; result not delivered"
            )
