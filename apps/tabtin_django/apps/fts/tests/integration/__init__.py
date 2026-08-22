"""集成测试目录（不走 pytest）。

这些脚本连接真实 MySQL + PostgreSQL + Redis + ES，用于手动验证：
    - `verify_outbox_migration.py`（Wave 0 保留）
    - `test_end_to_end_sync.py`（Wave 1 新增）

pytest 下不自动采集（用 `--ignore=apps/fts/tests/integration`）。
"""
