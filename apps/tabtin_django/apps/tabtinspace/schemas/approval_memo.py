"""Tabtin Space approval_memo schemas（PRD 05 v0.4 §7.3）。"""

from .common import *  # noqa: F401,F403


class ApprovalMemoEntry(BaseModel):
    """单条 always memo 条目（PRD §7.3 schema）。"""

    decision: Literal["allow", "deny"] = Field(..., description="始终允许 / 始终拒绝")
    created_at: int = Field(..., description="创建时间 unix_ms")
    updated_at: int = Field(..., description="更新时间 unix_ms")
    approver_user_id: str = Field(..., description="决策做出者 user_id")
    reason: str = Field(default="", description="rejection_message 或备注")
    # M4.1 L-W6-24：用户看到的业务名（如"总是允许向远程仓库推送代码"）；
    # UI 优先展示此字段，缺失时回退到 pattern_key。
    scope_description: str = Field(default="", description="用户可读的记忆业务名")


class ApprovalMemoOut(BaseModel):
    """GET /api/agents/{id}/approval-memo 响应主体。"""

    version: int = Field(..., description="schema 版本号（当前 1）")
    entries: Dict[str, ApprovalMemoEntry] = Field(
        default_factory=dict,
        description="条目 dict：key='<namespace>::<tool_name>::<pattern_key>'",
    )
    generation: int = Field(
        default=0,
        description="generation 计数器；客户端比对失效缓存（PRD §8.1.2）",
    )


class ApprovalMemoEntryUpdate(BaseModel):
    """PUT /api/agents/{id}/approval-memo/{entry_key} 请求体。"""

    decision: Literal["allow", "deny"] = Field(...)
    reason: str = Field(default="", max_length=2000)
    # M4.1 L-W6-24：用户可读的业务名；前端 buildScopeDescription 生成并上行。
    scope_description: str = Field(default="", max_length=500)


# 409 Conflict 响应说明（PRD §8.1.2）：
#
# 路由层走 i18n.response.error_response_with_status，响应 body 形态为：
# {
#   "success": false,
#   "code": "GENERATION_CONFLICT",
#   "message": "approval memo generation conflict",
#   "data": { "current_generation": <int> }
# }
#
# 客户端按 ``code === 'GENERATION_CONFLICT'`` 判定，按 ``data.current_generation``
# 重新拉 memo + 重写 If-Match 头后重试。
# 不在此处定义独立 ApprovalMemoConflict schema —— 沿用项目统一 ErrorResponse 形态
# 减少 schema 双源风险（Review 一 WARNING #1 自修复）。


__all__ = [
    "ApprovalMemoEntry",
    "ApprovalMemoOut",
    "ApprovalMemoEntryUpdate",
]
