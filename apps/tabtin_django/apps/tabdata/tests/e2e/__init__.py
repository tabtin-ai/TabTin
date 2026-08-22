"""Wave 1.5 E2E 测试套件 — 真表 prod-mode E2E 验收。

本目录下的所有测试都依赖 ``RUN_PROD_MODE_FIXTURE_TESTS=1`` 环境变量
启用真实 dev DB(MySQL + PostgreSQL)+ ``apps.tabtinspace.tests.fixtures``
的 Organization → Agent → workspace 完整链路 fixture(L24.2 修复后可用)。

CI 接入(D23 决策):nightly job 必须设 ``RUN_PROD_MODE_FIXTURE_TESTS=1``
跑本目录全量测试,默认 PR 流水线 skip(避免每次 PR 跑 prod-mode 太慢)。

测试覆盖(对应 PRD §八 L1097-1119)
-------------------------------------

- ``test_w1_5_e2e_3_field_undo.py`` — E2E-3 字段 undo(11 简单 + 4 复杂)
- ``test_w1_5_e2e_4_record_restore.py`` — E2E-4 记录恢复(新软删 + 老软删兜底)
- ``test_w1_5_e2e_5_table_delete_clean.py`` — E2E-5 删表干净(5s 内 worker 停止报错)
- ``test_w1_5_e2e_6_formula_short_circuit.py`` — E2E-6 公式短路(可能记录 W1.5 退出 gap)

D24 决策:E2E-1 必须包含真实 link junction 拓扑(走 LinkFieldService.set_link_cell
而非 bulk_create 直写 link cell)至少 1 轮。

E2E-2(update-by-filter)推 Wave 2,E2E-7(Outbox 可观测)推 Wave 3,
本期不实施。
"""
