from typing import Any, Optional

from apps.services.common.error_codes import CommonErrorCode


class ErrorCode(CommonErrorCode):
    INVALID_SCOPE = "AGENT_MEMORY_INVALID_SCOPE"
    AGENT_NOT_FOUND = "AGENT_MEMORY_AGENT_NOT_FOUND"
    AGENT_ACCESS_DENIED = "AGENT_MEMORY_AGENT_ACCESS_DENIED"
    SPACE_ACCESS_DENIED = "AGENT_MEMORY_SPACE_ACCESS_DENIED"
    AGENT_NOT_RESOLVED = "AGENT_MEMORY_AGENT_NOT_RESOLVED"
    MEMORY_NOT_FOUND = "AGENT_MEMORY_NOT_FOUND"
    INVALID_CONTENT = "AGENT_MEMORY_INVALID_CONTENT"
    INVALID_CURSOR = "AGENT_MEMORY_INVALID_CURSOR"
    RECORD_DISABLED = "AGENT_MEMORY_RECORD_DISABLED"


class ServiceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        data: Optional[dict[str, Any]] = None,
    ):
        self.code = code
        self.message = message
        self.status = status
        self.data = data
        super().__init__(message or code)
