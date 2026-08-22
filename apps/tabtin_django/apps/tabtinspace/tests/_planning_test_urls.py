"""空 URL 配置，专供 settings_planning_test 使用。

避开 tabtin.urls 链路下的非必需 app（chat/conversation 等）的 model 加载。
"""
urlpatterns: list = []
