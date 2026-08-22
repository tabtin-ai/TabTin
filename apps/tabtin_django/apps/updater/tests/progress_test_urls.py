"""仅挂载 updater 公开 API 的测试 urls（配合 settings_updater_progress_test）。"""
from django.urls import path
from ninja import NinjaAPI

from apps.updater.api import router as updater_public_router
from apps.updater.mobile_gate_api import router as mobile_gate_router

api = NinjaAPI()
api.add_router("/updates", updater_public_router)
api.add_router("/client", mobile_gate_router)

urlpatterns = [
    path("api/", api.urls),
]
