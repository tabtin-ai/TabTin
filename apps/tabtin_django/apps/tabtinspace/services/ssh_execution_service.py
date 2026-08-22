"""
SSHExecutionService — SSH 命令执行引擎

通过 paramiko 连接远程服务器，执行命令并支持实时 stdout/stderr WS 推送。
"""
import io
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional
from uuid import UUID

import paramiko

from apps.tabtinspace.models import RemoteServer
from django.utils import timezone

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120
RECV_CHUNK_SIZE = 4096
STREAM_FLUSH_INTERVAL = 0.05  # 50ms
CACHE_MAX_SIZE = 20
CACHE_TTL_SECONDS = 300  # 5 分钟空闲超时


@dataclass
class SSHResult:
    """SSH 命令执行结果"""
    stdout: str = ""
    stderr: str = ""
    exit_code: int = -1
    server_name: str = ""
    host: str = ""
    duration_ms: int = 0
    error: Optional[str] = None


@dataclass
class _CachedClient:
    client: paramiko.SSHClient
    last_used: float


_thread_local = threading.local()


class SSHExecutionService:
    """SSH 命令执行服务

    - connect():          建立 SSH 连接（带 per-thread 连接缓存）
    - execute():          执行命令，阻塞返回完整结果
    - execute_streaming(): 执行命令，逐行推送 stdout/stderr 到 WS
    - test_connection():  连通性测试
    """

    def _get_server(self, server_id: UUID, user=None) -> Optional[RemoteServer]:
        """获取 RemoteServer 并验证所有权。"""
        try:
            server = RemoteServer.objects.select_related('device', 'credential').get(
                id=server_id, status='active'
            )
        except RemoteServer.DoesNotExist:
            return None
        if user and str(server.device.user_id) != str(user.id):
            return None
        return server

    def _build_client(self, server: RemoteServer) -> paramiko.SSHClient:
        """根据 RemoteServer 配置创建 paramiko SSHClient。

        首次连接时记录 host_key fingerprint 到 server.metadata，
        后续连接校验 fingerprint 是否匹配，防止中间人攻击。
        """
        if server.auth_method in ('key', 'password') and not server.credential:
            raise ValueError(f"Server '{server.name}' has auth_method='{server.auth_method}' but no credential configured")

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.WarningPolicy())

        connect_kwargs: Dict[str, Any] = {
            "hostname": server.host,
            "port": server.port,
            "username": server.username,
            "timeout": 15,
        }

        if server.auth_method == 'key' and server.credential:
            key_data = server.credential.get_value()
            pkey = self._load_private_key(key_data)
            connect_kwargs["pkey"] = pkey
        elif server.auth_method == 'password' and server.credential:
            connect_kwargs["password"] = server.credential.get_value()

        client.connect(**connect_kwargs)

        self._verify_and_store_host_key(server, client)
        return client

    def _verify_and_store_host_key(self, server: RemoteServer, client: paramiko.SSHClient):
        """首次连接时保存 host key fingerprint，后续连接验证一致性。"""
        transport = client.get_transport()
        if not transport:
            return
        remote_key = transport.get_remote_server_key()
        if not remote_key:
            return

        import hashlib
        fp = hashlib.sha256(remote_key.asbytes()).hexdigest()
        key_type = remote_key.get_name()

        os_info = server.os_info if isinstance(server.os_info, dict) else {}
        stored_fp = os_info.get('host_key_fingerprint')

        if stored_fp and stored_fp != fp:
            logger.warning(
                "[SSH] HOST KEY CHANGED for %s (%s:%d)! stored=%s, got=%s. Possible MITM attack.",
                server.name, server.host, server.port, stored_fp[:16], fp[:16],
            )
            client.close()
            raise paramiko.SSHException(
                f"Host key fingerprint mismatch for {server.name} ({server.host}). "
                f"This could indicate a man-in-the-middle attack. "
                f"If the server was reinstalled, update the server config to reset the fingerprint."
            )

        if not stored_fp:
            os_info['host_key_fingerprint'] = fp
            os_info['host_key_type'] = key_type
            server.os_info = os_info
            server.save(update_fields=['os_info'])

    @staticmethod
    def _load_private_key(key_data: str) -> paramiko.PKey:
        """尝试多种密钥格式加载私钥（Ed25519 → ECDSA → RSA → DSS）。"""
        key_classes = [
            paramiko.Ed25519Key,
            paramiko.ECDSAKey,
            paramiko.RSAKey,
            paramiko.DSSKey,
        ]
        last_exc = None
        for cls in key_classes:
            try:
                return cls.from_private_key(io.StringIO(key_data))
            except Exception as exc:
                last_exc = exc
                continue
        raise paramiko.SSHException(
            f"Unsupported or passphrase-protected key. Tried Ed25519, ECDSA, RSA, DSS. "
            f"If your private key is encrypted with a passphrase, please decrypt it first "
            f"(e.g., ssh-keygen -p -f keyfile) and re-upload. Last error: {last_exc}"
        )

    def _get_cached_client(self, server: RemoteServer) -> paramiko.SSHClient:
        """Per-thread SSH 连接缓存（带 TTL 和 LRU 淘汰）。"""
        cache_key = str(server.id)
        cache: Dict[str, _CachedClient] = getattr(_thread_local, 'ssh_clients', None)  # type: ignore
        if cache is None:
            cache = {}
            _thread_local.ssh_clients = cache

        now = time.monotonic()
        self._evict_stale(cache, now)

        entry = cache.get(cache_key)
        if entry is not None:
            transport = entry.client.get_transport()
            if transport is not None and transport.is_active():
                entry.last_used = now
                return entry.client
            self._close_quietly(entry.client)
            del cache[cache_key]

        if len(cache) >= CACHE_MAX_SIZE:
            oldest_key = min(cache, key=lambda k: cache[k].last_used)
            self._close_quietly(cache.pop(oldest_key).client)

        client = self._build_client(server)
        cache[cache_key] = _CachedClient(client=client, last_used=now)
        return client

    @staticmethod
    def _evict_stale(cache: Dict[str, '_CachedClient'], now: float):
        """清除空闲超过 TTL 的缓存连接。"""
        stale = [k for k, v in cache.items() if now - v.last_used > CACHE_TTL_SECONDS]
        for k in stale:
            SSHExecutionService._close_quietly(cache.pop(k).client)

    @staticmethod
    def _close_quietly(client: paramiko.SSHClient):
        try:
            client.close()
        except Exception:
            pass

    def connect(self, server_id: UUID, user=None) -> Optional[paramiko.SSHClient]:
        """建立（或复用缓存的）SSH 连接。"""
        server = self._get_server(server_id, user=user)
        if not server:
            return None
        return self._get_cached_client(server)

    def execute(
        self,
        server_id: UUID,
        command: str,
        timeout: int = DEFAULT_TIMEOUT,
        user=None,
    ) -> SSHResult:
        """阻塞执行命令，返回完整结果。"""
        server = self._get_server(server_id, user=user)
        if not server:
            return SSHResult(error="Server not found or no permission")

        start = time.monotonic()
        try:
            client = self._get_cached_client(server)
            stdin, stdout_ch, stderr_ch = client.exec_command(command, timeout=timeout)
            stdout_data = stdout_ch.read().decode(errors='replace')
            stderr_data = stderr_ch.read().decode(errors='replace')
            exit_code = stdout_ch.channel.recv_exit_status()

            server.last_connected_at = timezone.now()
            server.save(update_fields=['last_connected_at'])

            return SSHResult(
                stdout=stdout_data,
                stderr=stderr_data,
                exit_code=exit_code,
                server_name=server.name,
                host=server.host,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as exc:
            logger.error("[SSH] execute failed on %s: %s", server.name, exc)
            self._evict_client(server_id)
            return SSHResult(
                error=str(exc),
                server_name=server.name,
                host=server.host,
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    def execute_streaming(
        self,
        server_id: UUID,
        command: str,
        thread_id: str,
        timeout: int = DEFAULT_TIMEOUT,
        user=None,
    ) -> SSHResult:
        """执行命令并通过 WS 实时推送 stdout/stderr。"""
        from apps.services.common.agent_protocol.namespace import stream_event_type, stream_topic
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        server = self._get_server(server_id, user=user)
        if not server:
            return SSHResult(error="Server not found or no permission")

        event_type = stream_event_type("ssh_output")
        topic = stream_topic(thread_id)

        def _push(stream: str, data: str, done: bool = False):
            # R6-CROSS-1：build_envelope 前 3 个参数 positional-only，必须按
            # positional 调用；kwargs 会抛 TypeError 被外层 except 误吞到
            # "SSH 连接失败" 分支，再次调 _push("stderr", ...) 又抛 TypeError，
            # 整个 streaming 命令崩溃。改 positional 后链路自然恢复。
            envelope = build_envelope(
                event_type,
                new_event_id(),
                {
                    "server_name": server.name,
                    "stream": stream,
                    "data": data,
                    "done": done,
                },
                event_id=new_event_id(),
                thread_id=thread_id,
            )
            publish_ws_event(topic, envelope)

        start = time.monotonic()
        stdout_parts = []
        stderr_parts = []

        try:
            client = self._get_cached_client(server)
            transport = client.get_transport()
            channel = transport.open_session()
            channel.settimeout(timeout)
            channel.exec_command(command)

            while True:
                if time.monotonic() - start > timeout:
                    channel.close()
                    self._evict_client(server_id)
                    _push("stderr", f"Command timed out after {timeout}s", done=True)
                    return SSHResult(
                        stdout="".join(stdout_parts),
                        stderr="".join(stderr_parts) + f"\n[timed out after {timeout}s]",
                        exit_code=-1,
                        server_name=server.name,
                        host=server.host,
                        duration_ms=int((time.monotonic() - start) * 1000),
                        error=f"Command timed out after {timeout}s",
                    )
                if channel.recv_ready():
                    chunk = channel.recv(RECV_CHUNK_SIZE).decode(errors='replace')
                    if chunk:
                        stdout_parts.append(chunk)
                        _push("stdout", chunk)
                if channel.recv_stderr_ready():
                    chunk = channel.recv_stderr(RECV_CHUNK_SIZE).decode(errors='replace')
                    if chunk:
                        stderr_parts.append(chunk)
                        _push("stderr", chunk)
                if channel.exit_status_ready():
                    while channel.recv_ready():
                        chunk = channel.recv(RECV_CHUNK_SIZE).decode(errors='replace')
                        if chunk:
                            stdout_parts.append(chunk)
                            _push("stdout", chunk)
                    while channel.recv_stderr_ready():
                        chunk = channel.recv_stderr(RECV_CHUNK_SIZE).decode(errors='replace')
                        if chunk:
                            stderr_parts.append(chunk)
                            _push("stderr", chunk)
                    break
                time.sleep(STREAM_FLUSH_INTERVAL)

            exit_code = channel.recv_exit_status()
            channel.close()

            _push("stdout", "", done=True)

            server.last_connected_at = timezone.now()
            server.save(update_fields=['last_connected_at'])

            return SSHResult(
                stdout="".join(stdout_parts),
                stderr="".join(stderr_parts),
                exit_code=exit_code,
                server_name=server.name,
                host=server.host,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except (TypeError, AttributeError, NameError) as exc:
            # R6-CROSS-1：envelope 构造类异常必须 logger.exception 暴露——
            # 不再调 _push（它本身就调 build_envelope，会再次触发同类异常导致
            # 死循环；修复前真实事故链路即如此）。也不归类为 "SSH Error"
            # （误导排查方向：实际是 build_envelope kwargs 误用 / TrackerEvent
            # 常量名变更等代码层 bug，不是 SSH 网络问题）。
            logger.exception(
                "[SSH] envelope construction error in streaming push on %s "
                "(likely build_envelope kwargs misuse / protocol constant rename)",
                server.name,
            )
            self._evict_client(server_id)
            return SSHResult(
                error=f"WS envelope construction error: {exc}",
                server_name=server.name,
                host=server.host,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as exc:
            logger.error("[SSH] streaming execute failed on %s: %s", server.name, exc)
            self._evict_client(server_id)
            _push("stderr", f"SSH Error: {exc}", done=True)
            return SSHResult(
                error=str(exc),
                server_name=server.name,
                host=server.host,
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    def test_connection(self, server_id: UUID, user=None) -> Optional[Dict[str, Any]]:
        """测试 SSH 连通性。

        Returns:
            ``None``: 服务器不存在 / 无权访问 → view 转 NOT_FOUND envelope
            ``{"ok": True, "os_info": "..."}``: 连接成功
            ``{"ok": False, "error": "..."}``: 连接失败 → view 转
                ``err_response('SOFT_FAIL', detail={'fallback': {...}})``

        Wave 1 A2 改造：本服务字段从 ``success`` 改名 ``ok``，对齐 envelope 顶层
        ``ok:bool`` 形态；view 层拿 ``result["ok"]`` 决定走 success_response 还是
        SOFT_FAIL envelope，前端不再需要再判 ``data.success``。
        """
        server = self._get_server(server_id, user=user)
        if not server:
            return None

        try:
            client = self._build_client(server)
            stdin, stdout_ch, stderr_ch = client.exec_command("uname -a", timeout=10)
            os_info_str = stdout_ch.read().decode(errors='replace').strip()
            client.close()

            server.last_connected_at = timezone.now()
            existing_info = server.os_info if isinstance(server.os_info, dict) else {}
            existing_info['uname'] = os_info_str
            server.os_info = existing_info
            server.save(update_fields=['last_connected_at', 'os_info'])

            return {"ok": True, "os_info": os_info_str}
        except Exception as exc:
            logger.warning("[SSH] test_connection failed for %s: %s", server.name, exc)
            return {"ok": False, "error": str(exc)}

    def _evict_client(self, server_id: UUID):
        """从缓存中移除失效连接。"""
        cache = getattr(_thread_local, 'ssh_clients', None)
        if cache:
            entry = cache.pop(str(server_id), None)
            if entry:
                self._close_quietly(entry.client)
