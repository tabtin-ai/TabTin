"""
api_open_impl - Open API 业务实现模块

按领域拆分:
  common.py       共享常量与辅助函数
  table_impl.py   表格 CRUD + 开发者合约 + OpenAPI Spec
  field_impl.py   字段 CRUD
  view_impl.py    视图 CRUD
  policy_impl.py  行级安全策略
  record_impl.py  记录查询、CRUD、批量操作、Upsert
  exchange_impl.py  导入导出 (JSON / CSV / Excel / PDF)
  db_conn_impl.py   数据库连接管理
  webhook_impl.py   Webhook CRUD + 测试
"""
