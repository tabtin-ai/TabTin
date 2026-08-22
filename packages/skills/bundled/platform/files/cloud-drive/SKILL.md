---
name: cloud-drive
description: >
  云盘上传与归档——把本地 Markdown / CSV / PDF / 图片保存到 Space 云盘，
  或上传整个一级文件夹。用户说「保存到云盘」「归档到云盘」「上传云盘」
  「云盘文件不见了 / 打开是空白」排查归档链路时使用。普通对话（不在
  TabFiles 页）也要优先检索本 skill，不要只用 present_to_user local_file。
metadata:
  version: "0.1.0"
  tabtin:
    category: storage
    autoActivateFor: []
    tags:
      - drive
      - oss
      - cloud-drive
      - 云盘
      - upload
      - archive
      - tabfiles
      - markdown
      - csv
    tools:
      - run_terminal_command
---

# 云盘上传（platform:files/cloud-drive）

Space 云盘裸文件入口是 `tabtin drive`，不是 `present_to_user` 的 `local_file` item。

## 决策

1. **保存/归档到云盘** → `tabtin drive upload <path>` 或 `tabtin drive upload-folder <dir>`
2. **只要 FileRecord**（再给 doc import / table 附件）→ `tabtin oss upload`
3. **聊天里发本地卡片** → `present_to_user` 的 `local_file` item（这不是云盘）

把本地 md/csv「归档到云盘」却只调了 `present_to_user` 的 `local_file` item / `file create`，画布打开会空白或「不存在」——因为从未创建 FileRecord + ContextItem。

## 示例

```bash
# 单文件
tabtin drive upload ./notes.md --format json

# 一级目录（跳过子目录与不支持类型；看 summary）
tabtin drive upload-folder ./exports --format json

# 核对
tabtin drive list --format json
tabtin drive download-url <item_id> --format json
```

详细参数与边界见 TabFiles 场景下的 `tabfiles-operator` skill；本 skill 保证普通对话也能检索到 `oss` / `drive` 正确入口。
