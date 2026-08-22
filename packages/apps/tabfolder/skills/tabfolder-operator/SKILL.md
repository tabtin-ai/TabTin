---
name: tabfolder-operator
description: >
  本地文件管理——浏览、预览、读写、搜索文件与目录、
  跨 App 协作。用户要在本地文件系统里找文件 / 看内容
  / 整理目录时使用。
metadata:
  version: 0.1.0
  tabtin:
    category: device
    displayName: "TabFolder Operator"
    tags:
      - file
      - management
      - workspace
    autoActivateFor:
      - tabfolder
    tools:
      - file_read
      - code_glob
      - code_grep
      - run_terminal_command
---

# TabFolder Operator

本地文件系统浏览与管理。支持用户目录和 Agent 沙箱两种工作模式。

## 两种工作模式

| 模式 | 说明 |
|------|------|
| 用户目录 | 用户主动打开的本地文件夹，可浏览、预览和管理文件 |
| Agent 沙箱 | Agent 任务执行时的工作目录，文件变更对用户可见 |

## 操作流程

1. **浏览目录** → 上下文已注入当前文件夹路径和文件树概要，不要重复读取
2. **读取文件** → 用 `file_read`（不是 `cat`），支持 `offset`/`limit` 分段读取大文件
3. **写入/编辑** → 通过 CLI `tabtin code write` 新建文件，`tabtin code edit` 精确替换已有内容
4. **搜索文件** → `code_glob` 按文件名模式查找，`code_grep` 按内容搜索

## 安全约束

- 不删除用户未明确指定的文件
- 不修改 `.git/`、`node_modules/`、`__pycache__/` 等自动生成目录中的文件
- 大文件（>1MB）先用 `file_read` 的 `offset`/`limit` 参数预览，避免一次性读取全部内容
- 二进制文件（图片、PDF 等）只能预览，不能用文本工具编辑

## 与其他 App 协作

| 场景 | 方式 |
|------|------|
| 文件内容 → TabData | 读取文件 → 解析结构 → 通过 SQL 写入 |
| 文件内容 → TabDoc | 读取文件 → 通过 `tabtin doc create --markdown` 落库，再按段用 `tabtin doc insert-block` / `tabtin doc append` 补写 |
| 代码项目 | 优先使用 TabCode 的完整工具链（语义搜索、诊断等） |

## 效率规则

- **搜索走 `code_glob` / `code_grep`，不要用 `ls` / `find` / `cat` 冒充**：用户说「找 / 搜 / 查一下 XX 文件」时——按文件名模式找走 `code_glob`（如 `**/*.py`、`docs/**/*.md`），按内容搜走 `code_grep`（正则匹配文件内容）——它们是专门的文件搜索工具，命中率与性能都比 `ls` / `find` / `cat` 人肉过滤好。`ls` / `find` 是 shell 列出命令，不要用它们冒充搜索；`cat` 是读单文件，不要用它逐个打开人肉搜内容。
- 上下文已注入当前文件夹路径 → 不要重复查询
- 同一文件只读取一次，后续引用对话历史中的内容
- 目录结构用 `code_glob` 一次获取，不要逐层 ls

## 工具使用指南

### 只读工具（FC，自动激活）

| 工具 | 用途 |
|------|------|
| `file_read` | 读取文件内容，大文件用 `offset` + `limit` 分段读取 |
| `code_glob` | 按 glob 模式搜索文件路径（如 `**/*.py`、`docs/**/*.md`） |
| `code_grep` | 按正则表达式搜索文件内容，支持上下文行数和文件类型过滤 |

### 写入操作（CLI，通过 run_terminal_command）

| 命令 | 用途 |
|------|------|
| `tabtin code write --path <file> --content '<text>'` | 创建或覆盖文件 |
| `tabtin code edit --path <file> --edits '<json>'` | 精确编辑（指定替换内容） |
| `tabtin code delete --path <file>` | 删除文件（不可逆，需确认用户意图） |
