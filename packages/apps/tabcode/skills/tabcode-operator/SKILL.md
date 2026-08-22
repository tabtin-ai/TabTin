---
name: tabcode-operator
description: >
  代码项目操作——读写编辑文件、搜索代码、诊断验证、
  运行 lint、执行 Git 安全操作。用户提到"读文件""写代码""搜索代码""git""lint"时使用。
metadata:
  version: 0.3.1
  tabtin:
    category: developer
    displayName: "TabCode Operator"
    tags:
      - code
      - development
      - file
    autoActivateFor:
      - tabcode
    tools:
      - web_search
      - run_terminal_command
      - read_file
      - write_file
      - edit_file
      - delete_file
      - glob_search
      - grep_search
---

# TabCode Operator

代码项目文件操作与搜索，**直接调用对应工具**——不要绕 `tabtin code` CLI 子命令。

## 操作方式

6 件套是 LLM 直接可见的 TabCode FC 工具，按需调用，参数即工具入参：

| 工具 | 用途 | 必填参数 | 常用选填 |
|---|---|---|---|
| `read_file` | 读取文件（带行号） | `path` | `offset`（起始行，1 起算，可负从尾部数）/ `limit`（最大行数） |
| `write_file` | 写入或覆盖文件 | `path`, `contents` | — |
| `edit_file` | 精确字符串替换 | `path`, `old_string`, `new_string` | `replace_all`（替换所有匹配） |
| `delete_file` | 删除文件 | `path` | — |
| `glob_search` | 文件名模式搜索 | `glob_pattern`（如 `**/*.tsx`） | `target_directory` |
| `grep_search` | 代码内容正则搜索 | `pattern` | `path` / `glob` / `type` / `output_mode` / `-i` / `-A`/`-B`/`-C` |

注意：
- 编辑前必须先 `read_file` 读取目标文件——`edit_file` 依赖最近一次读取的内容做匹配。
- `edit_file` 的 `old_string` 必须在文件中**唯一**；不唯一时多带几行上下文，或用 `replace_all`。
- 路径支持相对（相对于 `workspace_root`）和绝对。

## 建目录 / 移动 / 重命名（CLI-only，无 FC 工具）

创建目录、移动或重命名文件**没有**对应的 FC 工具（above 7 件套不含 mkdir/move），
走 `run_terminal_command` 调 CLI：

```bash
run_terminal_command(command="tabtin code mkdir --path src/newdir")
run_terminal_command(command="tabtin code mv --from src/old.go --to src/new.go")
run_terminal_command(command="tabtin code rename --from src/old.go --to src/new.go")  # rename 是 mv 的别名
```

- `mkdir` 对齐 `mkdir -p`：递归创建，目标已是目录时幂等成功，撞到同名文件时报错。
- `mv`/`rename` 默认**不覆盖**已存在的目标路径（无 `--force`）；不允许把路径移动到自身子树内。

## 三层搜索策略

根据搜索意图选择合适工具，三者互补：

1. **`grep_search`** — 精确匹配，适合已知符号
   - 查找 class/function/variable 定义
   - 支持正则表达式

2. **`glob_search`** — 文件名模式发现
   - 找到特定类型文件，了解目录结构

**典型工作流**：`glob_search` 发现文件 → `grep_search` 精确查找 → `read_file` 深入阅读

## 编辑约束

- 编辑前必须先 `read_file` 读取文件
- 使用 `edit_file` 做精确替换，避免重写整个文件
- 如果 `old_string` 不唯一，提供更多上下文行使其唯一
- 代码注释应简洁——只在代码本身无法传达意图时添加
- 不要添加叙述性注释（如"导入模块"、"定义函数"）

## Git 操作规范

### 查看状态和变更

```bash
run_terminal_command(command="git status")             # 分支、staged/unstaged 文件
run_terminal_command(command="git diff")               # 未暂存的变更
run_terminal_command(command="git diff --staged")      # 暂存区变更
```

### 修改操作

```bash
run_terminal_command(command="git add .")
run_terminal_command(command="git commit -m 'message'")
```

- 永远不要 `git reset --hard`（除非用户明确要求）
- 永远不要 `git push --force` 到 main/master
- commit 前先用 `git status` 和 `git diff` 查看变更
- 不要自动 amend 已推送到远程的 commit
- 不要跳过 pre-commit hooks

## Web 信息检索

- `web_search` — 搜索网络获取实时信息（FC 工具）
- `tabtin fetch <url>` — 抓取静态 URL 页面正文转 Markdown（轻量 HTTP + readability，CLI 首选）；
  已打开 tab / JS 动态页取正文走 `tabtin browser print --save <path>`（缺省当前 tab；公开动态页加 `--url`），
  落盘后按需读文件；二进制资源下载走 `tabtin browser resource download --url <url>`。
- 典型工作流：`web_search` 找到链接 → `run_terminal_command("tabtin fetch <url>")` 抓正文

## 诊断与验证

- 编辑后 runtime 会在下一轮被动注入 LSP / lint 诊断；不要主动调用已退役的诊断 FC 工具。
- 需要主动验证时，运行项目已有 lint / typecheck / test 命令，或让用户提供指定命令。
- 编辑代码后检查**自己引入**的 lint 错误，不修复预存的
- 运行相关测试验证改动正确性

## 长命令管理

通过 `run_terminal_command` 执行耗时命令时：
- 默认 `wait_ms=60000`，上限 300000；到期不会杀进程，而是返回 `status="running"` + `session_id` + `pid` + `output_file`。
- dev server / watcher / 持续 log → 传 `wait_ms: 0` 立即后台化。
- 任务完成时 push 通知会激活下一轮 turn——你可以继续做别的事不用主动等。
- 想看进度：`read_file(output_file)`。
- 想停掉：用 `run_terminal_command` 跑 `kill <pid>`（pid 在 envelope 里返回；卡死进程用 `kill -9`；模拟 Ctrl+C 用 `kill -INT`）。

## 目录体系

| 标识 | 含义 |
|------|------|
| `code_project` | 用户打开的代码仓库 |
| `agent_dir` | Agent 产出目录 |
| `user_folders` | 用户文件夹 |

`workspace_root` 是文件工具和 terminal 的默认工作目录。
- 文件路径支持相对路径（相对于 workspace_root）和绝对路径
- 不要 `cd` 到 workspace_root——它已是默认工作目录

## 效率规则

- 上下文已注入当前项目路径和 Git 状态 → 不要重复查询
- 独立的读操作可以并行执行（使用不同 session_id）
- 先理解代码结构再动手修改——探索 → 理解 → 修改 → 验证
