"""
Checkpoint 回滚事件信号

Charter §4.1：Checkpoint 模块发布 ``before_checkpoint_rollback`` 事件，
所有参与模块（tabdata 等）订阅。

Wave 2 C5：基础设施就绪，tabdata handler 先注册但当前无 Outbox 可暂停。
Wave 3 D1：Outbox 上线后 tabdata handler 激活 PauseRegistry 逻辑。
"""

from django.dispatch import Signal

# Checkpoint 回滚前事件
# kwargs: checkpoint_id (UUID), space_id (UUID), version_refs (dict),
#         initiator_user_id (str), initiator_editor_type (str)
before_checkpoint_rollback = Signal()
