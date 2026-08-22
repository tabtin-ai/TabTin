"""IM 任务共享编排子域（session_share）。

共享授权本体在 chat.conversation 域（SessionShare 模型 + session_share_service）；
本子域只做 IM 侧编排：建 DM、发 session_share 卡、回填卡片锚点、撤销后刷卡广播。
依赖方向恒为 tabchat → conversation，conversation 域不 import tabchat。
"""
