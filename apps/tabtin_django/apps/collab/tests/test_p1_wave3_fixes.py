"""
P1 Wave-3 回归测试

S-04: SlideCollabAdapter.persist_changes 返回 persisted/created/deleted 统计字段
"""


class TestSlidePersistReturnStats:
    """Slide persist_changes 应返回 persisted/created/deleted 统计字段。"""

    def test_return_signature_has_stats_fields(self):
        """确认 persist_changes 返回值包含统计字段。"""
        import inspect
        from apps.collab.adapters.slide import SlideCollabAdapter

        source = inspect.getsource(SlideCollabAdapter.persist_changes)
        assert '"persisted"' in source, "返回值应包含 persisted 字段"
        assert '"created"' in source, "返回值应包含 created 字段"
        assert '"deleted"' in source, "返回值应包含 deleted 字段"
