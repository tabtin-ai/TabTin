"""
测试用 URL 配置

直接复用主 NinjaAPI 实例（tabtin/urls.py 中的 api），
因为 Django Ninja Router 只能 attach 到一个 API 实例。
"""
from django.urls import path
from tabtin.urls import api

urlpatterns = [
    path('api/', api.urls),
]
