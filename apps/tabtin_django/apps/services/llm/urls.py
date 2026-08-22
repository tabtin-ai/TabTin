"""
LLM 服务 URL 配置

Admin API 已迁移到 Ninja Router（BI-6），通过 tabtin/urls.py 中的
_safe_add_router("/auth/admin", llm_admin_router) 注册。
"""

app_name = 'llm'

urlpatterns = []

