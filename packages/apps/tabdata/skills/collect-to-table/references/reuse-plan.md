# 复用门闩与 reuse_plan

仅在已有 `confirmed_plan` 或 `flat_exemption=true`、准备写入之前读取本文。

## 任务内表 vs 历史表

- 维护 `task_created_table_ids`：本轮每次成功 `table create` 后追加返回的表 ID。
- **任务内表**：ID 在该列表中 → 可直接复用，不进确认卡。
- **历史表**：工作区同角色候选的 ID 不在该列表中 → 必须经用户确认后才能写入。

## 进入复用门闩

1. 按方案角色执行 `table list` / `table info`，收集同角色候选。
2. 匹配宁可少报、不可乱报；不确定同角色则不要列为默认可复用项。
3. 将候选分为任务内 / 历史两类。
4. 若没有任何历史候选：写入空决策并继续写入阶段：

```text
reuse_plan:
  candidates: []
  decisions: []
  source: empty_skip
```

5. 若存在 ≥1 个历史候选，且状态中尚无完整 `reuse_plan`（或非同任务重跑缓存）：
   - 下一次工具调用必须是 `ask_user`。
   - 用户回复前，禁止任何写表命令（与方案门闩相同的禁止清单）。

同任务重跑且状态中仍有完整 `reuse_plan` 时，可设 `source: rerun_cached` 并跳过确认。

## 确认卡（一次问完）

用产品语言说明发现了哪些可复用历史表，并询问能否复用。**措辞按场景生成，不要求固定开场句。**

正文：按角色列出**历史**候选（表名 + 一句话理由）；每项默认勾选「复用」。任务内新建表不要出现在此卡。

操作：

- **按推荐复用** — 确认当前勾选
- **全部新建** — 所有历史候选对应角色改为新建，本轮不向这些历史表写行
- **其他** — 用户自由输入（例如「主表新建，明细用某某表」）

多张历史候选必须合并在同一张卡，禁止逐张确认。

「其他」含糊时：在同卡语境再澄清一次。仍无法得到完整 `decisions` 时停止自动写入，说明卡点，请用户重述；禁止静默改写未授权的表。

用户在「其他」中指定的换用表若仍是历史表，视为已确认复用，不再二次询问。指定表不存在或无权限时说明原因，请用户改述或选全部新建。

## reuse_plan 形状

```text
reuse_plan:
  candidates[]:
    role            # 主实体 / 明细 / 可复用对象等通用角色
    table_id
    table_name
    reason          # 为何认为同角色
    is_task_created # true 则不应出现在确认卡
  decisions[]:
    role
    action          # reuse | create_new | reuse_specified
    table_id?       # reuse / reuse_specified 时必填
  source            # ask_user | empty_skip | rerun_cached
```

任务内候选可直接写入 `decisions`（`action: reuse`），无需进卡。

## 写入约束

- 仅当 `reuse_plan` 完整后才允许写表。
- `action: reuse` / `reuse_specified` → 只向对应 `table_id` 写入。
- `action: create_new` → 先 `table create`，把新 ID 追加进 `task_created_table_ids`，再写入。
- 禁止向未出现在 `decisions` 允许列表中的历史表写行。
