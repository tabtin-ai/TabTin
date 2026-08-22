package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/skillbundle"
	"github.com/TabTin/tabtin-cli/internal/version"
)

// newCmdSkills 复数 skills：面向第三方 Agent 的包内 Skill 内省与 ~/.agents/skills 生命周期。
// 与单数 `tabtin skill`（Space/市场）语义分开。
func newCmdSkills(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "skills",
		Short: "第三方 Agent Skill（包内权威副本 ↔ ~/.agents/skills）",
		Long: `内省与安装随 @tabtin/cli 发布的 Skill 包。

包内 skills/ 与当前 CLI 版本绑定，是权威内容；物化到 ~/.agents/skills/tabtin-*
供 Cursor/Claude/Codex 等原生扫描。漂移时用 sync 覆盖回包内版本。

与单数命令 tabtin skill（Space / 市场管理）职责不同，请勿混用。`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use:   "list [name[/path]]",
			Short: "列出包内 Skill，或列出某个 Skill 下一层路径",
			Long: `列出随当前 CLI 发布的 Skill 目录，或像 ls 一样列出某一 Skill 下的一层路径。

权威内容来自包内 skills/，不依赖 Desktop/Daemon。可选 path 用于浏览 references 等子目录。

常见陷阱：外部名一律带 tabtin- 前缀；Space 市场技能请用单数 tabtin skill。`,
			Example: `  tabtin skills list --format json
  tabtin skills list tabtin-tabdoc-operator
  tabtin skills list --dir /tmp/agents-skills`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Idempotent:   true,
			Risk:         cmdutil.RiskRead,
			RiskDeclared: true,
			ArgsMapping:  []string{"path"},
			Flags: []cmdutil.FlagDef{
				{Name: "dir", Type: cmdutil.FlagString, Desc: "用于标注 installed/in_sync 的目标目录", NoFileInput: true},
			},
			Execute: skillsListExecute(f),
		},
		{
			Use:   "read <name> [relative-path]",
			Short: "读取包内 Skill 文件（默认 SKILL.md）",
			Long: `读取包内权威 Skill 文件内容，默认 SKILL.md。

相对路径禁止 .. 穿越。跨 Skill 引用请直接 read 目标 Skill 名，不要用 ../。

常见陷阱：读到的是包内版本；磁盘 ~/.agents/skills 副本可能漂移，以本命令为准。`,
			Example: `  tabtin skills read tabtin-tabdoc-operator
  tabtin skills read tabtin-tabdoc-operator references/foo.md
  tabtin skills read tabtin-tabdoc-operator/SKILL.md`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Idempotent:   true,
			Risk:         cmdutil.RiskRead,
			RiskDeclared: true,
			ArgsMapping:  []string{"name", "path"},
			Execute:      skillsReadExecute(f),
		},
		{
			Use:   "install",
			Short: "将包内 Skill 物化到第三方 Agent 目录（默认 ~/.agents/skills）",
			Long: `把包内 Skill 复制到第三方 Agent 可扫描目录（默认 ~/.agents/skills）。

每个目录写入 .tabtin-skill.json 所有权标记。同名但非 TabTin 管理的目录会报冲突，不覆盖。

常见陷阱：安装不等于设备/登录态可用；runtime 元数据仍需 Agent 自行诊断。`,
			Example: `  tabtin skills install --target agents
  tabtin skills install --target agents --name tabtin-tabdoc-operator
  tabtin skills install --dir /tmp/agents-skills --dry-run`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Risk:         cmdutil.RiskWrite,
			RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "target", Type: cmdutil.FlagEnum, Enum: []string{"agents"}, Default: "agents", Desc: "安装目标（首版仅 agents）"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "只安装指定外部名", NoFileInput: true},
				{Name: "dir", Type: cmdutil.FlagString, Desc: "覆盖目标目录（默认 TABTIN_AGENTS_SKILLS_DIR 或 ~/.agents/skills）", NoFileInput: true},
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return skillsWriteDryRun(ctx, "install")
			},
			Execute: skillsInstallExecute(f),
		},
		{
			Use:   "sync",
			Short: "用包内权威版本覆盖本包已安装的 Skill（不碰非 TabTin 目录）",
			Long: `将 ~/.agents/skills 下本包管理的 tabtin-* 目录强制同步回当前包内版本。

只改带 .tabtin-skill.json 且 managed_by=tabtin 的目录；冲突目录跳过并列入 conflicts。

常见陷阱：sync 会丢掉你对物化副本的本地改动——要以包内为准请先确认。`,
			Example: `  tabtin skills sync
  tabtin skills sync --dir /tmp/agents-skills
  tabtin skills sync --dry-run`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Risk:         cmdutil.RiskWrite,
			RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "dir", Type: cmdutil.FlagString, Desc: "覆盖目标目录", NoFileInput: true},
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return skillsWriteDryRun(ctx, "sync")
			},
			Execute: skillsSyncExecute(f),
		},
		{
			Use:   "doctor",
			Short: "检查 CLI/Skill 漂移、冲突与缺失",
			Long: `对比包内权威 Skill 与物化目录，报告漂移、冲突、缺失与孤儿目录。

ok=false 时进程退出码为 1，便于脚本门禁。不修改任何文件。

常见陷阱：未 install 时全部记为 missing，属预期；先 install 再 doctor。`,
			Example: `  tabtin skills doctor --format json
  tabtin skills doctor --dir /tmp/agents-skills
  tabtin skills doctor`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Idempotent:   true,
			Risk:         cmdutil.RiskRead,
			RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "dir", Type: cmdutil.FlagString, Desc: "覆盖目标目录", NoFileInput: true},
			},
			Execute: skillsDoctorExecute(f),
		},
		{
			Use:   "remove",
			Short: "移除本包安装的 Skill（仅 .tabtin-skill.json 标记的目录）",
			Long: `删除第三方 Agent 目录中由本包安装的 Skill。

只删除 managed_by=tabtin 的目录；用户自建或冲突目录一律跳过。需要 --yes。

常见陷阱：缺 --yes 返回 confirmation_required，Agent 不得自动追加 --yes。`,
			Example: `  tabtin skills remove --yes
  tabtin skills remove --name tabtin-tabdoc-operator --yes
  tabtin skills remove --dry-run`,
			Route:        cmdutil.RouteDirect,
			Runtime:      cmdutil.RuntimeLocal,
			Layer:        "L2",
			HasFormat:    true,
			Risk:         cmdutil.RiskDestructive,
			RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Desc: "只移除指定外部名", NoFileInput: true},
				{Name: "dir", Type: cmdutil.FlagString, Desc: "覆盖目标目录", NoFileInput: true},
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return skillsWriteDryRun(ctx, "remove")
			},
			Execute: skillsRemoveExecute(f),
		},
	}

	for _, def := range defs {
		cmdutil.MustRegisterCommand(cmd, f, def)
	}
	return cmd
}

func skillsWriteDryRun(ctx *cmdutil.RunContext, action string) *cmdutil.DryRunPlan {
	dir := agentsDirFromCtx(ctx)
	names := flagNames(ctx)
	body := map[string]any{
		"action": action,
		"dir":    dir,
		"names":  names,
	}
	if action == "remove" {
		body["note"] = "only directories with .tabtin-skill.json managed_by=tabtin"
	}
	return &cmdutil.DryRunPlan{
		Description: action + " tabtin skills in agents directory",
		Plan: []cmdutil.DryRunStep{{
			Step:   1,
			Method: "FS",
			URL:    dir,
			Body:   body,
		}},
	}
}

func openSkillsBundle() (*skillbundle.Bundle, error) {
	root, err := skillbundle.ResolveBundleRoot()
	if err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound),
			err.Error(),
			"先运行 node packages/tabtin-cli/scripts/generate-skills-bundle.cjs，或设置 TABTIN_SKILLS_BUNDLE_DIR",
			output.ExitNotFound,
		))
	}
	b, err := skillbundle.OpenBundle(root)
	if err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			err.Error(),
			"检查 skills/manifest.json 是否由 generate-skills-bundle 生成",
			output.ExitInternal,
		))
	}
	return b, nil
}

func agentsDirFromCtx(ctx *cmdutil.RunContext) string {
	if d := strings.TrimSpace(ctx.Str("dir")); d != "" {
		return d
	}
	return skillbundle.ResolveAgentsSkillsDir()
}

func flagNames(ctx *cmdutil.RunContext) []string {
	if n := strings.TrimSpace(ctx.Str("name")); n != "" {
		return []string{n}
	}
	return nil
}

func skillsListExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		pathArg := ""
		if len(ctx.Args) > 0 {
			pathArg = strings.TrimSpace(ctx.Args[0])
		}
		agentsDir := agentsDirFromCtx(ctx)

		if pathArg == "" {
			list, err := b.List(agentsDir)
			if err != nil {
				return err
			}
			result := map[string]any{
				"skills":         list,
				"count":          len(list),
				"bundle_version": b.Manifest.BundleVersion,
				"cli_version":    b.Manifest.CLIVersion,
				"runtime_cli":    version.Version,
				"bundle_root":    b.Root,
				"agents_dir":     agentsDir,
			}
			// 与 tabtin commands 一样：协议输出必须完整内联，避免 64KB 落盘破坏 Agent 发现。
			output.PrintResultWithSchemaInline(output.SuccessEnvelope(result), f.Format, nil)
			return nil
		}

		name, rel := splitSkillPath(pathArg)
		entries, err := b.ListPath(name, rel)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound),
				err.Error(),
				"用法: tabtin skills list [name[/path]]",
				output.ExitNotFound,
			))
		}
		listed := name
		if rel != "" {
			listed = name + "/" + rel
		}
		output.PrintResultWithSchemaInline(output.SuccessEnvelope(map[string]any{
			"path":    listed,
			"entries": entries,
			"count":   len(entries),
		}), f.Format, nil)
		return nil
	}
}

func skillsReadExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		if len(ctx.Args) < 1 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"缺少 skill 名称",
				"用法: tabtin skills read <name> [relative-path]",
				output.ExitValidation,
			))
		}
		name := strings.TrimSpace(ctx.Args[0])
		rel := ""
		if len(ctx.Args) > 1 {
			rel = strings.TrimSpace(ctx.Args[1])
		}
		if rel == "" && strings.Contains(name, "/") {
			name, rel = splitSkillPath(name)
		}
		data, path, err := b.Read(name, rel)
		if err != nil {
			code := errcode.NotFound
			exit := output.ExitNotFound
			if strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "escapes") {
				code = errcode.ValidationError
				exit = output.ExitValidation
			}
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(code),
				err.Error(),
				fmt.Sprintf("用法: tabtin skills read %s [relative-path]", name),
				exit,
			))
		}
		output.PrintResultWithSchemaInline(output.SuccessEnvelope(map[string]any{
			"name":    name,
			"path":    path,
			"content": string(data),
		}), f.Format, nil)
		return nil
	}
}

func skillsInstallExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		target := strings.TrimSpace(ctx.Str("target"))
		if target == "" {
			target = "agents"
		}
		if target != "agents" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("不支持的 target %q", target),
				"首版仅支持 --target agents",
				output.ExitValidation,
			))
		}
		dir := agentsDirFromCtx(ctx)
		res, err := b.Install(dir, flagNames(ctx))
		if err != nil {
			if c, ok := err.(*skillbundle.ConflictError); ok {
				return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
					string(errcode.Conflict),
					c.Error(),
					"请手动处理冲突目录，或换 TABTIN_AGENTS_SKILLS_DIR；sync/remove 不会覆盖非 TabTin Skill",
					output.ExitGeneral,
					output.ErrorEnvelopeOpts{
						Detail: map[string]any{
							"conflicts": res.Conflicts,
							"result":    res,
						},
					},
				))
			}
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				err.Error(),
				"检查目标目录写权限",
				output.ExitInternal,
			))
		}
		output.PrintResult(output.SuccessEnvelope(res), f.Format)
		return nil
	}
}

func skillsSyncExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		dir := agentsDirFromCtx(ctx)
		res, err := b.Sync(dir)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				err.Error(),
				"检查目标目录写权限",
				output.ExitInternal,
			))
		}
		output.PrintResult(output.SuccessEnvelope(res), f.Format)
		return nil
	}
}

func skillsDoctorExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		dir := agentsDirFromCtx(ctx)
		rep, err := b.Doctor(dir)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				err.Error(),
				"检查 agents 目录是否可读",
				output.ExitInternal,
			))
		}
		// 运行中二进制版本写入报告，便于对照 manifest.cli_version
		type doctorOut struct {
			*skillbundle.DoctorReport
			RuntimeCLI string `json:"runtime_cli"`
		}
		out := doctorOut{DoctorReport: rep, RuntimeCLI: version.Version}
		output.PrintResult(output.SuccessEnvelope(out), f.Format)
		if !rep.OK {
			return output.NewExitError(output.ExitGeneral)
		}
		return nil
	}
}

func skillsRemoveExecute(f *cmdutil.Factory) func(*cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		b, err := openSkillsBundle()
		if err != nil {
			return err
		}
		dir := agentsDirFromCtx(ctx)
		res, err := b.Remove(dir, flagNames(ctx))
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				err.Error(),
				"检查目标目录权限",
				output.ExitInternal,
			))
		}
		output.PrintResult(output.SuccessEnvelope(res), f.Format)
		return nil
	}
}

func splitSkillPath(arg string) (name, rel string) {
	arg = strings.TrimSpace(strings.ReplaceAll(arg, "\\", "/"))
	arg = strings.TrimPrefix(arg, "/")
	parts := strings.SplitN(arg, "/", 2)
	name = parts[0]
	if len(parts) > 1 {
		rel = parts[1]
	}
	return name, rel
}
