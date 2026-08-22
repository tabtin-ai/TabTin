"""
Traceable LangChain Tool Base — services 独立层

为 LangChain BaseTool 提供统一 Trace 记录能力。
trace 相关功能通过模块级回调注入，默认 None = 不记录。
orchestration 层在 AppConfig.ready() 中注入真实实现。

Migration note:
    从 orchestration.tools._traceable 迁移而来。
    原模块保留 re-export shim 以兼容 orchestration 内部引用。
"""

import time
from typing import Any, Callable, Optional

from langchain_core.tools import BaseTool

# ---------------------------------------------------------------------------
# Trace 回调注入点
# ---------------------------------------------------------------------------
# 设置后由 TraceableBaseTool.__init_subclass__ 包装器在运行时读取。
# None 表示不记录 trace（安全降级）。

_trace_start_event_fn: Optional[Callable[..., Optional[str]]] = None
_trace_end_event_fn: Optional[Callable[..., None]] = None
_trace_get_parent_event_id_fn: Optional[Callable[[], Optional[str]]] = None
_trace_sanitize_fn: Optional[Callable[[Any], Any]] = None


def set_trace_callbacks(
    *,
    start_event: Optional[Callable[..., Optional[str]]] = None,
    end_event: Optional[Callable[..., None]] = None,
    get_parent_event_id: Optional[Callable[[], Optional[str]]] = None,
    sanitize: Optional[Callable[[Any], Any]] = None,
) -> None:
    """注入 trace 回调。由 orchestration 层在启动时调用。"""
    global _trace_start_event_fn, _trace_end_event_fn
    global _trace_get_parent_event_id_fn, _trace_sanitize_fn
    if start_event is not None:
        _trace_start_event_fn = start_event
    if end_event is not None:
        _trace_end_event_fn = end_event
    if get_parent_event_id is not None:
        _trace_get_parent_event_id_fn = get_parent_event_id
    if sanitize is not None:
        _trace_sanitize_fn = sanitize


def _sanitize(data: Any) -> Any:
    """对 trace 数据脱敏。未注入时原样返回。"""
    fn = _trace_sanitize_fn
    if fn is not None:
        return fn(data)
    return data


class TraceableBaseTool(BaseTool):
    """在 LangChain BaseTool 上增加 DB Trace 记录（通过可选回调）。

    当 trace 回调未注入时，__init_subclass__ 包装的 _run/_arun
    仍正常执行业务逻辑，只是跳过 trace 记录。
    """

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)

        original_run = cls.__dict__.get("_run")
        if original_run and not getattr(original_run, "_trace_wrapped", False):
            _wrap_run(cls, original_run)

        original_arun = cls.__dict__.get("_arun")
        if original_arun and not getattr(original_arun, "_trace_wrapped", False):
            _wrap_arun(cls, original_arun)


def _wrap_run(cls, original_run):
    """包装同步 _run 添加 trace 记录。"""

    def wrapped_run(self, *args: Any, **kwargs: Any) -> Any:
        start_fn = _trace_start_event_fn
        end_fn = _trace_end_event_fn
        get_parent_fn = _trace_get_parent_event_id_fn

        start_time = time.monotonic()
        event_id = None
        filtered_kwargs = {
            k: v for k, v in kwargs.items() if k not in ("callbacks", "run_manager")
        }
        tool_meta = {
            "app_id": getattr(self, "app_id", None),
            "execution_target": (
                getattr(self, "execution_target", None)
                or getattr(self, "execution_mode", None)
            ),
            "optional": getattr(self, "optional", None),
            "required_permissions": getattr(self, "required_permissions", None),
        }

        if start_fn:
            sanitized_input = _sanitize(
                {"args": args, "kwargs": filtered_kwargs, "tool_meta": tool_meta}
            )
            parent_event_id = get_parent_fn() if get_parent_fn else None
            event_id = start_fn(
                event_type="tool",
                name=self.name,
                input_data=sanitized_input,
                parent_event_id=parent_event_id,
                publish_start=True,
            )

        try:
            result = original_run(self, *args, **kwargs)
        except Exception as exc:
            if end_fn:
                end_fn(
                    event_id=event_id,
                    output_data=None,
                    error=str(exc),
                    started_monotonic=start_time,
                )
            raise

        if end_fn:
            end_fn(
                event_id=event_id,
                output_data=_sanitize({"result": result}),
                error=None,
                started_monotonic=start_time,
            )
        return result

    wrapped_run._trace_wrapped = True
    cls._run = wrapped_run


def _wrap_arun(cls, original_arun):
    """包装异步 _arun 添加 trace 记录。"""

    async def wrapped_arun(self, *args: Any, **kwargs: Any) -> Any:
        start_fn = _trace_start_event_fn
        end_fn = _trace_end_event_fn
        get_parent_fn = _trace_get_parent_event_id_fn

        start_time = time.monotonic()
        event_id = None
        filtered_kwargs = {
            k: v for k, v in kwargs.items() if k not in ("callbacks", "run_manager")
        }
        tool_meta = {
            "app_id": getattr(self, "app_id", None),
            "execution_target": (
                getattr(self, "execution_target", None)
                or getattr(self, "execution_mode", None)
            ),
            "optional": getattr(self, "optional", None),
            "required_permissions": getattr(self, "required_permissions", None),
        }

        if start_fn:
            sanitized_input = _sanitize(
                {"args": args, "kwargs": filtered_kwargs, "tool_meta": tool_meta}
            )
            parent_event_id = get_parent_fn() if get_parent_fn else None
            event_id = start_fn(
                event_type="tool",
                name=self.name,
                input_data=sanitized_input,
                parent_event_id=parent_event_id,
                publish_start=True,
            )

        try:
            result = await original_arun(self, *args, **kwargs)
        except Exception as exc:
            if end_fn:
                end_fn(
                    event_id=event_id,
                    output_data=None,
                    error=str(exc),
                    started_monotonic=start_time,
                )
            raise

        if end_fn:
            end_fn(
                event_id=event_id,
                output_data=_sanitize({"result": result}),
                error=None,
                started_monotonic=start_time,
            )
        return result

    wrapped_arun._trace_wrapped = True
    cls._arun = wrapped_arun


__all__ = ["TraceableBaseTool", "set_trace_callbacks"]
