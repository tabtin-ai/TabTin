"""
Frontend Action Dispatcher - 前端动作统一调度器

负责所有 Agent 前端工具的通信调度，提供统一的：
- 任务下发（WS 推送）
- 结果等待（Redis BRPOP）
- 超时和错误处理

使用场景：
- 网页抓取（capture_webpage）
- 其他前端操作（根据需要扩展）
- 等所有需要前端执行的工具

架构：
    后端工具 → Dispatcher.dispatch_action()
        ↓ WS 推送
    WS 推送 → 前端 Electron
        ↓ 执行动作
    HTTP POST → Redis LPUSH
        ↓ BRPOP 读取
    返回结果 ← Dispatcher
"""

import json
import uuid
import logging
from typing import Dict, Any, Optional
import redis

from apps.services.common.agent_protocol.constants import FrontendDispatchEvent
from apps.services.common.observability.trace import get_current_trace_id
from apps.services.agent_engine.utils.common.thread_id import validate_thread_id_prefix
from apps.services.agent_engine.services.frontend_action_service import FrontendActionService, get_frontend_action_service
from apps.services.common.device_capability_registry import get_tool_capability_map
from apps.services.agent_engine.services.device_dispatch_service import DEVICE_FALLBACK_POLICY

logger = logging.getLogger(__name__)

FRONTEND_ACTION_TIMEOUT_MARGIN_MS = 5000


def _allows_capability_action(execution_context: Any, action_type: str) -> bool:
    required_capability = get_tool_capability_map().get(action_type)
    if not required_capability:
        return False
    if required_capability == "html_render":
        return bool(getattr(execution_context, "can_video_render_html", False))
    if required_capability == "video_export":
        return bool(getattr(execution_context, "can_video_export", False))
    return bool(getattr(execution_context, f"can_{required_capability}", False))


def _should_probe_publish_failure(action_type: str) -> bool:
    required_capability = get_tool_capability_map().get(action_type)
    if not required_capability:
        return False
    return DEVICE_FALLBACK_POLICY.get(required_capability) == "device_only"


def _device_only_timeout_payload(action_type: str, timeout: int) -> Dict[str, Any] | None:
    required_capability = get_tool_capability_map().get(action_type)
    if required_capability not in {"video_render_mg", "video_export"}:
        return None
    label = "MG 视频渲染" if required_capability == "video_render_mg" else "视频导出"
    return {
        "success": False,
        "error": (
            f"{label}等待 TabTin Daemon 返回结果超时（{timeout}s）。"
            "请确认后台设备仍在线且已上报对应视频能力；任务可能仍在后台运行，"
            "可稍后查看项目状态，或刷新设备能力后重试。"
        ),
        "error_code": "VIDEO_DEVICE_RESULT_TIMEOUT",
        "required_capability": required_capability,
    }


def _device_only_publish_failure_payload(action_type: str) -> Dict[str, Any] | None:
    required_capability = get_tool_capability_map().get(action_type)
    if required_capability not in {"video_render_mg", "video_export"}:
        return None
    label = "MG 视频渲染" if required_capability == "video_render_mg" else "视频导出"
    return {
        "success": False,
        "error": (
            f"{label}任务未能下发到 TabTin Daemon。"
            "请确认后台设备在线、已绑定到当前 Agent，并刷新设备能力后重试。"
        ),
        "error_code": "VIDEO_DEVICE_DELIVERY_FAILED",
        "required_capability": required_capability,
    }


class FrontendActionDispatcher:
    """
    前端动作调度器（单例）

    职责：
    1. 发送任务到 WS（Publish）→ 前端接收执行
    2. 阻塞等待结果（BRPOP）← 前端 HTTP POST 上报
    3. 超时和错误处理

    优势：
    - 零轮询：BRPOP 阻塞等待，不浪费 CPU
    - 统一管理：所有前端工具共享同一套逻辑
    - 易扩展：新增工具只需调用 dispatch_action()
    """

    _instance: Optional['FrontendActionDispatcher'] = None

    def __new__(cls):
        """单例模式"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        """初始化（延迟初始化 Redis）"""
        if hasattr(self, '_initialized') and self._initialized:
            return

        self._service = get_frontend_action_service()
        self._initialized = True
        logger.debug("[FrontendDispatcher] Dispatcher created (Redis lazy init)")

    @property
    def redis_client(self):
        """延迟初始化 Redis 客户端"""
        return self._service.redis_client

    def dispatch_action(
        self,
        thread_id: str,
        action_type: str,
        params: Dict[str, Any],
        timeout: int = 60,
        wait_for_dynamic: bool = True,
        task_id: Optional[str] = None,
        execution_context: Optional[Any] = None,
        cancel_event=None,
    ) -> Dict[str, Any]:
        """
        统一的前端动作调度

        Args:
            thread_id: 会话 ID（格式：chat-session-xxx）
            action_type: 动作类型（如：capture_webpage）
            params: 动作参数（将传递给前端）
            timeout: 超时时间（秒），默认 60 秒
            wait_for_dynamic: 是否等待动态内容加载（仅某些动作需要）
            execution_context: ExecutionContext 实例（可选），用于前端能力守卫

        Returns:
            {
                "success": True/False,
                "data": {...},  # 成功时的数据
                "error": "..."  # 失败时的错误信息
            }

        Raises:
            无异常抛出，所有错误都通过返回值传递

        Example:
            >>> dispatcher = get_frontend_dispatcher()
            >>> result = dispatcher.dispatch_action(
            ...     thread_id="chat-session-123",
            ...     action_type="capture_webpage",
            ...     params={"url": "https://zhihu.com"},
            ...     timeout=60
            ... )
            >>> print(result['success'])  # True
        """
        if execution_context is not None:
            can_fa = getattr(execution_context, "can_frontend_action", True)
            allow_local_mcp = (
                action_type.startswith("mcp_")
                and getattr(execution_context, "can_mcp", False)
            )
            allow_capability_action = _allows_capability_action(execution_context, action_type)
            if not can_fa and not allow_local_mcp and not allow_capability_action:
                mode = getattr(execution_context, "mode", "unknown")
                hint = getattr(execution_context, "recovery_hint", "") or ""
                msg = f"Current execution environment ({mode}) does not support frontend action '{action_type}'"
                if hint:
                    msg += f". {hint}"
                logger.warning("[FrontendDispatcher] Frontend action blocked by ExecutionContext guard: %s", msg)
                return {"success": False, "error": msg, "degraded": True}

        thread_id_error = validate_thread_id_prefix(thread_id)
        if thread_id_error:
            return {"success": False, "error": thread_id_error}

        # 1. 生成任务 ID
        task_id = task_id or f"{action_type}_{uuid.uuid4().hex[:16]}"

        # 2. 构建事件数据
        current_trace_id = get_current_trace_id()
        event = {
            'event': FrontendDispatchEvent.FRONTEND_ACTION,
            'data': {
                'task_id': task_id,
                'type': action_type,
                'params': {
                    **params,
                    'waitForDynamic': wait_for_dynamic
                },
                'thread_id': thread_id,
                'trace_id': str(current_trace_id) if current_trace_id else None,
            }
        }

        # 3. 发布事件到 WS topic
        topic = self._service.build_action_channel(thread_id)

        try:
            published_count = self._service.publish_action(
                thread_id, event,
                timeout_ms=timeout * 1000 + FRONTEND_ACTION_TIMEOUT_MARGIN_MS if timeout else None,
            )

            # BT-13: 对 params 做脱敏处理，避免日志泄露密码/token 等敏感信息
            safe_params_keys = list(params.keys()) if isinstance(params, dict) else "N/A"
            logger.info(
                "[FrontendDispatcher] Published frontend action\n"
                "  topic: %s\n"
                "  action: %s\n"
                "  task_id: %s\n"
                "  params_keys: %s\n"
                "  publish_result: %s",
                topic, action_type, task_id, safe_params_keys, published_count
            )

            if published_count == 0:
                if _should_probe_publish_failure(action_type):
                    publish_failure = self._wait_for_result(
                        thread_id,
                        task_id,
                        1,
                        action_type=action_type,
                        synthesize_timeout=False,
                        cancel_event=cancel_event,
                    )
                    if isinstance(publish_failure, dict) and publish_failure.get("error_code"):
                        return publish_failure
                    video_delivery_failure = _device_only_publish_failure_payload(action_type)
                    if video_delivery_failure is not None:
                        return video_delivery_failure
                logger.warning(
                    "[FrontendDispatcher] WS event not published, "
                    "check channel layer config and connection: %s",
                    topic
                )
                return {
                    'success': False,
                    'error': (
                        f'No active client subscribed to {topic}. '
                        'The Electron app may be disconnected or the chat session is not active.'
                    ),
                }

        except redis.ConnectionError as e:
            logger.error("[FrontendDispatcher] Redis connection failed: %s", e, exc_info=True)
            return {
                'success': False,
                'error': f'Redis connection failed, check Redis service: {str(e)}'
            }
        except Exception as e:
            logger.error(
                "[FrontendDispatcher] Redis publish failed: %s | thread_id=%s task_id=%s action=%s",
                e, thread_id, task_id, action_type, exc_info=True,
            )
            return {
                'success': False,
                'error': f'Failed to publish task: {str(e)}'
            }

        # 4. 阻塞等待前端上报结果
        result = self._wait_for_result(
            thread_id,
            task_id,
            timeout,
            action_type=action_type,
            cancel_event=cancel_event,
        )

        return result

    def _wait_for_result(
        self,
        thread_id: str,
        task_id: str,
        timeout: int,
        action_type: Optional[str] = None,
        synthesize_timeout: bool = True,
        cancel_event=None,
    ) -> Dict[str, Any]:
        """
        等待前端上报结果（使用 BRPOP 阻塞等待）

        前端通过 WS Gateway 发送 agent.action.result
        结果会存储在 Redis: agent:result:{thread_id}:{task_id}

        Args:
            thread_id: 会话 ID
            task_id: 任务 ID
            timeout: 超时时间（秒）

        Returns:
            {
                "success": True/False,
                "data": {...},
                "error": "..."
            }
        """
        # 构建 Redis key（仅支持标准前缀）
        key_candidates = [self._service.build_result_key(thread_id, task_id)]

        logger.info(
            "[FrontendDispatcher] Waiting for frontend result\n"
            "  listening keys: %s\n"
            "  timeout: %ss",
            key_candidates, timeout
        )

        try:
            result_data = self._service.wait_for_result(thread_id, task_id, timeout, cancel_event=cancel_event)
            if result_data is None:
                # 超时
                logger.error(
                    "[FrontendDispatcher] Timeout: frontend did not respond within %ss (task_id=%s)",
                    timeout, task_id
                )
                if synthesize_timeout and action_type:
                    device_timeout = _device_only_timeout_payload(action_type, timeout)
                    if device_timeout is not None:
                        return device_timeout
                return {
                    'success': False,
                    'error': f'Frontend action timed out ({timeout}s), check if Electron is running. Device may return result after reconnecting.'
                }

            key_used = key_candidates[0]

            logger.info(
                "[FrontendDispatcher] Received frontend result\n"
                "  key: %s\n"
                "  success: %s\n"
                "  data_size: %s bytes",
                key_used,
                result_data.get('success'),
                len(json.dumps(result_data))
            )

            return result_data

        except redis.ConnectionError as e:
            logger.error("[FrontendDispatcher] Redis connection failed: %s", e, exc_info=True)
            return {
                'success': False,
                'error': f'Redis connection failed, cannot wait for frontend result: {str(e)}'
            }

        except redis.TimeoutError as e:
            logger.error("[FrontendDispatcher] Redis timeout: %s", e)
            return {
                'success': False,
                'error': f'Redis operation timed out: {str(e)}'
            }

        except json.JSONDecodeError as e:
            logger.error("[FrontendDispatcher] JSON parse failed: %s", e)
            return {
                'success': False,
                'error': f'Failed to parse result: {str(e)}'
            }

        except Exception as e:
            logger.error(
                "[FrontendDispatcher] Error waiting for result: %s | thread_id=%s task_id=%s",
                e, thread_id, task_id, exc_info=True,
            )
            return {
                'success': False,
                'error': f'Error waiting for result: {str(e)}'
            }


# ==================== 单例访问 ====================

_dispatcher_instance: Optional[FrontendActionDispatcher] = None


def get_frontend_dispatcher() -> FrontendActionDispatcher:
    """
    获取前端动作调度器单例

    Returns:
        FrontendActionDispatcher 实例

    Example:
        >>> dispatcher = get_frontend_dispatcher()
        >>> result = dispatcher.dispatch_action(...)
    """
    global _dispatcher_instance
    if _dispatcher_instance is None:
        _dispatcher_instance = FrontendActionDispatcher()
    return _dispatcher_instance


__all__ = [
    'FrontendActionDispatcher',
    'get_frontend_dispatcher',
]
