---
name: mcp-operations
description: >
  操作本机 MCP 连接——通过 `tabtin mcp` CLI 查看当前
  Space 已挂载的本机 MCP servers、tools/resources/
  prompts，并用 `mcp_call_tool` 调用指定 MCP tool。
  用户提到"使用 Playwright MCP""调用本机安装的 MCP
  工具""读取某个 MCP resource""获取某个 MCP prompt"时激活。
metadata:
  version: 0.1.0
  tabtin:
    category: developer
    autoActivateFor: []
    tags:
      - mcp
      - local-mcp
      - tools
      - resources
      - electron
    tools:
      - mcp_call_tool
---

# MCP Operations

这组能力用于访问当前 Electron 主机上已经接入并挂载到当前 Space 的本机 MCP 连接。

先理解边界：

- 这里只处理“本机已挂载的 MCP 连接”，不是 Daemon 暴露给外部 Agent 的 TabTin MCP Server endpoint
- 只有当前 Space 已挂载并启用的连接，工具才可见
- 如果当前 Space 同时挂载了多个 MCP server，先用 `tabtin mcp list-servers --format json` 列出 server，再显式指定 `server_name` 或 `connection_id`
- 在调用任何 MCP tool 之前，先用 `tabtin mcp list-tools --server-name <name> --format json` 查看 schema，不要猜参数
- 在获取任何 MCP prompt 之前，先用 `tabtin mcp list-prompts --server-name <name> --format json` 查看名称和参数
- 如果某个 MCP tool / resource 返回错误，要把错误原样带回，不要臆造成功结果

推荐调用顺序：

1. `tabtin mcp list-servers --format json` 看当前 Space 挂了哪些 server
2. `tabtin mcp list-tools --server-name <name> --format json`、`tabtin mcp list-resources --server-name <name> --format json` 或 `tabtin mcp list-prompts --server-name <name> --format json` 看具体能力
3. `mcp_call_tool(...)` 调用具体 MCP tool；读取 resource / 获取 prompt 继续走 `tabtin mcp read-resource` / `tabtin mcp get-prompt`

## FC 工具

### mcp_call_tool

唯一的 MCP FC 工具。调用某个 MCP tool。调用前必须已经用 `tabtin mcp list-tools` 确认过准确的 `tool_name` 和输入 schema。

```python
mcp_call_tool(
  server_name="Playwright",
  tool_name="browser_snapshot",
  arguments={}
)
```

返回里会包含：

- `server`
- `tool_name`
- `is_error`
- `content`
- `structured_content`

## CLI 查询

MCP 的发现与只读查询都走 `tabtin mcp` CLI。可解析输出一律加 `--format json`。

### servers

列出当前 Space 已挂载的 MCP servers，以及它们的 `connection_id`、来源和传输类型。

```bash
tabtin mcp list-servers --format json
```

### tools

列出指定 MCP server 暴露的 tools。使用要求：

- 先看返回的 `inputSchema`
- 再根据 schema 组织 `mcp_call_tool` 的 `arguments`

```bash
tabtin mcp list-tools --server-name "Playwright" --format json
```

### resources

列出指定 MCP server 暴露的 resources，供后续 `read-resource` 使用。

```bash
tabtin mcp list-resources --server-name "Playwright" --format json
tabtin mcp read-resource --server-name "Playwright" --uri "resource://example" --format json
```

当当前 Space 挂了多个同名或多个不同 MCP server 时，优先显式传 `--connection-id`，避免歧义。

### prompts

列出指定 MCP server 暴露的 prompts，供后续 `get-prompt` 使用。

```bash
tabtin mcp list-prompts --server-name "Playwright" --format json
tabtin mcp get-prompt --server-name "Playwright" --prompt-name "browser_workflow" --arguments '{"goal":"capture the current page"}' --format json
```

返回里会包含 prompt 的 `description` 和 `messages`。

### call

`tabtin mcp call` 只用于调试或手动验证。Agent 正常调用 MCP tool 时优先使用 `mcp_call_tool` FC，方便平台按 MCP 风险类型走审批与审计。

```bash
tabtin mcp call --server-name "Playwright" --tool-name "browser_snapshot" --arguments '{}' --format json
```
