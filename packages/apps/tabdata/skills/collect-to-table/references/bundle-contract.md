# CollectBundle 契约

在接手原始数据、检查覆盖率或识别实体时读取本文。不要在只需执行已确认方案时加载。

## 最小结构

```text
CollectBundle
├── records[]
├── manifest
└── land_hints（可选）
```

### `records[]`

- 必须能枚举顶层记录数。
- 字段可以缺失、不齐或包含对象数组。
- 嵌套对象数组是识别明细或可复用对象的重要信号。
- 顶层对象尽量保留 `source_url` 或 `source_id`；嵌套项尽量保留来源标识、作者标识和时间。
- 输入可以来自 JSON、JSONL、CSV、浏览器采集或内存结构，不要求源文件采用固定格式。

### `manifest`

| 字段 | 作用 |
|---|---|
| `source_url`、`channel`、`collected_at` | 说明来源 |
| `claimed_total`、`row_count` | 对比预期量与实际量 |
| `is_partial`、`failed_ids` | 如实记录不完整数据 |
| `task_id` | 标识本批任务；缺失时由编排生成 |
| `bundle_kind` | 可选：`flat`、`list`、`list_detail` |
| `artifact_paths` | 可选：原始产物路径 |

### `land_hints`

可以包含：

- `parent_role`
- `nested_roles`
- `identity_candidates`
- `user_analysis_intent`

这些都只是提示。最终角色必须结合 `records[]` 的实际形状和用户原始意图判断。

## 适配检查

进入结构识别前确认：

1. `records[]` 可枚举，且已记录顶层条数。
2. `task_id` 存在。
3. 覆盖率和失败项可说明；无法得知时标记未知，不编造完整率。
4. 原始关联线索没有在格式转换时被抹掉。
