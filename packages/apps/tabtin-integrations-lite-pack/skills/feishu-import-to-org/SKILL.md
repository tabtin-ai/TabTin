---
name: feishu-import-to-org
description: >
  飞书资产迁入组织——把用户选定的飞书多维表 / 云文档（Docx）/ 知识库节点链接
  一次性导入当前 Organization 云盘（表→TabData，文档→TabDoc）。用户说导入飞书、
  迁入多维表、同步飞书文档进 TabTin、贴了 feishu.cn/base、/docx 或 /wiki 链接
  要进组织时使用。不是出站同步稿（那是 lark-sync-brief），也不是外部 lark-cli。
metadata:
  version: "0.3.0"
  tabtin:
    category: integration
    displayName: "飞书导入到组织"
    tags:
      - feishu
      - lark
      - import
      - bitable
      - docx
      - wiki
      - migration
    tools:
      - run_terminal_command
---

# 飞书导入到组织

把飞书多维表格 / 新版云文档 / 知识库中的可导入叶子 **一次性迁入** 当前 Organization 云盘。

> **强制走 `tabtin feishu *`**。禁止用外部 `lark-cli`、`lark-doc` / `lark-base`、
> `tabtin table import`、`tabtin doc import file`、**`tabtin browser` / `tabtin fetch` 打开飞书网页**
> 冒充迁入通道。飞书 OAuth ≠ 内置浏览器登录态；撞登录墙说明走错了路。
> 能力清单：`docs/agent/cli-capabilities/feishu-cli-capabilities.md`。

与 `lark-sync-brief` 的区别：本 skill 是 **入站迁入**；`lark-sync-brief` 是把 Space 结论写成飞书出站同步稿。

## 硬顶与非目标

| 项 | 口径 |
|---|---|
| 单次表数 | ≤15（含关联闭包） |
| 单次文档 | ≤20 篇 Docx |
| 每表行数 | 约 2000 |
| 多维表附件 | 默认关；`--include-attachments` 才开；单文件 20MiB |
| Docx 图片 | 始终自动转存为 TabDoc 私有图片，与 `--include-attachments` 无关；单文件 20MiB，单篇最多 50 张 |
| Docx 文件块 | 当前暂不支持复制为 TabDoc 附件；导入结果通过 `fidelity.unsupported_file_blocks` 和 `issues` 明示，禁止静默报完成 |
| Wiki | **支持**：`/wiki/` → resolve →（叶子直接 import / 目录用 `wiki nodes` 展开）。**不做**整库一键打包 |
| 不做 | 双向 sync、Sheets、旧版 Doc、UI/Formula/视图保真、用浏览器爬飞书页 |
| OAuth | **必须人在浏览器完成**；须含 `wiki:wiki:readonly`（或 `wiki:node:read`）+ space/node retrieve。resolve 若 `next_action=reauth`：先 disconnect 再 oauth；Agent 只打印 URL |

## 编排步骤（贴链接主路径）

### 1. 解析上下文

需要：

- `organization_id`（全局 `--organization-id` 或 config `defaultOrganization`）
- `space_id`（`--space-id` / config `defaultSpace` / 当前会话 Space）——这是 **TabTin Space**，不是飞书 wiki `space_id`
- 可选 `collection_id`（当前云盘文件夹；没有则落到 Space 根）

缺了就问用户或用 `tabtin organization list` / 当前上下文补齐。**不要猜错组织。**

### 2. 确认企业应用与个人连接

先检查 Organization 的飞书企业应用 Provider：

```bash
tabtin feishu provider get --format json
```

若 `configured != true`：

- 当前用户是 Owner/Admin：请用户提供企业自建应用 App ID，并让 Secret 通过 stdin 输入；不要要求把 Secret 发到聊天或命令参数里。

  ```bash
  printf '%s' "$FEISHU_APP_SECRET" | tabtin feishu provider set --app-id cli_xxx
  ```

- 当前用户不是管理员：说明「需要 Organization Owner/Admin 先配置飞书企业应用」，**停下等待**。

Provider 就绪后，再检查当前成员的个人连接：

```bash
tabtin feishu connection get --format json
```

若 `connected != true`：

```bash
tabtin feishu oauth start --format json
```

把 `authorize_url` 交给用户，**停下等待**。授权完成后再次 `connection get`，确认后再继续。
不要在未连接时调用 resolve / wiki / import。

### 3. 选定资源

**用户贴了链接（含 `/wiki/`）：**

```bash
tabtin feishu resolve --url '<飞书链接>' --format json
```

可重复 `--url`。按每条 `kind` / `next_action` / `hint` 分支：

| kind | 下一步 |
|---|---|
| `bitable` | 无 `table_id` → `tabtin feishu bitable tables --app-token <token>`，勾选表（≤15） |
| `docx` | 记入 `documents`：`{"doc_token":"<token>","name":"...","doc_type":"docx"}` |
| `wiki_node` | **目录/容器**：用返回的 `space_id` + `node_token` 展开（见下）。**禁止** browser/fetch |
| `unsupported` 且 `next_action=reauth` | 缺 wiki 权限：告知用户 disconnect + oauth start，**停下等待**，禁止 browser |
| `unsupported` / `accessible=false` | 用人话说明 `error`/`hint`，不要强开 job，不要改走浏览器 |

**展开知识库目录：**

```bash
tabtin feishu wiki nodes \
  --space-id '<resolve.space_id>' \
  --parent-node-token '<resolve.node_token>' \
  --format json
```

- `selectable=true` 且 `import_kind=docx` → 用 `token`（obj_token）写入 documents
- `selectable=true` 且 `import_kind=bitable` → 用 `token` 作 app_token，再 `bitable tables`
- `expandable=true` 且未选中 → 可再对子 `node_token` 递归 `wiki nodes`（先问用户要哪几篇，勿一次扫整库）
- 不知 space 列表时：`tabtin feishu wiki spaces --format json`

**用户只给名字：**

```bash
tabtin feishu resources list --q '<关键词>' --kinds bitable,docx --format json
```

深目录 / 知识库内资源更常见路径是 resolve wiki 或 wiki spaces → nodes，而不是只靠扁平 `resources list`。

### 4. 有表时先审查关联

```bash
tabtin feishu import preview --tables @tables.json --format json
```

`tables.json` 形如：

```json
[{"app_token":"BaseXxx","table_id":"tblYyy","name":"任务"}]
```

用产品语言向用户说明：

- 因关联自动多勾了哪些表
- 跨 Base 警告（关联会降级）
- 是否打开附件同步（默认关）

**等人确认**后再 start。纯文档导入可跳过本步。

纯文档导入跳过的是“多维表关联审查”，不是保真告知：用户要求完整迁移时，应在提交前说明 Docx 图片会自动转存；Docx File Block / 文件块当前暂不支持，若源文档含这类内容，导入后必须按结果明确报告缺口。

### 5. 提交并等待

```bash
tabtin feishu import start \
  --space-id <tabtin-space> \
  [--collection-id <folder>] \
  [--tables @tables.json] \
  [--documents @docs.json] \
  [--include-attachments] \
  --format json
```

`docs.json` 形如：

```json
[{"doc_token":"DocXxx","name":"周报","doc_type":"docx"}]
```

拿到 `task_id` 后：

```bash
tabtin feishu import wait <task_id> --format json
```

### 6. 汇报结果

最终回复必须包含：

- 成功 / 失败状态
- 新建的 TabData 表 ID / TabDoc 文档 ID（从 `result` 取）
- `issues`（附件跳过、字段降级等）——有则明确说，不能只报「完成」
- 每篇 `created_documents[].fidelity`：至少核对 `source_images` 与 `imported_images` 是否相等，并报告 `unsupported_file_blocks`；三项均为 0 / 相等时才可称为本能力覆盖范围内的完整迁入
- 未导入的 unsupported / 未展开的 wiki 目录及原因

文档标题若出现在回复里，按 tabdoc 契约写成：

```markdown
[<title>](tabtin://resource/document/<id>?hint=tabdoc)
```

## 禁止事项（硬）

1. **禁止**在 resolve/wiki 失败后改用 `tabtin browser open` / `tabtin fetch` 打开 `*.feishu.cn` / `accounts.feishu.cn`。
2. **禁止**把「OAuth 已连接」当成「内置浏览器已登录飞书网页」。
3. **禁止**对 `wiki_node` 直接 `import start`（没有 obj_token）。必须先 nodes 展开到叶子。
4. **禁止**不经用户确认扫完整棵知识库树并批量导入。

## 长任务干预（可选）

- 尚未开始的表：`tabtin feishu import cancel-table <task_id> --app-token ... --table-id ...`
- 正在写入的表：`tabtin feishu import skip-table <task_id> --app-token ... --table-id ...`

## 断开换号

仅在用户明确要求换飞书账号，或 wiki 权限缺失需重授 scope 时：

```bash
tabtin feishu connection disconnect --yes
tabtin feishu oauth start
```

先口头确认；已导入资产不会被删除。

## 命令速查

| 步骤 | 命令 |
|---|---|
| 企业应用状态 | `tabtin feishu provider get` |
| 配置企业应用 | `... | tabtin feishu provider set --app-id ...` |
| 连接状态 | `tabtin feishu connection get` |
| 授权 URL | `tabtin feishu oauth start` |
| 解析链接（含 wiki） | `tabtin feishu resolve --url ...` |
| 知识空间 | `tabtin feishu wiki spaces` |
| 知识库节点 | `tabtin feishu wiki nodes --space-id ... [--parent-node-token ...]` |
| 搜资源 | `tabtin feishu resources list --q ...` |
| Base 下表 | `tabtin feishu bitable tables --app-token ...` |
| 审查 | `tabtin feishu import preview --tables ...` |
| 提交 | `tabtin feishu import start --space-id ...` |
| 等待 | `tabtin feishu import wait <task_id>` |
| 状态 | `tabtin feishu import status <task_id>` |

## 历史变更

- **0.3.0 (2026-08-17)**：补飞书 Docx 保真契约——明确图片始终自动转存、`--include-attachments` 只控制多维表附件；导入结果要求核对 `fidelity.source_images` / `imported_images` / `unsupported_file_blocks`，文件块暂不支持时禁止静默报完成。
