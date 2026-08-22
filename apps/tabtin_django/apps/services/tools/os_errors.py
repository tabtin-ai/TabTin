"""
OS 访问错误的 Python 端镜像 — 与 packages/os-errors 保持同源。

后端工具从 Electron Main / Daemon IPC / HTTP 收到的"OS 错误"载荷会是
JSON 形式的 OSToolError（safe-fs / @tabtin/os-errors 序列化产物）。本模块
提供：

  1. 错误码常量 — 与 TS 端 `OSErrorCode` 一一对应；
  2. `OSToolError` dataclass — 反序列化结构 + 给 Agent 的 llm_message；
  3. `parse_os_tool_error` — 从任意 IPC payload 中识别并提取 OS 错误；
  4. `as_tool_failure` — 把 OSToolError 转成后端工具的统一失败结果格式
     （直接用 llm_message 作为 content，让 LLM 自己执行处理协议）。

设计准则与 TS 端一致：
  - **错误处理协议跟着错误本身**走，不污染 Agent system prompt；
  - 跨平台错误码中立，不暴露 errno 细节给 LLM；
  - terminal=True 时 Tool 层应提示 runtime 节流，避免 Agent 死循环重试。

修改本文件时务必同步检查 packages/os-errors/src/types.ts 的对应定义。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from typing import Any, Dict, Final, Literal, Optional, Tuple

# ─── 错误码常量（与 TS 端 OSErrorCode 同步） ────────────────────────────

OS_ERROR_CODES: Final[Tuple[str, ...]] = (
    "OS_PERMISSION_DENIED",
    "OS_AV_BLOCKED",
    "CLOUD_NOT_DOWNLOADED",
    "NETWORK_CREDENTIAL_REQUIRED",
    "PATH_TOO_LONG",
    "DISK_LOCKED",
    "TARGET_BUSY",
    "TARGET_NOT_FOUND",
)

OSErrorCode = Literal[
    "OS_PERMISSION_DENIED",
    "OS_AV_BLOCKED",
    "CLOUD_NOT_DOWNLOADED",
    "NETWORK_CREDENTIAL_REQUIRED",
    "PATH_TOO_LONG",
    "DISK_LOCKED",
    "TARGET_BUSY",
    "TARGET_NOT_FOUND",
]

OS_ERROR_CATEGORIES: Final[Tuple[str, ...]] = (
    "RemovableVolume",
    "CloudStorage",
    "Documents",
    "Desktop",
    "Downloads",
    "NetworkVolume",
    "FullDisk",
    "Other",
)


# ─── 数据结构 ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OSToolError:
    """对应 TS 端 OSToolError；反序列化后给 Agent 的就是 llm_message 一个字段。"""

    code: str
    category: str
    platform: str  # 'darwin' | 'win32' | 'linux'
    path: str
    terminal: bool
    llm_message: str
    raw_detail: str = ""

    @classmethod
    def from_dict(cls, obj: Dict[str, Any]) -> "OSToolError":
        return cls(
            code=str(obj["code"]),
            category=str(obj.get("category", "Other")),
            platform=str(obj.get("platform", "")),
            path=str(obj.get("path", "")),
            terminal=bool(obj.get("terminal", True)),
            llm_message=str(obj.get("llm_message", "")),
            raw_detail=str(obj.get("raw_detail", "")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)


# ─── 解析与识别 ────────────────────────────────────────────────────────


def parse_os_tool_error(payload: Any) -> Optional[OSToolError]:
    """
    从任意 IPC / HTTP 响应 payload 中识别并提取 OSToolError。

    匹配规则（任一满足）：
      - payload 是 dict 且含 `code` ∈ OS_ERROR_CODES 且含 `llm_message`；
      - payload 是 dict 且含 `__kind__ == "os_tool_error"`（显式标记，推荐）；
      - payload 是 string，尝试 JSON 解析后递归。

    都不匹配返回 None，调用方按普通业务错误处理。
    """
    if payload is None:
        return None

    if isinstance(payload, str):
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            return None
        return parse_os_tool_error(obj)

    if not isinstance(payload, dict):
        return None

    explicit = payload.get("__kind__") == "os_tool_error"
    has_required = (
        "code" in payload
        and "path" in payload
        and "llm_message" in payload
        and payload.get("code") in OS_ERROR_CODES
    )
    if not (explicit or has_required):
        return None
    return OSToolError.from_dict(payload)


def is_os_tool_error_payload(payload: Any) -> bool:
    """快速判断（不做反序列化），适合在 hot path 上用。"""
    return parse_os_tool_error(payload) is not None


# ─── 工具结果适配 ──────────────────────────────────────────────────────


def as_tool_failure(
    err: OSToolError,
    *,
    include_raw_detail: bool = False,
) -> Dict[str, Any]:
    """
    把 OSToolError 转成后端工具的统一失败结果格式。

    返回字典直接可作为 Tool result：
      {
        "success": False,
        "content": "<llm_message — Agent 直接读这一段>",
        "error_code": "OS_PERMISSION_DENIED",
        "error_kind": "os_access",
        "terminal": True,
        ...
      }

    `include_raw_detail=True` 时把 raw_detail 也带上（仅给 telemetry / 日志）；
    默认不暴露给 LLM context，避免无意义的 errno 数字干扰决策。
    """
    payload: Dict[str, Any] = {
        "success": False,
        "content": err.llm_message,
        "error_kind": "os_access",
        "error_code": err.code,
        "category": err.category,
        "platform": err.platform,
        "path": err.path,
        "terminal": err.terminal,
    }
    if include_raw_detail and err.raw_detail:
        payload["raw_detail"] = err.raw_detail
    return payload


__all__ = [
    "OS_ERROR_CODES",
    "OS_ERROR_CATEGORIES",
    "OSErrorCode",
    "OSToolError",
    "parse_os_tool_error",
    "is_os_tool_error_payload",
    "as_tool_failure",
]
