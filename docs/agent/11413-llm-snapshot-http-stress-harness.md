# #11413 LLM 快照 HTTP 压测

打本机 Daphne `6060` 的 `POST /api/chat/sessions/{id}/llm-snapshots`，不走 Django test client。用来看并发 insert、同键 update、以及高峰时会话读取 / persist 是否被拖慢。

## 复跑

本地 Django 必须 `healthy`，并且已加载本 PR 的 HTTP 口。

```bash
curl -sf http://127.0.0.1:6060/health
cd apps/tabtin_django && ./venv/bin/python manage.py shell -c \
  "exec(open('../../scripts/llm-snapshot-http-stress.py').read())"
```

脚本：`scripts/llm-snapshot-http-stress.py`。夹具前缀 `11413-stress-`，结束会清理。

## 场景

| 场景 | 在验什么 |
|---|---|
| `baseline_*` | 空载小快照 POST、会话 GET、persist 写入 |
| `concurrent_unique_small` | 64 个不同 `runId`，16 并发 |
| `concurrent_same_key_insert_race` | 24 个请求打同一 `(session, run, iteration)` |
| `concurrent_request_then_response_update` | 32 对先 request 后 response，覆盖同键 update |
| `concurrent_unique_fat` | 24 个约 400KB 快照，8 并发 |
| `canary_*_during_fat` | 大快照高峰时会话 GET（Daphne 同步口）和 persist 写库（只抢 PG） |

## 上次结果

时间：2026-08-21 第二次（拆桶已上 Daphne），本机 `6060`，分支 `fix/11413-llm-snapshot-http`。夹具已清理。

| 场景 | n | ok | 错误 | p50 | p95 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| `baseline_small_post` | 10 | 10 | 0 | 856 | 997 | |
| `baseline_session_get` | 10 | 10 | 0 | 882 | 922 | |
| `baseline_persist` | 10 | 10 | 0 | 21 | 265 | 进程内 persist，不经 Daphne |
| `concurrent_unique_small` | 64 | 64 | 0 | 868 | 1295 | 16 并发 |
| `concurrent_same_key_insert_race` | 24 | 24 | 0 | 1087 | 1123 | 同键 24 打，库里仍 1 行 |
| `concurrent_request_then_response_update` | 32 | 32 | 0 | 1855 | 1895 | 32 对都是 `200/200`，32 行变成 response |
| `concurrent_unique_fat` | 24 | 24 | 0 | 1098 | 1435 | 约 400KB，不再 429 |
| `canary_session_get_during_fat` | 3 | 3 | 0 | 1065 | 1327 | 样本少，fat 批次短 |
| `canary_persist_during_fat` | 3 | 3 | 0 | 20 | 57 | persist 没被拖慢 |

`VERDICT`: `fat_unique_ok session_get_p95_ok persist_p95_ok same_key_race_ok request_response_update_ok`

对照修复前：update 只有 6/32 成功、fat 全 429。拆桶后约 186 次快照写未碰到 `api:chat:w`，也没打满自己的 320/60s 桶。

本脚本直接打 HTTP，不经过 Electron 旁路槽；「每轮只上云一份」由 coordinator 单测覆盖。

## Live（Electron ↔ 本机 6060）

时间：2026-08-21，分支 `fix/11413-llm-snapshot-http`。客户端需强制指到本机（当时 `.env.local` 的 lite 指向的 LAN API 对 `llm-snapshots` 返回 404）。

| 项 | 结果 |
|---|---|
| 主路径上传 | 会话 `ab5a81f0…` 在模型上游 403 时仍写入 3 条 `phase=request` 的 `ChatLLMSnapshot`（turn 收尾 flush 挂起的 request） |
| 账本回补 | 预埋 `llm-snapshot-ledgers/{session}.json` 后重启；经 `AgentHost.kickRecoverAndBackfill` → coordinator drain，种子 `11413-live-backfill-…` 落库且账本文件删除 |
| 接线修正 | Electron 原先只调 `relayOrchestrator.kickRecoverAndBackfill`，会漏掉快照账本；改为 `sharedHost.kickRecoverAndBackfill` |

本地模型上游 403（Kimi）导致本轮没有完整 response 快照；主路径与回补不依赖模型成功返回。

## 没覆盖

- ACK / 生产集群
- Electron 主进程真实 `fetch` 并发与旁路槽（已有 live 回补，并发仍未压）
- 旧客户端 WS `llm_snapshot` 与 HTTP 混打
- Daphne 多进程部署（本机单进程）
- 快照失败回补的更多边界（重叠 turn / 4xx 毒数据）由 `packages/agent-host` 单测补充
