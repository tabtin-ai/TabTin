"""
TabData API 路由注册

所有端点实现已拆分到各 api_*.py 子模块中：
  - api_table.py          Table CRUD、统计、搜索索引
  - api_field.py          Field CRUD、类型转换、关联查询
  - api_record.py         Record CRUD、批量操作
  - api_comment.py        记录详情内部评论
  - api_view.py           View CRUD、视图数据查询
  - api_import_export.py  导入/导出
  - api_attachment.py     附件上传/管理
  - api_health.py         Celery 健康检查
  - api_undo_redo.py      撤销/重做/历史
  - api_agent_sql.py      Agent SQL
  - api_sub_record.py     子记录
"""
from ninja import Router

# 创建 TabData API 主路由
router = Router(tags=["TabData"])

# ── 业务域子路由（新拆分） ──────────────────────────────────
from apps.tabdata.api_table import router as table_router
from apps.tabdata.api_field import router as field_router
from apps.tabdata.api_record import router as record_router
from apps.tabdata.api_comment import router as comment_router
from apps.tabdata.api_view import router as view_router
from apps.tabdata.api_import_export import router as import_export_router
from apps.tabdata.api_attachment import router as attachment_router

router.add_router("", table_router)
router.add_router("", field_router)
router.add_router("", record_router)
router.add_router("", comment_router)
router.add_router("", view_router)
router.add_router("", import_export_router)
router.add_router("", attachment_router)

# ── 表单视图公开路由 ──────────────────────────────────────────
from apps.tabdata.api_form import router as form_router
router.add_router("", form_router)

# 协作路由已迁移到统一 Collab API (/api/collab/v1/table/...)

# ── Token 管理路由 ──────────────────────────────────────────
from apps.tabdata.api_token import router as token_router
router.add_router("", token_router)

# Legacy Open API 路由已迁移至 api_open_space.py（/api/open/v1/spaces/{space_id}/data/...）
# 以下 Storage / Connector / Analytics 路由仍挂载在 /api/tabdata/open/v1/，待后续迁移

from apps.tabdata.api_open_storage import router as open_storage_router
router.add_router("/open/v1", open_storage_router)

# ── Connector 路由（Open API 下） ────────────────────────
from apps.tabdata.api_connector import router as connector_router
router.add_router("/open/v1", connector_router)

# ── Analytics 路由（Open API 下） ─────────────────────────
from apps.tabdata.api_analytics import router as analytics_router
router.add_router("/open/v1", analytics_router)

# ── 已有子路由（保持不变） ──────────────────────────────────
from apps.tabdata.api_health import router as health_router   # noqa: E402
from apps.tabdata.api_undo_redo import router as undo_redo_router          # noqa: E402
from apps.tabdata.api_agent_sql import router as agent_sql_router          # noqa: E402
from apps.tabdata.api_sub_record import router as sub_record_router        # noqa: E402

router.add_router("", undo_redo_router)
router.add_router("", agent_sql_router)
router.add_router("/sub-records", sub_record_router)

# ── A3 update-by-filter（Wave 2）──────────────────────────────────
from apps.tabdata.api_update_by_filter import router as update_by_filter_router  # noqa: E402
router.add_router("", update_by_filter_router)
