---
name: terminal-operator
description: >
  终端命令执行——通过 run_terminal_command 用一次性
  shell 子进程执行命令。wait_ms 决定阻塞时长；wait_ms:0
  立即背景化，命令完成时 push 通知会激活下一轮 turn。
  Agent 起的命令会出现在用户的 Terminal Tab transcript
  中，用户可实时观察。
metadata:
  version: 1.0.0
  tabtin:
    category: developer
    displayName: "Terminal Operator"
    tags:
      - terminal
      - shell
      - automation
      - pty
    autoActivateFor:
      - terminal
    tools:
      - run_terminal_command
---

# Terminal Operator

LLM 通过 `run_terminal_command` 工具执行 shell 命令。命令由一次性 shell 子进程执行，工作目录默认 workspace；Terminal Tab 只是 transcript 展示面，不参与命令完成判定。

## 用户要「打开终端」→ 应用内可交互终端

用户说「打开终端 / 开个终端 / 给我一个终端」时，**优先**打开 TabTin 应用内可交互终端：

```
run_terminal_command(command="tabtin terminal open")
# 可选：tabtin terminal open --cwd <path> --title "项目终端"
# 聚焦已有：tabtin terminal list → tabtin terminal open --session-id <id>
```

这会新建（或聚焦）一个 **可手动打字输入** 的 Terminal Tab（xterm + node-pty），用户可以自己敲命令。

| 意图 | 正确做法 | 错误做法 |
|------|----------|----------|
| 给用户一个可交互终端 | `tabtin terminal open` | `tabtin desktop open "PowerShell"` / `Start-Process powershell` |
| Agent 自己跑一条命令 | `run_terminal_command(command="...")` | 打开外部系统终端再打字 |
| 用户明确要系统 PowerShell / Windows Terminal | `tabtin desktop open "PowerShell" --external` | 默认 `desktop open`（会被拦截） |

**不要**把「打开终端」理解成启动 OS 级 PowerShell / cmd / Windows Terminal 窗口。

## Agent 起的命令对用户可见

调 `run_terminal_command` 时，命令会自动开一个独立的 Terminal Tab（D3：每次新 tab，不复用），用户能：

- **实时看输出**——命令 stdout / stderr 合流后出现在 tab 里
- **手动停止 background 任务**——用户关闭 Agent tab 或 LLM 跑 `run_terminal_command("kill <pid>")` 都会让 bridge 终止仍在跑的 child process

这是 TabTin 的产品基本盘：Agent 在做的每一步都看得见、能干预。**不要刻意隐藏命令输出**——LLM 看到的 stdout 与用户在 tab 看到的是同源。

## 工作流

### 单次命令（wait_ms 内 sync 完成，最常用）

```
run_terminal_command(command="pnpm test")
```

返回 `status="completed"` + `stdout` / `exit_code` / `duration_ms` / `exited_by`。`exit_code === 0` 表示命令成功，非 0 是命令本身失败（不是工具失败）。

`stderr` 字段始终为空字符串——Agent shell bridge 合流后 stderr 已经在 stdout 里，不需要读。

### 大输出（超 30KB 落盘）

stdout 超 30KB 时返回会带 `full_output_path` 字段，stdout 字段是 head + tail preview。

```
run_terminal_command(command="git log --all --decorate")
# 返回 status="completed", stdout="..head..\n[truncated]\n..tail..", full_output_path="/tmp/...log"
# 看完整内容
read_file(path="<full_output_path>")  # 不要用 cat / head / tail
```

### 长任务（dev server / build / log tail）— wait_ms: 0

```
run_terminal_command(command="pnpm dev", wait_ms=0)
# 立即返回：status="running", session_id="agent-<spaceId>-<ts>-<rand>",
#         pid=12345, output_file="{tmpdir}/tabtin-agent-tasks/<sessionId>.log"
# （{tmpdir} 是 OS 临时目录：macOS 是 /var/folders/...，Linux 通常是 /tmp/...）
```

bridge 持续把命令输出 tail 到 `output_file`。**不要再调一次同样命令**。

任务完成时 push 通知会激活下一轮 turn——你可以继续做别的事不用主动等。想看实时进度用 `read_file(path="<output_file>")`，bridge 持续 tail 增量内容。

> **真路径用 envelope 里的 `output_file` 字段，不要假设路径**——macOS 的 tmpdir 不是 `/tmp/`，硬编码会 ENOENT。直接把 envelope 返回的 `output_file` 值喂给 `read_file` 即可。

dev server 起动早早 ready：传 `pattern="Server listening on port"` 让本工具命中即返。

### 主动停止 background 任务

```
run_terminal_command(command="kill <pid>")
# 卡死进程用 kill -9 <pid>；模拟 Ctrl+C 用 kill -INT <pid>
# pid 在 status="running" envelope 里返回
```

kill 是幂等的（对已自然 exit 的 PID 不算错误，shell 返回退出码非 0 但不影响）。

### 交互式命令

普通 `run_terminal_command` 不支持交互输入。命令本身有 prompt 时会卡住，直到 timeout 或用户取消。最常用的做法是用命令本身的非交互参数（见下方非交互优先表）。

如果非交互参数不够用，**先评估**用 `ask_user` 让用户改用真正的手动 Terminal Tab（`tabtin terminal open`）操作，或等待未来的 interactive terminal 工具；不要把交互流程塞进普通 shell tool，也**不要**用 `tabtin desktop open` 打开系统终端来「凑合」。

## 非交互优先原则

终端命令必须优先用非交互模式。交互式 REPL（裸 `python` / `node` / `irb` 等）与编辑器（`vim` / `nano`）绝对不要启动。

### 非交互命令替代表

| 交互式（禁止） | 非交互替代（必须） |
|---|---|
| `npm init` | `npm init -y` |
| `npx create-*`（有提示时） | 加 `--yes` 或预先准备好答案文件 |
| `pip install`（需确认时） | `pip install --yes` / `pip install -q` |
| `apt-get install` | `apt-get install -y` 或 `DEBIAN_FRONTEND=noninteractive` |
| `git commit`（无 -m） | `git commit -m "message"` |
| `git rebase -i` | `git rebase --autosquash` 或 `GIT_SEQUENCE_EDITOR="sed -i ..." git rebase -i` |
| `crontab -e` | `crontab <<'EOF'\n...\nEOF` |
| `vim` / `nano` / `vi` | 用 `edit_file` / `write_file` 工具，**不**走 shell |
| `mysql -p` / `psql` 直连 | 用 `tabtin table query` CLI |
| `ssh`（密码认证） | `ssh -o StrictHostKeyChecking=no` + key 认证 |
| 裸 `python` / `node`（进 REPL） | `python -c "..."` / `python script.py` / `node -e "..."` / `node script.js` |

### 管道输入模式

简单确认场景用管道代替交互：

```bash
yes | some_command                       # 自动回复 y
echo -e "input1\ninput2" | some_command  # 多行输入
```

## 命令安全分级

**自动放行（regular）**：
- `tabtin *`（所有 CLI 子命令）
- 只读命令：`ls` / `cat` / `head` / `tail` / `grep` / `wc` / `echo` / `pwd` / `whoami` / `date`
- 网络查询：`curl`（GET）/ `ping` / `dig` / `nslookup`

**需要用户审批（explicit_permission）**：
- 文件写入：`cp` / `mv` / `mkdir` / `touch` / `tee`
- 软件安装：`pip install` / `npm install` / `brew install`
- 进程操作：`kill`
- 脚本执行：`python -c "..."` / `python script.py` / `node -e "..."` / `node script.js`（需服务端放行）

**禁止执行（prohibited）**：
- 破坏性命令：`rm -rf /` / `mkfs` / `dd` / `> /dev/sda`
- 权限提升：`sudo` / `su` / `chmod 777`
- 数据库直连：`mysql` / `psql`（走 `tabtin table query` / `tabtin table execute` CLI）
- 系统修改：`systemctl` / `launchctl` / `crontab -e`
- 编辑器：`vim` / `nano` / `vi`（用 `edit_file` / `write_file` 工具）
- 交互式 REPL：裸 `python` / `node`（不带 -c/-e 或脚本文件参数）
- 输出重定向写文件：`echo "x" > file`（被 critical denylist 拦截）—— 用 `write_file` 工具

## 工作目录

- 默认 cwd = 工作目录根；绝对路径只通过环境变量 `$TABTIN_WORKSPACE`（Windows：`$env:TABTIN_WORKSPACE` / `%TABTIN_WORKSPACE%`）访问
- 相对路径相对工作目录根本身——**不要**再套一层 `workspace/` 前缀
- 切其他目录：在命令内部 `cd /path && <cmd>` 或用绝对路径
- 长路径含空格用引号：`cd "/path with spaces" && <cmd>`
- **不要传 `working_directory` 参数**——`run_terminal_command` 没这个字段，统一用 cwd-in-command 模式

## 错误恢复

- `exit_code !== 0` → 分析 stdout 末尾（错误信息通常在那里）
- 命令超 wait_ms 仍在跑 → 不杀进程，转 `status="running"`；长任务直接 `wait_ms=0` 起后台 + push 通知回头
- `hard_timeout_ms` 超时 → 进程被 SIGTERM；envelope 带 `killed_reason="hard_timeout"`
- `degraded: true` → bridge 因 policy 降级到 sandbox 跑，输出真实但跟标准 shell process 行为有差异
- 权限拒绝 → 不要尝试 `sudo`，向用户说明需要的权限

## 绝不用 run_terminal_command 做有专门工具的事

- 找文件 → `glob_search`（不是 `find` / `ls -R`）
- 搜内容 → `grep_search`（不是 `grep` / `rg`）
- 读文件 → `read_file`（不是 `cat` / `head` / `tail`）
- 编辑文件 → `edit_file`（不是 `sed` / `awk`）
- 写文件 → `write_file`（不是 `echo > ` / `cat <<EOF`）
- 跟用户说话 → 直接输出文本（不是 `echo` / `printf`）

## CLI 命令参考

终端环境可用 `tabtin` CLI 快速调平台能力：

```bash
tabtin table query "SELECT ..."
tabtin table record insert --table-id <id> --data '{"字段":"值"}'
tabtin table record update --table-id <id> --record-id <rid> --data '{"字段":"值"}'
tabtin browser print --url "<url>" --save /tmp/page.md
```

各 App 的 CLI 全集见对应 Skill：

- 表格操作 → `skills_read("app:tabdata/table-operator")`
- 浏览器操作 → `skills_read("app:tabweb/browser-operator")`
