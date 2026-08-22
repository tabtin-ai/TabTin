"""Tabtin Space router shim.

新代码请直接从 `apps.tabtinspace.routers` 导入。
"""

# 仅保留 urls.py 使用的 router 聚合入口。
# 新接口请写到 `routers/` 对应子域模块中，不要在本文件新增 re-export。
from .routers import router

__all__ = ["router"]
