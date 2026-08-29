# BYOK 多连接隔离回归（PR4）

## 验到哪

- Electron 主对话：`POST /api/llm/proxy`，`body.model` = Model UUID → `LLMModel.provider` FK。
- Adapter / Billing / Failover Key：源码 + Resolver 断言。
- Service / Scene 旁路：`get_llm_service` degraded 切池、`model_name` 轮询，只审计不改。

## 复跑

```bash
python3 scripts/verify-byok-cross-connection.py

# 有 Django venv 时
cd apps/tabtin_django
USE_SQLITE_FOR_TESTS=0 python manage.py test apps.services.llm.tests.test_cross_connection_isolation apps.services.llm.tests.test_adapter_resolver
```

## 上次结果（2026-08-24）

- 本 worktree 无 Django venv，未跑 `manage.py test`。
- `python3 scripts/verify-byok-cross-connection.py`：Adapter 四条身份通过；Proxy 主路径不按健康度换连接。
- 已登记旁路风险：factory degraded 切池、routing_pool 仅 model_name、capability_guard name union、Scene `model_name` 回退。

## 未覆盖

- 未打真实 OpenRouter / SiliconFlow HTTP。
- 未在 live DB 插入两套连接做端到端调用。
- 未覆盖 Daemon。
