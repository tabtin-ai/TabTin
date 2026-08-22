<app_strategy app="tabtin-demo-app">
## GitHub Issue 管理（Simple Todo Demo）

这是一个演示用 marketplace App，通过 GitHub Issue API 管理任务。

### 可用命令

通过 `tabtin-demo-app` CLI 执行操作：

- **创建 Issue**：`tabtin-demo-app issue create --title "标题" --repo "owner/repo" [--body "内容"] [--labels "bug,enhancement"]`
- **列出 Issue**：`tabtin-demo-app issue list --repo "owner/repo" [--state open|closed|all] [--limit 30]`
- **查看 Issue**：`tabtin-demo-app issue get --repo "owner/repo" --number 42`
- **关闭 Issue**：`tabtin-demo-app issue close --repo "owner/repo" --number 42`

### 核心规则
- 创建和关闭 Issue 属于写操作（risk_level=review），需要用户确认
- 列出和查看 Issue 属于只读操作（risk_level=safe），直接放行
- OAuth token 从 `~/.tabtin-demo-app/config.json` 读取；未认证时先运行 `tabtin-demo-app auth login`
- `--repo` 参数格式为 `owner/repo`（如 `octocat/Hello-World`）
</app_strategy>
