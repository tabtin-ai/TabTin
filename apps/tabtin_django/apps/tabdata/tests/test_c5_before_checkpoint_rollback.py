"""C5 before_checkpoint_rollback 通用信号基础设施测试。

TabData 的专用 checkpoint rollback handler 已随退役能力删除；这里仅验证
信号本身、无接收器场景，以及接收器异常隔离语义。
"""

from uuid import uuid4


class TestBeforeCheckpointRollbackSignal:
    """before_checkpoint_rollback 信号基础设施测试。"""

    def test_signal_exists(self):
        """信号模块可导入。"""
        from apps.collab.checkpoint_signals import before_checkpoint_rollback

        assert before_checkpoint_rollback is not None

    def test_no_handler_does_not_break_signal(self):
        """无 handler 注册时信号发出不报错。"""
        from apps.collab.checkpoint_signals import before_checkpoint_rollback

        temp_receivers = before_checkpoint_rollback.receivers[:]
        before_checkpoint_rollback.receivers = []

        try:
            responses = before_checkpoint_rollback.send_robust(
                sender=self.__class__,
                checkpoint_id=uuid4(),
                space_id=uuid4(),
                version_refs={},
                initiator_user_id="",
                initiator_editor_type="system",
            )
            assert responses == []
        finally:
            before_checkpoint_rollback.receivers = temp_receivers

    def test_handler_exception_does_not_propagate(self):
        """接收器异常不阻断 send_robust（Django signal 保证）。"""
        from apps.collab.checkpoint_signals import before_checkpoint_rollback

        def buggy_handler(sender, **kwargs):
            raise RuntimeError("deliberate test error")

        before_checkpoint_rollback.connect(
            buggy_handler,
            dispatch_uid="test_c5_buggy",
        )
        try:
            responses = before_checkpoint_rollback.send_robust(
                sender=self.__class__,
                checkpoint_id=uuid4(),
                space_id=uuid4(),
                version_refs={},
            )
            errors = [result for _, result in responses if isinstance(result, Exception)]
            assert len(errors) >= 1
            assert isinstance(errors[0], RuntimeError)
        finally:
            before_checkpoint_rollback.disconnect(
                buggy_handler,
                dispatch_uid="test_c5_buggy",
            )
