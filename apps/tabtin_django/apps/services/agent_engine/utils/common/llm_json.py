"""
LLM JSON 解析工具。
"""

from typing import Optional, Dict, Any
import json
import re


def parse_llm_json(content: str) -> Optional[Dict[str, Any]]:
    """
    解析 LLM 返回的 JSON（支持 markdown 代码块）。
    """
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass  # defensive: 原始内容非纯 JSON，继续尝试代码块/子串提取

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
