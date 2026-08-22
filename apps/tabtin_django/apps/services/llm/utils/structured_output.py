"""
Structured Output 相关工具。
"""

from typing import Optional, Dict, Any, Type
import json
import re

from pydantic import BaseModel


def parse_llm_json(content: str) -> Optional[Dict[str, Any]]:
    """
    解析 LLM 返回的 JSON（支持 markdown 代码块）。
    """
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            return None

    json_match = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", content, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(0))
        except json.JSONDecodeError:
            return None

    return None


def validate_structured_output(schema_cls: Type[BaseModel], payload: Dict[str, Any]) -> BaseModel:
    """
    兼容 Pydantic v1/v2 的验证入口。
    """
    if hasattr(schema_cls, "model_validate"):
        return schema_cls.model_validate(payload)  # type: ignore[attr-defined]
    return schema_cls.parse_obj(payload)
