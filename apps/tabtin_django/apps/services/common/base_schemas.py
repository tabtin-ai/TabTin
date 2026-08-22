"""
通用 API 响应 Schema

所有模块统一使用的请求/响应数据结构。
基于 Pydantic，兼容 django-ninja 的 Schema。

响应信封格式:
{
    "success": true,
    "code": "SUCCESS",
    "message": "操作成功",
    "data": { ... }
}
"""

from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class StandardResponse(BaseModel, Generic[T]):
    """
    标准响应模型 — 所有 API 统一使用此格式

    Usage:
        # 在 django-ninja 路由中
        @router.get("/items", response=StandardResponse[ItemOut])
        def list_items(request):
            return StandardResponse(success=True, data=[...])
    """

    success: bool = Field(..., description="操作是否成功")
    code: str = Field(default="SUCCESS", description="业务状态码")
    message: str = Field(default="操作成功", description="响应消息")
    data: Optional[T] = Field(default=None, description="响应数据")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "success": True,
                "code": "SUCCESS",
                "message": "操作成功",
                "data": {},
            }
        }
    )


class ErrorResponse(BaseModel):
    """错误响应模型"""

    success: bool = Field(default=False, description="操作失败")
    code: str = Field(..., description="错误码")
    message: str = Field(..., description="错误消息")
    data: Optional[Any] = Field(default=None, description="错误详情")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "success": False,
                "code": "VALIDATION_ERROR",
                "message": "数据验证失败",
                "data": None,
            }
        }
    )
