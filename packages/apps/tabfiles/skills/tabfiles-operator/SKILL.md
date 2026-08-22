---
name: tabfiles-operator
description: >
  云盘裸文件操作——把本地文件/文件夹保存、归档到 Organization 云盘，
  列出云盘文件、获取下载链接。用户说「保存到云盘」「归档到云盘」
  「上传到云盘」「云盘文件夹」「下载云盘文件」时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: storage
    displayName: "TabFiles Operator"
    autoActivateFor:
      - tabfiles
    tags:
      - drive
      - oss
      - cloud
      - 云盘
      - tabfiles
      - upload
      - archive
    tools:
      - run_terminal_command
---

# TabFiles Operator（Organization 云盘）

通过 `tabtin drive` / `tabtin oss` 管理 Organization 云盘里的裸文件（PDF / Markdown / CSV / 图片等）。

## 先分清三条路

| 用户意图 | 正确命令 | 不要用 |
|----------|----------|--------|
| **保存/归档到云盘**（团队可见、画布可打开） | `tabtin drive upload` / `upload-folder` | `present_to_user` local_file（只发本地聊天卡片，不是云盘） |
| 只要 OSS FileRecord / URL（给 doc import、table 附件） | `tabtin oss upload` | — |
| 已有 `file_record_id`，只挂进组织云盘 | `tabtin drive attach` | 再 upload 一遍 |

**硬边界**：`present_to_user` local_file / `tabtin file create` 产出的是工作目录本地文件或聊天卡片，**不会**出现在云盘列表。用户明确要云盘资产时，必须再跑 `drive upload`。

## 推荐流程

### 单文件归档

```bash
tabtin drive upload ./report.md --title "周报.md" --format json
tabtin drive upload ./data.csv --collection-id <folder_id> --format json
```

成功返回 `data.id`（云盘 ContextItem）和 `data.file_id`（OSS FileRecord）。

### 一级文件夹归档

```bash
tabtin drive upload-folder ./exports --format json
```

- 创建与目录同名的云盘文件夹
- **只上传一级**白名单文件（md/csv/pdf/xlsx/图片等），跳过子目录与不支持类型
- 看 `data.summary.success/failed/skipped`；`partial_failure: true` 表示有失败，不要当全部成功
- 零成功时会清理空文件夹并返回错误

### 列表与下载

```bash
tabtin drive list --format json
tabtin drive list --collection-id <folder_id> --format json
tabtin drive download-url <item_id> --format json
```

`<item_id>` 是 list/upload 返回的 ContextItem id，不是 `file_id`。

### 文件夹整理

```bash
tabtin drive collection list --format json
FOLDER=$(tabtin drive collection create --name "归档" --format json | jq -r '.data.id')
tabtin drive collection move-items --item-ids <item_id> --collection-id "$FOLDER"
```

**创建是否成功以 CLI 返回的 `id` / `name` 为准**（`ok=true` 且有 `data.id` 即服务端已建夹）。
需要确认服务端可见性时用 `tabtin drive collection list --format json` 精确回查，
**不要**把 Electron 云盘界面缓存陈旧误报成创建失败。

## 命令速查

| 命令 | 风险 | 说明 |
|------|------|------|
| `drive upload <path>` | write | 一步上传并挂载；需本地 Daemon/Electron |
| `drive upload-folder <dir>` | write | 一级目录上传；需本地 Daemon/Electron |
| `drive attach --file-record-id` | write | 已有 FileRecord 时挂载 |
| `drive archive-from-chat --file-record-id` | write | 聊天附件归档 |
| `drive list` | read | 列云盘文件；可加 `--collection-id` |
| `drive collection *` | read/write | 文件夹 list/create/update/delete/move-items |
| `drive shared-with-me` / `collaborator *` | read/write | 分享与协作者 |
| `drive trash-list` | read | 回收站列表 |
| `drive download-url <item-id>` | read | 短期下载 URL |
| `oss upload <path>` | write | 只要 FileRecord，不进组织云盘列表 |
| `storage files *` | read/destructive | 团队存储治理（非云盘挂载） |

需指定 Organization 时显式传全局 `--organization-id`。可解析输出始终加 `--format json`。写操作可先 `--dry-run`。
