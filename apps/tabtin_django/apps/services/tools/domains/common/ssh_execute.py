"""
SSH Execute Tool — 在远程服务器上执行命令

纯后端工具（execution_mode="server"），通过 paramiko 连接远程服务器。
命令输出通过 WS 实时推送到前端。
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional
from typing_extensions import Annotated

from pydantic import BaseModel, Field

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool

logger = logging.getLogger(__name__)


class SSHExecuteInput(BaseModel):
    """ssh_execute 工具输入参数"""
    server_name: str = Field(
        description="Target SSH server name (as shown in available servers list)"
    )
    command: str = Field(
        description="Shell command to execute on the remote server"
    )
    timeout_ms: Optional[int] = Field(
        default=None,
        description="Timeout in milliseconds (optional, default 120s)",
    )
    remote_servers: Annotated[Optional[List[Dict[str, Any]]], InjectedState("_remote_servers")] = Field(
        default=None,
        description="Available SSH servers (auto-injected from state)",
    )
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="当前用户 ID（自动注入）",
    )


_SSH_DENY_PATTERNS: List[re.Pattern] = [
    re.compile(r'\brm\s+(-[rR]f?|--recursive)\s+/', re.IGNORECASE),
    re.compile(r'\b(mkfs|dd)\b', re.IGNORECASE),
    re.compile(r'\b(reboot|shutdown|poweroff|halt|init\s+[06])\b', re.IGNORECASE),
    re.compile(r'\|\s*(ba)?sh\b', re.IGNORECASE),
    re.compile(r'\bsudo\b', re.IGNORECASE),
    re.compile(r'\bcrontab\s+(-e|-r)\b', re.IGNORECASE),
    re.compile(r'\b(iptables|nftables|ufw)\b', re.IGNORECASE),
    re.compile(r'\bchmod\s+777\b', re.IGNORECASE),
    re.compile(r'>\s*/dev/(sda|nvme|disk)', re.IGNORECASE),
]


def _is_ssh_command_denied(command: str) -> Optional[str]:
    """Check if SSH command matches any deny pattern. Returns reason or None."""
    for pattern in _SSH_DENY_PATTERNS:
        if pattern.search(command):
            return f"Command blocked by SSH safety policy (matched: {pattern.pattern})."
    return None


class SSHExecuteTool(BaseTool):
    category: str = "terminal"
    name: str = "ssh_execute"
    description: str = (
        "Execute a shell command on a remote SSH server. "
        "The server must be configured and active in the current Space's bound device. "
        "Use the server_name parameter to specify which server to connect to. "
        "Command output (stdout/stderr) is streamed in real-time."
    )
    execution_mode: str = "server"
    risk_level: str = "review"
    timeout: int = 120
    args_schema: type[SSHExecuteInput] = SSHExecuteInput
    available_modes: tuple = ("agent",)

    def run(
        self,
        server_name: str,
        command: str,
        timeout_ms: Optional[int] = None,
        remote_servers: Optional[List[Dict[str, Any]]] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not command or not command.strip():
            return {"success": False, "error": "command is required"}

        deny_reason = _is_ssh_command_denied(command.strip())
        if deny_reason:
            return {"success": False, "error": deny_reason}

        from apps.services.common.sandbox_policy import is_high_risk_command
        if is_high_risk_command(command.strip()):
            return {
                "success": False,
                "error": (
                    "Command identified as high-risk by SSH safety policy. "
                    "High-risk commands (git push, docker build/run, scp, etc.) "
                    "are not allowed via SSH without explicit user approval."
                ),
            }

        if not remote_servers:
            return {
                "success": False,
                "error": "No SSH servers available. The Space must be bound to a device with configured SSH servers.",
            }

        server_entry = None
        for s in remote_servers:
            if s.get("name") == server_name:
                server_entry = s
                break

        if not server_entry:
            available = [s.get("name", "?") for s in remote_servers]
            return {
                "success": False,
                "error": f"Server '{server_name}' not found. Available servers: {available}",
            }

        server_id = server_entry.get("id")
        if not server_id:
            return {"success": False, "error": "Server configuration is invalid (missing id)"}

        timeout_sec = (timeout_ms // 1000) if timeout_ms else self.timeout

        from apps.services.common.thread_context import get_current_thread_id
        thread_id = get_current_thread_id()

        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService
        ssh_service = SSHExecutionService()

        # 将 user_id 转为 User 对象用于权限校验
        user_obj = None
        if user_id:
            try:
                from django.contrib.auth import get_user_model
                user_obj = get_user_model().objects.get(id=user_id)
            except Exception:
                logger.debug("[ssh_execute] Failed to load User object for user_id=%s", user_id, exc_info=True)

        if thread_id:
            result = ssh_service.execute_streaming(
                server_id=server_id,
                command=command,
                thread_id=thread_id,
                timeout=timeout_sec,
                user=user_obj,
            )
        else:
            result = ssh_service.execute(
                server_id=server_id,
                command=command,
                timeout=timeout_sec,
                user=user_obj,
            )

        if result.error:
            return {
                "success": False,
                "error": result.error,
                "server_name": result.server_name,
                "host": result.host,
                "duration_ms": result.duration_ms,
            }

        return {
            "success": True,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
            "server_name": result.server_name,
            "host": result.host,
            "duration_ms": result.duration_ms,
        }


__all__ = ["SSHExecuteTool"]
