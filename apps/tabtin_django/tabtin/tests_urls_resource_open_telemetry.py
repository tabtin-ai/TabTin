"""
Wave 7「Agent 产物在 Space 内的打开」专题 — ResourceOpenTelemetry endpoint
集成测试专用 URLConf。

为何独立 URLConf（与 ``settings_resource_open_telemetry_test.py`` 配套）：

- 主 ``tabtin/urls.py`` import 整条 deferred router 链（45+ 子 app router），
  会拉起 tabdata / payment / billing / channel_gateway 等几十个模块的 import；
  任何一个 import 失败（如缺 PG 扩展） test 启动就 crash
- 本测试只需要 ``telemetry_resource_open_api`` 这一个 router，独立 URLConf 让
  测试启动 < 1s 且不被无关 import 影响

URL 形态与生产环境对齐：
  - 生产：``urls_deferred.py`` 注册 ``/services/telemetry`` + router 内 path
    ``/resource-open/batch`` → ``/api/services/telemetry/resource-open/batch``
  - 本测试：同形态 ``/api/services/telemetry/resource-open/batch`` 让测试 client
    POST 路径与生产 100% 一致
"""
from __future__ import annotations

from django.urls import path
from ninja import NinjaAPI

from apps.services.agent_engine.api.telemetry_resource_open_api import (
    router as telemetry_router,
)


_test_api = NinjaAPI(urls_namespace="resource_open_telemetry_test")
_test_api.add_router("/services/telemetry", telemetry_router)


urlpatterns = [
    path("api/", _test_api.urls),
]
