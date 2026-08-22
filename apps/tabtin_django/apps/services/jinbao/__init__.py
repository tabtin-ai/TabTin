"""进宝 Echo 机器人（dev_only）

dev 环境用的 Echo 机器人，给每个 TEAM organization 自动塞一个固定 User「进宝」，
用户发任何消息进宝都把内容回声（加 🔁 前缀）发回。

启用条件：env `ENABLE_JINBAO_BOT=true`，apps.py.ready() 内决定是否注册 signals。
关闭时 zero overhead。
"""

default_app_config = 'apps.services.jinbao.apps.JinbaoConfig'
