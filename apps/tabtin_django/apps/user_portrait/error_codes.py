"""
User Portrait 错误码定义 + Service 错误异常。

继承通用错误码，仅添加 USER 画像特有的错误码。
ServiceError 在本 app 内独立定义（不依赖 tabtinspace）——UserPortrait 是 user 级资源，
与 Organization / Space 解耦，单测可以脱离 tabtinspace 依赖独立运行。
"""

from typing import Any, Dict, Optional

from apps.services.common.error_codes import CommonErrorCode


class ErrorCode(CommonErrorCode):
    """User Portrait 错误码常量"""

    PORTRAIT_NOT_FOUND = "PORTRAIT_NOT_FOUND"
    INVALID_HINT = "INVALID_HINT"
    INVALID_ORGANIZATION_ID = "INVALID_ORGANIZATION_ID"
    INVALID_AGENT_ID = "INVALID_AGENT_ID"  # /#4118 画像 per-Agent 化：缺失/非法 agent_id
    INVALID_INPUT = "INVALID_INPUT"  # 跟 tabmemo 命名习惯保持一致
    # 记忆总闸关闭时 hint/distill 写入被拒——与 agent_memory 域 RECORD_DISABLED
    # 同语义（状态冲突，用 409），避免复用 INVALID_INPUT 让前端按 code 取到
    # "提交内容有误"的错文案。
    MEMORY_DISABLED = "MEMORY_DISABLED"
    AGENT_ACCESS_DENIED = "AGENT_ACCESS_DENIED"  # 非该 Agent owner（区别于非组织成员）
    DISTILL_IN_PROGRESS = "DISTILL_IN_PROGRESS"
    DISTILL_FAILED = "DISTILL_FAILED"


class ServiceError(Exception):
    """User Portrait Service 层结构化错误。

    与 tabtinspace.services.base.ServiceError 接口签名兼容（code / message / status / data），
    便于 API 层用同样的方式映射为 HTTP 响应。
    单独定义是为了让 user_portrait 这个 user 级 app 不依赖 tabtinspace。
    """

    def __init__(
        self,
        code: str,
        message: str = "",
        status: int = 400,
        data: Optional[Dict[str, Any]] = None,
    ):
        self.code = code
        self.message = message
        self.status = status
        self.data = data
        super().__init__(message or code)
