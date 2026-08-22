"""
Multiagent exceptions.
"""


class RunCancelledError(RuntimeError):
    """运行被取消时抛出。"""

    partial_reply: str = ""
    partial_run_id: str | None = None

    def __init__(
        self,
        message: str = "",
        *,
        partial_reply: str = "",
        partial_run_id: str | None = None,
    ):
        super().__init__(message)
        self.partial_reply = partial_reply
        self.partial_run_id = partial_run_id


__all__ = ["RunCancelledError"]
