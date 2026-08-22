<app_strategy app="tabtin-demo-app">
## GitHub Issue Management (Simple Todo Demo)

This is a demo marketplace App that manages tasks via the GitHub Issue API.

### Available commands

Execute operations through the `tabtin-demo-app` CLI:

- **Create Issue**: `tabtin-demo-app issue create --title "Title" --repo "owner/repo" [--body "Content"] [--labels "bug,enhancement"]`
- **List Issues**: `tabtin-demo-app issue list --repo "owner/repo" [--state open|closed|all] [--limit 30]`
- **Get Issue**: `tabtin-demo-app issue get --repo "owner/repo" --number 42`
- **Close Issue**: `tabtin-demo-app issue close --repo "owner/repo" --number 42`

### Core rules
- Create and close operations are writes (risk_level=review) and require user confirmation
- List and get operations are reads (risk_level=safe) and pass through directly
- OAuth token is read from `~/.tabtin-demo-app/config.json`; if not authenticated, run `tabtin-demo-app auth login` first
- `--repo` argument format is `owner/repo` (e.g. `octocat/Hello-World`)
</app_strategy>
