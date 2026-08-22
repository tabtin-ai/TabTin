# Templates

## Meeting Note

```markdown
# 会议纪要：<主题> <日期>

## 背景
<会议目标和上下文>

## 关键结论
1. <结论 + 依据>

## 行动项
| 事项 | 负责人 | 截止日期 | 优先级 | 状态 | 依赖/备注 |
|---|---|---|---|---|---|
| <事项> | <负责人或待确认> | <日期或待确认> | <P0-P3> | 待开始 | <备注> |

## 风险与待确认
- <风险/问题>
```

## Action Item Record

```json
{
  "事项": "<task>",
  "负责人": "<owner or 待确认>",
  "截止日期": "<YYYY-MM-DD or 待确认>",
  "优先级": "<P0|P1|P2|P3>",
  "状态": "待开始",
  "来源": "会议纪要：<topic>"
}
```

## User Receipt

```markdown
我已整理出：

- 会议纪要：<tabtin resource link or 草稿>
- 行动项：<N> 条
- 已写入：<Doc/Table/Tracker 状态>
- 待确认：<缺失字段>
```
