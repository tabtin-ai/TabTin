"""
MemorySignalDetector — L1 零成本信号检测

在 after_iteration 中扫描新消息，用纯 Python 关键词/短语匹配识别需要立即记忆的信号。
不调用 LLM，不做 IO，只做字符串匹配。

信号类型:
    explicit_remember — 用户要求记住某事（组合模式：动词+宾语）
    correction       — 用户纠正 Agent 的错误认知
    explicit_forget   — 用户要求忘记/停止某行为
    error_detected    — 对话中出现结构化错误信号（仅 role=tool 或明确错误模板）
"""

from __future__ import annotations

import re
import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# ── explicit_remember: 组合模式，要求"动词 + 上下文"同时出现 ──

_REMEMBER_PATTERNS_ZH = [
    re.compile(r"记住.{0,15}(偏好|习惯|设置|喜欢|总是|方式|风格|配置|规则)"),
    re.compile(r"(别忘了|不要忘).{0,20}(以后|下次|每次)"),
    re.compile(r"以后(都|一直|每次).{0,15}(用|要|别|不要)"),
    re.compile(r"每次都要\s*(记住|保持|用|设|开启|关闭|加|做).{0,8}"),
    re.compile(r"一直(用|保持|记|设置).{0,8}"),
]

_REMEMBER_PATTERNS_EN = [
    re.compile(r"remember\s+(that|this|my|to)\b", re.IGNORECASE),
    re.compile(r"(don't|do not)\s+forget\s+(that|to|my)\b", re.IGNORECASE),
    re.compile(r"from\s+now\s+on[,\s]", re.IGNORECASE),
    re.compile(r"always\s+(prefer|set|keep)\b", re.IGNORECASE),
    re.compile(r"keep\s+in\s+mind\s+(that|my)\b", re.IGNORECASE),
]

# ── correction: 用户纠正 Agent ──

_CORRECTION_PATTERNS_ZH = [
    re.compile(r"(不对|不是这样|搞错了|说错了|弄错了)"),
    re.compile(r"我(纠正|更正|修正)"),
    re.compile(r"应该是.{1,30}(不是|而不是)"),
]

_CORRECTION_PATTERNS_EN = [
    re.compile(r"(that'?s|that\s+is)\s+(wrong|incorrect|not\s+right)", re.IGNORECASE),
    re.compile(r"actually[,\s]+no\b", re.IGNORECASE),
    re.compile(r"\bcorrection[:.\s]", re.IGNORECASE),
]

# ── explicit_forget: 用户要求停止/忘记 ──

_FORGET_PATTERNS_ZH = [
    re.compile(r"(别再|不要再).{0,10}(用|做|说|提)"),
    re.compile(r"(取消|停止|忘掉).{0,10}(偏好|习惯|设置|记忆|规则)"),
    re.compile(r"不要(用|做).{0,10}了"),
]

_FORGET_PATTERNS_EN = [
    re.compile(r"stop\s+(doing|using|calling)\b", re.IGNORECASE),
    re.compile(r"(no\s+longer|never\s+again)\s+\w+", re.IGNORECASE),
    re.compile(r"(don't|do\s+not)\s+(do|use)\s+\w+\s+(anymore|again)", re.IGNORECASE),
]

# ── error_detected: 仅检测结构化错误输出 ──

_ERROR_LINE_PATTERNS = [
    re.compile(r"^(Error|ERROR|Exception|Traceback|FAILED|Fatal|FATAL)", re.MULTILINE),
    re.compile(r"^\s*(raise\s+\w+Error|AssertionError|TypeError|ValueError|KeyError|AttributeError|ImportError|RuntimeError)", re.MULTILINE),
    re.compile(r"(报错|踩坑|出错了|失败了|异常了)"),
    re.compile(r"exit\s+(code|status)[:\s]+[1-9]", re.IGNORECASE),
]


class MemorySignalDetector:
    """零成本信号检测器，在 after_iteration 中运行。

    使用组合正则模式替代单关键词匹配，大幅降低误报率。
    error_detected 仅检查 role=tool/system 消息和明确的错误模板。
    """

    def detect(
        self,
        messages: List[Dict[str, Any]],
        last_index: int,
    ) -> List[Dict[str, Any]]:
        """扫描 messages[last_index:] 中的新消息，返回检测到的信号列表。"""
        signals: List[Dict[str, Any]] = []
        for msg in messages[last_index:]:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "")
            text = self._extract_text(msg)
            if not text:
                continue

            if role == "user":
                if self._match_patterns(text, _REMEMBER_PATTERNS_ZH + _REMEMBER_PATTERNS_EN):
                    signals.append({"type": "explicit_remember", "role": role, "snippet": text[:200]})
                if self._match_patterns(text, _CORRECTION_PATTERNS_ZH + _CORRECTION_PATTERNS_EN):
                    signals.append({"type": "correction", "role": role, "snippet": text[:200]})
                if self._match_patterns(text, _FORGET_PATTERNS_ZH + _FORGET_PATTERNS_EN):
                    signals.append({"type": "explicit_forget", "role": role, "snippet": text[:200]})

            if role in ("tool", "system") and self._match_patterns(text, _ERROR_LINE_PATTERNS):
                signals.append({"type": "error_detected", "role": role, "snippet": text[:200]})

        return signals

    @staticmethod
    def _extract_text(msg: Dict[str, Any]) -> str:
        content = msg.get("content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            return " ".join(parts).strip()
        return ""

    @staticmethod
    def _match_patterns(text: str, patterns: List[re.Pattern]) -> bool:
        return any(p.search(text) for p in patterns)
