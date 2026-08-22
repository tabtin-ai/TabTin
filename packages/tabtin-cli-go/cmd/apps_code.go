package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// ─── Code ────────────────────────────────────────────────────────

func newCmdCode(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "code",
		Short: "代码与文件操作",
		Long: `读写文件、搜索代码、执行 Git 操作。

示例：
  tabtin code read --path src/main.go
  tabtin code mkdir --path src/newdir
  tabtin code mv --from old.go --to new.go
  tabtin code grep --pattern "TODO" --glob "*.go"
  tabtin code git status`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "read", Short: "读文件",
			Example: "  tabtin code read --path src/main.go\n  tabtin code read --path README.md --offset 10 --limit 50",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/read",
			Flags: []cmdutil.FlagDef{
				{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "文件路径"},
				{Name: "offset", Type: cmdutil.FlagInt, Desc: "起始行号"},
				{Name: "limit", Type: cmdutil.FlagInt, Desc: "读取行数"},
			},
			HasFormat: true,
		},
		{
			Use: "write", Short: "写文件",
			Example: "  tabtin code write --path test.txt --contents \"hello world\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/write",
			Flags: []cmdutil.FlagDef{
				{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "文件路径"},
				{Name: "contents", Type: cmdutil.FlagString, Required: true, Desc: "文件内容"},
				{Name: "append", Type: cmdutil.FlagBool, Desc: "追加模式"},
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "edit", Short: "编辑文件（替换）",
			Example: "  tabtin code edit --path main.go --old-string \"foo\" --new-string \"bar\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/edit",
			Flags: []cmdutil.FlagDef{
				{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "文件路径"},
				{Name: "old-string", Type: cmdutil.FlagString, Required: true, Desc: "要替换的文本"},
				{Name: "new-string", Type: cmdutil.FlagString, Required: true, Desc: "替换为"},
				{Name: "replace-all", Type: cmdutil.FlagBool, Desc: "替换所有匹配"},
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "delete", Short: "删除文件",
			Example: "  tabtin code delete --path temp.txt",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/delete",
			Flags:     []cmdutil.FlagDef{{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "文件路径"}},
			HasFormat: true, Risk: cmdutil.RiskHigh,
		},
		{
			Use: "mkdir", Short: "创建目录",
			Example: "  tabtin code mkdir --path src/newdir",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/mkdir",
			Flags:     []cmdutil.FlagDef{{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "要创建的目录路径（递归创建，已是目录时幂等成功）"}},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "mv", Short: "移动/重命名文件",
			Example: "  tabtin code mv --from src/old.go --to src/new.go",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/mv",
			Flags: []cmdutil.FlagDef{
				{Name: "from", Type: cmdutil.FlagString, Required: true, Desc: "源路径"},
				{Name: "to", Type: cmdutil.FlagString, Required: true, Desc: "目标路径（已存在时报错，不覆盖）"},
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			// rename 是 mv 的别名（同一 action-tool move_file）：语义完全相同，
			// 只是 --from/--to 命名习惯上更强调"同目录改名"。
			Use: "rename", Short: "重命名文件（mv 的别名）",
			Example: "  tabtin code rename --from src/old.go --to src/new.go",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/rename",
			Flags: []cmdutil.FlagDef{
				{Name: "from", Type: cmdutil.FlagString, Required: true, Desc: "源路径"},
				{Name: "to", Type: cmdutil.FlagString, Required: true, Desc: "目标路径（已存在时报错，不覆盖）"},
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "glob [pattern]", Short: "文件搜索",
			Example: "  tabtin code glob \"*.go\"\n  tabtin code glob \"src/**/*.ts\" --target-directory ./packages\n  tabtin code glob --glob-pattern \"*.go\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/glob",
			Flags: []cmdutil.FlagDef{
				{Name: "glob-pattern", Type: cmdutil.FlagString, Desc: "Glob 模式（也可作为位置参数）"},
				{Name: "target-directory", Type: cmdutil.FlagString, Desc: "搜索目录"},
			},
			ArgsMapping: []string{"glob_pattern"},
			HasFormat:   true,
		},
		{
			Use: "grep [pattern]", Short: "内容搜索（ripgrep）",
			Example: "  tabtin code grep \"TODO\"\n  tabtin code grep \"func.*Error\" --glob \"*.go\" --case-insensitive",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/grep",
			ArgsMapping: []string{"pattern"},
			Flags: []cmdutil.FlagDef{
				{Name: "pattern", Type: cmdutil.FlagString, Desc: "正则表达式（也可作为位置参数）"},
				{Name: "path", Type: cmdutil.FlagString, Desc: "搜索路径"},
				{Name: "glob", Type: cmdutil.FlagString, Desc: "文件过滤 glob"},
				{Name: "type", Type: cmdutil.FlagString, Desc: "文件类型 (go/py/js/...)"},
				{Name: "case-insensitive", Short: "i", Type: cmdutil.FlagBool, Desc: "忽略大小写"},
				{Name: "multiline", Type: cmdutil.FlagBool, Desc: "多行模式"},
				{Name: "context-lines", Type: cmdutil.FlagInt, Desc: "上下文行数"},
				{Name: "max-results", Type: cmdutil.FlagInt, Desc: "最大结果数"},
				{Name: "output-mode", Type: cmdutil.FlagString, Desc: "输出模式 (content/files_with_matches/count)"},
			},
			HasFormat: true,
		},
		{
			Use: "search", Short: "已退役（代码语义搜索）",
			Example: "  tabtin code search --query \"如何处理用户认证\"  # 返回 FEATURE_RETIRED，请使用 grep 或 glob",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/search",
			Flags: []cmdutil.FlagDef{
				{Name: "query", Type: cmdutil.FlagString, Required: true, Desc: "搜索问题"},
				{Name: "target-directory", Type: cmdutil.FlagString, Desc: "搜索目录"},
				{Name: "num-results", Type: cmdutil.FlagInt, Desc: "结果数量（1-15）"},
			},
			HasFormat: true,
		},
		{
			Use: "diagnostics [paths...]", Short: "代码诊断（Linter）",
			Example: "  tabtin code diagnostics\n  tabtin code diagnostics src/main.go\n  tabtin code diagnostics --paths '[\"src/main.go\"]'",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/diagnostics",
			Flags:       []cmdutil.FlagDef{{Name: "paths", Type: cmdutil.FlagString, Desc: "文件路径 JSON 数组"}},
			ArgsMapping: []string{"paths"},
			HasFormat:   true,
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	gitCmd := &cobra.Command{Use: "git", Short: "Git 操作"}
	cmdutil.RegisterCommand(gitCmd, f, cmdutil.CommandDef{
		Use: "status", Short: "Git 状态", Example: "  tabtin code git status",
		Route: cmdutil.RouteCliServer, Method: "POST", Path: "/code/git-status", HasFormat: true,
	})
	cmdutil.RegisterCommand(gitCmd, f, cmdutil.CommandDef{
		Use: "diff", Short: "Git Diff",
		Example: "  tabtin code git diff\n  tabtin code git diff --file-path src/main.go --staged",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/git-diff",
		Flags: []cmdutil.FlagDef{
			{Name: "file-path", Type: cmdutil.FlagString, Desc: "指定文件"},
			{Name: "staged", Type: cmdutil.FlagBool, Desc: "仅暂存区"},
		},
		HasFormat: true,
	})
	cmd.AddCommand(gitCmd)

	worktreeCmd := &cobra.Command{
		Use:   "worktree",
		Short: "管理当前 Agent 对话的 Git worktree",
		Long: `查看、创建或切换当前 Agent 对话绑定的 Git worktree。

切换不会在当前工具执行中途改变目录：命令结果返回后，本轮在安全边界结束，
同一对话会在新 worktree 中自动继续。`,
	}
	cmdutil.RegisterCommand(worktreeCmd, f, cmdutil.CommandDef{
		Use: "current", Short: "查看当前对话绑定的 worktree",
		Example: "  tabtin code worktree current",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/worktree/current", HasFormat: true,
	})
	cmdutil.RegisterCommand(worktreeCmd, f, cmdutil.CommandDef{
		Use: "list", Short: "列出当前仓库的 worktree",
		Example: "  tabtin code worktree list",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/worktree/list", HasFormat: true,
	})
	cmdutil.RegisterCommand(worktreeCmd, f, cmdutil.CommandDef{
		Use: "switch", Short: "切换当前对话到已有 worktree",
		Example: "  tabtin code worktree switch --path /absolute/path/to/worktree",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/worktree/switch",
		Flags: []cmdutil.FlagDef{
			{Name: "path", Type: cmdutil.FlagString, Required: true, Desc: "目标 worktree 的绝对路径"},
		},
		HasFormat: true, Risk: cmdutil.RiskWrite,
	})
	cmdutil.RegisterCommand(worktreeCmd, f, cmdutil.CommandDef{
		Use: "create", Short: "创建 worktree 并切换当前对话",
		Example: "  tabtin code worktree create --new-branch feat/123-task --base release/260812\n  tabtin code worktree create --path /absolute/path/to/wt --existing-branch feat/123-task",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/code/worktree/create",
		Flags: []cmdutil.FlagDef{
			{Name: "path", Type: cmdutil.FlagString, Desc: "新 worktree 的绝对路径；省略时使用 TabTin 托管目录"},
			{Name: "new-branch", Type: cmdutil.FlagString, Desc: "要创建的新分支"},
			{Name: "existing-branch", Type: cmdutil.FlagString, Desc: "要检出的已有分支"},
			{Name: "base", Type: cmdutil.FlagString, Desc: "新分支起点（仅与 --new-branch 同用）"},
		},
		Conflicts: map[string][]string{
			"new-branch":      {"existing-branch"},
			"existing-branch": {"new-branch", "base"},
		},
		RequiresOneOf: [][]string{{"new-branch", "existing-branch"}},
		HasFormat:     true, Risk: cmdutil.RiskWrite,
	})
	cmd.AddCommand(worktreeCmd)

	return cmd
}

// ─── Slide ───────────────────────────────────────────────────────
