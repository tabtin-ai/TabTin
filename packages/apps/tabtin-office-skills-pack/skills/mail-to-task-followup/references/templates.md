# Templates

## Task Row

```json
{
  "任务": "<request or commitment>",
  "负责人": "<owner or 待确认>",
  "截止日期": "<YYYY-MM-DD or 待确认>",
  "状态": "待确认",
  "来源邮件": "<message/thread id or subject>",
  "备注": "<risk or dependency>"
}
```

## Reply Draft

```markdown
<收件人称呼>，

收到，关于 <主题>，我理解下一步是：

1. <action + owner + due date>
2. <action + owner + due date>

还需要确认：
- <question>

<落款>
```

## User Receipt

```markdown
我从邮件中提取了 <N> 个待办：

| 任务 | 负责人 | 截止 | 状态 |
|---|---|---|---|
| <task> | <owner or 待确认> | <date or 待确认> | 待确认 |

- 写入状态：<未写入/已写入表格>
- 回复草稿：<已生成/未生成/工具不可用>
- 待确认：<missing fields>
```
