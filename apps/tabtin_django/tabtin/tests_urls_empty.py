"""空 URLConf，供 settings_*_test.py 系列测试 settings 使用。

W1.1 / 统一审批的 ApprovalMemo 单测不走 HTTP，无需真实路由——
但 Django 的 system check 会要求 ROOT_URLCONF 可解析。
"""
urlpatterns: list = []
