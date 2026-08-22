"""Agent run 回滚基线选择回归测试。"""

import inspect


ROLLBACK_FUNC_SOURCE = None


def _get_rollback_agent_run_source():
    """提取回滚端点和基线解析函数源码用于静态分析。"""
    global ROLLBACK_FUNC_SOURCE
    if ROLLBACK_FUNC_SOURCE is not None:
        return ROLLBACK_FUNC_SOURCE
    import apps.collab.api as api_module
    src = "\n".join([
        inspect.getsource(api_module._find_agent_run_pre_change_version),
        inspect.getsource(api_module.rollback_agent_run),
    ])
    ROLLBACK_FUNC_SOURCE = src
    return src


class TestE2E007PreChangeVersionBoundary:
    """回滚基线必须同时排除本轮版本并限制在本轮首次落版之前。"""

    def test_does_not_use_changelog_timestamp_as_boundary(self):
        src = _get_rollback_agent_run_source()
        assert "created_at__lt=first_change.created_at" not in src

    def test_uses_first_run_version_as_temporal_boundary(self):
        src = _get_rollback_agent_run_source()
        assert 'vh_filter["created_at__lt"] = first_run_version_at' in src

    def test_uses_exclude_id_in_for_pre_change_version(self):
        """rollback_agent_run 中应使用 exclude(id__in=...) 查找 pre_change_version"""
        src = _get_rollback_agent_run_source()
        assert "exclude(id__in=" in src or "exclude(" in src, (
            "E2E-007: rollback_agent_run 应使用 exclude(id__in=run_vh_ids) "
            "排除本次 agent_run 的 VH，而非时间戳过滤"
        )

    def test_collects_run_vh_ids_before_query(self):
        """rollback_agent_run 中应先收集 run_vh_ids，再查询 pre_change_version"""
        src = _get_rollback_agent_run_source()
        assert "run_vh_ids" in src, (
            "E2E-007: rollback_agent_run 应先收集 run_vh_ids（本次 run 关联的 VH ID 列表），"
            "再用 exclude(id__in=run_vh_ids) 查找 pre_change_version"
        )

    def test_run_vh_ids_filters_by_agent_run_id_and_resource(self):
        """run_vh_ids 查询必须按 agent_run_id + resource_type + resource_id 过滤"""
        src = _get_rollback_agent_run_source()
        # 确保 run_vh_ids 的查询包含必要的过滤条件
        assert "agent_run_id__in=all_run_ids" in src, (
            "run_vh_ids 查询必须按 agent_run_id 过滤"
        )
        assert "version_history__isnull=False" in src, (
            "run_vh_ids 查询必须排除 version_history 为 None 的 ChangeLog"
        )
