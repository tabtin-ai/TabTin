"""
LLM 管理员 API（Superuser）— 路由入口

端点实现已按功能域拆分至：
- api_admin_providers.py  — Provider CRUD + Runtime + 探测（12 端点）
- api_admin_models.py     — Model CRUD + 工作空间模型管理（7 端点）
- api_admin_observability.py — 审计日志 + 用量统计 + 预算 + 告警 + CSV 导出（11 端点）
- admin/scenes_router.py     — Scene 中心 API（v0.1 新加）
- admin/prompts_router.py    — Prompt 只读 API（v0.1 新加）
- admin/embedding_router.py  — Embedding 配置 API（v0.1 新加）
- admin/multimodal_router.py — 多模态聚合 API（v0.1 新加）
- admin/incident_router.py   — 应急中心 API（v0.1 新加）
- admin/agent_config_router.py — Agent 产品配置 API（v0.1 新加）

共用辅助函数位于 api_admin_utils.py。
"""

from ninja import Router

from .api_admin_providers import router as _providers_router
from .api_admin_models import router as _models_router
from .api_admin_observability import router as _observability_router
from .admin.scenes_router import router as _scenes_router
from .admin.prompts_router import router as _prompts_router
from .admin.embedding_router import router as _embedding_router
from .admin.multimodal_router import router as _multimodal_router
from .admin.incident_router import router as _incident_router
from .admin.agent_config_router import router as _agent_config_router

router = Router()
router.add_router("", _providers_router)
router.add_router("", _models_router)
router.add_router("", _observability_router)
router.add_router("", _scenes_router)
router.add_router("", _prompts_router)
router.add_router("", _embedding_router)
router.add_router("", _multimodal_router)
router.add_router("", _incident_router)
router.add_router("", _agent_config_router)
