package cmdutil

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

type registeredCommand struct {
	Cmd *cobra.Command
	Def CommandDef
}

var registeredCommands []registeredCommand

func GetRegisteredCommands() []CommandSchema {
	schemas := make([]CommandSchema, 0, len(registeredCommands))
	for _, entry := range registeredCommands {
		// Hidden 命令仍输出 schema（供受限模式 risk map 经 --include-hidden 读取），
		// 默认发现面由 FilterVisibleCommandSchemas / `tabtin commands` 剔除
		//（ memo /  slide create 等）。
		hidden := entry.Def.Hidden || (entry.Cmd != nil && entry.Cmd.Hidden)
		flags := make([]FlagSchema, 0, len(entry.Def.Flags))
		for _, f := range entry.Def.Flags {
			flags = append(flags, FlagSchema{
				Name:     f.Name,
				Type:     string(f.Type),
				Required: f.Required,
				Default:  f.Default,
				Desc:     f.Desc,
				Enum:     f.Enum,
				CliOnly:  f.CliOnly,
			})
		}
		schemas = append(schemas, CommandSchema{
			Name:          commandSchemaName(entry.Cmd),
			Description:   entry.Def.Short,
			Long:          entry.Def.Long,
			Example:       entry.Def.Example,
			Aliases:       entry.Def.Aliases,
			ArgsMapping:   entry.Def.ArgsMapping,
			Method:        entry.Def.Method,
			Path:          entry.Def.Path,
			Risk:          string(entry.Def.Risk),
			RiskDeclared:  entry.Def.RiskDeclared,
			Idempotent:    entry.Def.Idempotent,
			HasFormat:     entry.Def.HasFormat,
			RequiresAuth:  entry.Def.RequiresAuth,
			Runtime:       string(entry.Def.EffectiveRuntime()),
			Flags:         flags,
			OutputSchema:  entry.Def.OutputSchema,
			Showcase:      entry.Def.Showcase,
			ShowcaseGroup: entry.Def.ShowcaseGroup,
			AIHelp:        entry.Def.AIHelp,
			Hidden:        hidden,
		})
	}
	return schemas
}

// FilterVisibleCommandSchemas 去掉 Hidden 命令，供默认 `tabtin commands` 发现面使用。
func FilterVisibleCommandSchemas(schemas []CommandSchema) []CommandSchema {
	if len(schemas) == 0 {
		return schemas
	}
	out := make([]CommandSchema, 0, len(schemas))
	for _, schema := range schemas {
		if schema.Hidden {
			continue
		}
		out = append(out, schema)
	}
	return out
}

func commandSchemaName(cmd *cobra.Command) string {
	if cmd == nil {
		return ""
	}
	name := cmd.CommandPath()
	return strings.TrimPrefix(name, "tabtin ")
}

// groupDescription 合成 group 条目的召回友好描述：Short + Long 首行。
//
// group 的 Short 通常太干（`doc` → "文档操作"），与用户 query（"帮我列出所有
// 文档"）词面交集太小，BM25/语义召回排不进 Top-N；Long 首行是完整句功能描述
// （"创建、浏览和管理 TabDoc 文档。"）。实测（work-for-tabtin eval E 层）拼上
// Long 首行后 `doc` 入口从召回 Top-8 之外升到第 2。
func groupDescription(c *cobra.Command) string {
	short := strings.TrimSpace(c.Short)
	longFirst := ""
	for _, line := range strings.Split(c.Long, "\n") {
		if l := strings.TrimSpace(line); l != "" {
			longFirst = l
			break
		}
	}
	if longFirst == "" || longFirst == short {
		return short
	}
	if short == "" {
		return longFirst
	}
	return short + "：" + longFirst
}

// CollectGroupSchemas 遍历 cobra 命令树，为 pure group 命令（无 CommandDef 注册、
// 只路由子命令的父命令，如 `doc` / `mcp` / `browser tab`）合成 CommandSchema——
// 让 `tabtin commands --format json` 也收录入口命令。
//
// 之前只输出 registeredCommands（leaf + 手写 RegisterCommandSchema），relevant-cli
// 召回池对 `tabtin doc` 这类入口命令零召回，Agent 只能靠静态索引兜底。
//
// 合成条目带 IsGroup=true + Subcommands 子命令名列表；Risk 留空（裸跑仅显示
// help，只读），但消费侧受限模式 allowlist 必须按 IsGroup 跳过（防前缀误放行）。
//
// 跳过：隐藏命令、cobra 内置 help / completion、已注册 CommandDef 的命令
// （后者已在 GetRegisteredCommands 输出里）。
func CollectGroupSchemas(root *cobra.Command) []CommandSchema {
	registered := make(map[*cobra.Command]bool, len(registeredCommands))
	for _, entry := range registeredCommands {
		registered[entry.Cmd] = true
	}

	var out []CommandSchema
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, child := range c.Commands() {
			if child.Hidden || child.Name() == "help" || child.Name() == "completion" {
				continue
			}
			if !child.HasSubCommands() {
				continue
			}
			if !registered[child] {
				subs := make([]string, 0, len(child.Commands()))
				for _, sub := range child.Commands() {
					if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
						continue
					}
					subs = append(subs, sub.Name())
				}
				out = append(out, CommandSchema{
					Name:        commandSchemaName(child),
					Description: groupDescription(child),
					Long:        child.Long,
					IsGroup:     true,
					Subcommands: subs,
				})
			}
			walk(child)
		}
	}
	walk(root)
	return out
}

// RegisterCommandSchema 仅注册命令的元数据 schema 到 `tabtin commands` 输出，
// 不接管 cobra 命令的 RunE 执行。
//
// 用途：当命令的输入/输出格式特殊（如 `tabtin search` 需要自定义 stderr 警告 +
// 双模 stdout 输出），无法走通用 `executePipeline` 流程时，CLI 仍要让 Agent 通过
// `tabtin commands | jq` 自动发现该命令存在与参数定义。
//
// cmd 可以在挂到最终 root 之前注册；`tabtin commands` 输出时会延迟解析 CommandPath。
func RegisterCommandSchema(cmd *cobra.Command, def CommandDef) {
	registeredCommands = append(registeredCommands, registeredCommand{Cmd: cmd, Def: def})
}

// LookupOutputSchema 按 cmd 反查已注册的 OutputSchema——供手写命令的 RunE
// 在 output.PrintResultWithSchema 时传入正确的 schema。
//
// 用法（手写命令）：
//
//	schema := cmdutil.LookupOutputSchema(cmd)
//	output.PrintResultWithSchema(env, f.Format, schema)
//
// 走 RegisterCommand / MustRegisterCommand 的 pipeline 命令不需要调用——pipeline 内部
// 已直接读 def.OutputSchema。
//
// 返回 nil 表示没找到（cmd 没注册 schema 或 OutputSchema 字段为空）。
func LookupOutputSchema(cmd *cobra.Command) []FieldSchema {
	for _, entry := range registeredCommands {
		if entry.Cmd == cmd {
			return entry.Def.OutputSchema
		}
	}
	return nil
}

// GetCommandDef 按 cobra.Command 反查注册时登记的 CommandDef 副本。
//
// Visible for testing only —— 给 cmd 包的 *_test.go 做注册期 invariant 断言用
// （例如 apps_doc_test.go 遍历 doc 命令树，确认所有写命令都声明了 DryRun 钩子 +
// 所有命令都设了 RiskDeclared:true），把 MustRegisterCommand 的注册期 panic
// 提前到 `go test`，避免「跑 ./dist/tabtin --help 才能 catch 漏字段」的滞后。
//
// 生产代码请通过 pipeline 入口正常获取 def，不要直接调本函数。
//
// 返回 nil 表示：
//   - cmd 为 nil；或
//   - cmd 不是走 RegisterCommand / MustRegisterCommand 注册的（如纯 namespace
//     父命令 `doc` / `doc version`，它们是手写 cobra.Command 后用 AddCommand
//     挂子命令、自身没有关联 CommandDef）。
func GetCommandDef(cmd *cobra.Command) *CommandDef {
	if cmd == nil {
		return nil
	}
	for _, entry := range registeredCommands {
		if entry.Cmd == cmd {
			def := entry.Def
			return &def
		}
	}
	return nil
}

// SetCommandShowcase 更新已注册命令的 Showcase 元数据（供 doc_showcase 注册后 overlay）。
func SetCommandShowcase(cmd *cobra.Command, showcase bool, group string) {
	if cmd == nil {
		return
	}
	for i := range registeredCommands {
		if registeredCommands[i].Cmd == cmd {
			registeredCommands[i].Def.Showcase = showcase
			registeredCommands[i].Def.ShowcaseGroup = group
			return
		}
	}
}

// SetCommandAIHelp 更新已注册命令的 AIHelp 元数据（供 doc_ai_help 注册后 overlay）。
func SetCommandAIHelp(cmd *cobra.Command, aiHelp string) {
	if cmd == nil {
		return
	}
	for i := range registeredCommands {
		if registeredCommands[i].Cmd == cmd {
			registeredCommands[i].Def.AIHelp = aiHelp
			return
		}
	}
}

// MustRegisterCommand 是规范 v1 RFC 引入的"严格注册"——在 RegisterCommand 之上
// 强制 cli-spec.md §3.2 / §9 / §11 的注册期断言，违反任一条直接 panic。
//
// 必填字段：Use / Short / Long(≥3 行) / Example(≥3 个) / Layer(L1|L2|L3) / Risk
// 必填钩子：Method+Path 或 RunFunc 或 Execute 至少一组；Risk != RiskRead 时必须有 DryRun
//
// 新写命令应该用本函数，不要用 RegisterCommand。
// 存量 105+ 命令保留 RegisterCommand 路径，逐批迁移到 MustRegisterCommand。
func MustRegisterCommand(parent *cobra.Command, f *Factory, def CommandDef) *cobra.Command {
	assertSpecCompliant(def, parent.CommandPath())
	return RegisterCommand(parent, f, def)
}

// assertSpecCompliant 实现规范 v1 RFC 的注册期断言。
// 违反任一条直接 panic——目的是让规范违规在开发期就暴露，而不是 PR review 时才发现。
func assertSpecCompliant(def CommandDef, parentPath string) {
	if def.Layer != "L1" && def.Layer != "L2" && def.Layer != "L3" {
		panic(fmt.Sprintf("MustRegisterCommand: command %q (parent=%s) Layer 必须是 L1 / L2 / L3，当前为 %q", def.Use, parentPath, def.Layer))
	}

	// 必须显式声明 Risk —— 因为 RiskRead 字符串值是 ""（与零值同），单靠类型检查
	// 无法区分"忘填"vs"显式 RiskRead"。要求调用方写 RiskDeclared: true 显式确认。
	if !def.RiskDeclared {
		panic(fmt.Sprintf("MustRegisterCommand: command %q 必须显式声明 Risk + 加 RiskDeclared: true（防止忘填 Risk 被默认为 RiskRead 绕过 dry-run 断言）", def.Use))
	}

	if def.Risk != RiskRead && def.Risk != RiskWrite && def.Risk != RiskDestructive {
		panic(fmt.Sprintf("MustRegisterCommand: command %q Risk 必须是 RiskRead / RiskWrite / RiskDestructive，当前为 %q", def.Use, string(def.Risk)))
	}

	// Long ≥ 3 行实质内容（去空行去缩进后）
	longLines := 0
	for _, line := range strings.Split(def.Long, "\n") {
		if strings.TrimSpace(line) != "" {
			longLines++
		}
	}
	if longLines < 3 {
		panic(fmt.Sprintf("MustRegisterCommand: command %q Long 实质内容 < 3 行（当前 %d 行）；按规范 §11.1 必须含做什么、设计理由、常见陷阱三段", def.Use, longLines))
	}

	// Example ≥ 3 个独立用例（按非空行近似计数）
	exampleLines := 0
	for _, line := range strings.Split(def.Example, "\n") {
		// 计 example 命令行：以 tabtin / echo 等可执行开头
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "tabtin ") || strings.HasPrefix(trimmed, "echo ") || strings.HasPrefix(trimmed, "$ ") || strings.HasPrefix(trimmed, "# ") {
			exampleLines++
		} else if !strings.HasPrefix(trimmed, "//") && !strings.HasPrefix(trimmed, "#") {
			// 兜底：把非注释行也算
			exampleLines++
		}
	}
	if exampleLines < 3 {
		panic(fmt.Sprintf("MustRegisterCommand: command %q Example 独立用例 < 3 个（当前 %d）；按规范 §11.2 至少覆盖常用/带可选/边界三种场景", def.Use, exampleLines))
	}

	// Risk != RiskRead 时必填 DryRun 钩子（spec §9.1）
	if def.Risk != RiskRead && def.DryRun == nil {
		panic(fmt.Sprintf("MustRegisterCommand: command %q Risk=%s 必须实现 DryRun 钩子（规范 §9.1：能 dry-run 才能写）", def.Use, string(def.Risk)))
	}
}

func RegisterCommand(parent *cobra.Command, f *Factory, def CommandDef) *cobra.Command {
	if def.Use == "" {
		panic(fmt.Sprintf("RegisterCommand: Use is empty (parent=%s)", parent.CommandPath()))
	}
	if def.Short == "" {
		panic(fmt.Sprintf("RegisterCommand: Short is empty (command=%s)", def.Use))
	}
	if def.Method == "" && def.Path == "" && def.RunFunc == nil && def.Execute == nil {
		panic(fmt.Sprintf("RegisterCommand: command %q has no Method/Path and no RunFunc/Execute — it would do nothing", def.Use))
	}
	if def.Example == "" && os.Getenv("TABTIN_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "[warn] RegisterCommand: command %q has no Example — LLM discoverability degraded\n", def.Use)
	}
	if def.RunFunc != nil && def.Method != "" && def.Path != "" && os.Getenv("TABTIN_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "[warn] RegisterCommand: command %q has both RunFunc and Method/Path — RunFunc takes precedence, Method/Path will be ignored at runtime\n", def.Use)
	}

	cmd := &cobra.Command{
		Use:     def.Use,
		Short:   def.Short,
		Long:    def.Long,
		Example: def.Example,
		Aliases: def.Aliases,
		// Hidden 命令仍可运行；`--help` 由 cobra 隐去，默认 `tabtin commands`
		// 经 FilterVisibleCommandSchemas 剔除，risk map 用 --include-hidden 保留。
		Hidden: def.Hidden,
		RunE: SafeRunE(func(cmd *cobra.Command, args []string) error {
			return executePipeline(cmd, args, f, def)
		}),
	}

	allFlags := append(append([]FlagDef(nil), def.Flags...), positionalAliasFlags(def)...)
	for _, flag := range allFlags {
		switch flag.Type {
		case FlagString:
			d, _ := flag.Default.(string)
			// 自动在 Desc 后追加 input 抽象提示——与执行层 resolveInputAbstraction 严格对齐
			// （TabData v8 P1：之前给所有 FlagString 加提示，但 -id/-token 类 flag
			// 启发式不启用——help 显示支持 @file 但实际不解析，agent 会被误导）
			desc := flag.Desc
			if shouldEnableInputAbstraction(flag) {
				if desc == "" {
					desc = "(supports @file, - for stdin)"
				} else {
					desc = desc + " (supports @file, - for stdin)"
				}
			}
			if flag.Short != "" {
				cmd.Flags().StringP(flag.Name, flag.Short, d, desc)
			} else {
				cmd.Flags().String(flag.Name, d, desc)
			}
		case FlagFile:
			// FlagFile 用字符串 flag 注册；不参与 input 抽象——它的语义就是路径本身
			// （Sprint 1.B D7：只做 SafeInputPath 校验，不读内容）
			d, _ := flag.Default.(string)
			if flag.Short != "" {
				cmd.Flags().StringP(flag.Name, flag.Short, d, flag.Desc)
			} else {
				cmd.Flags().String(flag.Name, d, flag.Desc)
			}
		case FlagInt:
			d, _ := flag.Default.(int)
			cmd.Flags().Int(flag.Name, d, flag.Desc)
		case FlagBool:
			d, _ := flag.Default.(bool)
			cmd.Flags().Bool(flag.Name, d, flag.Desc)
		case FlagStringArray:
			cmd.Flags().StringArray(flag.Name, nil, flag.Desc)
		case FlagStringSlice:
			// 与 StringArray 区别：StringSlice 是 "--tags a,b,c" 逗号分隔语义
			cmd.Flags().StringSlice(flag.Name, nil, flag.Desc)
		case FlagFloat:
			d, _ := flag.Default.(float64)
			cmd.Flags().Float64(flag.Name, d, flag.Desc)
		case FlagDuration:
			d, _ := flag.Default.(time.Duration)
			cmd.Flags().Duration(flag.Name, d, flag.Desc)
		case FlagEnum:
			// Enum 当下作为 string flag 注册；framework 在 Validate 之前做强校验
			// （ValidatePipeline 钩子接入后实现 LINT-FLAG-ENUM-ENFORCE）
			d, _ := flag.Default.(string)
			cmd.Flags().String(flag.Name, d, flag.Desc)
			if len(flag.Enum) > 0 {
				_ = cmd.RegisterFlagCompletionFunc(flag.Name, func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
					return flag.Enum, cobra.ShellCompDirectiveNoFileComp
				})
			}
		default:
			panic(fmt.Sprintf("RegisterCommand: command %q flag %q 使用未知 Type %q（闭集：FlagString/FlagInt/FlagBool/FlagStringArray/FlagStringSlice/FlagFloat/FlagDuration/FlagFile/FlagEnum）", def.Use, flag.Name, string(flag.Type)))
		}
		if flag.Required {
			_ = cmd.MarkFlagRequired(flag.Name)
		}
		if flag.Hidden {
			_ = cmd.Flags().MarkHidden(flag.Name)
		}
	}

	if len(def.Tips) > 0 {
		origHelp := cmd.HelpFunc()
		cmd.SetHelpFunc(func(c *cobra.Command, args []string) {
			origHelp(c, args)
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, "Tips:")
			for _, tip := range def.Tips {
				fmt.Fprintf(os.Stderr, "  • %s\n", tip)
			}
		})
	}

	parent.AddCommand(cmd)

	registeredCommands = append(registeredCommands, registeredCommand{Cmd: cmd, Def: def})

	return cmd
}

func executePipeline(cmd *cobra.Command, args []string, f *Factory, def CommandDef) error {
	allFlags := append(append([]FlagDef(nil), def.Flags...), positionalAliasFlags(def)...)
	flagValues, err := extractFlagValues(cmd, allFlags)
	if err != nil {
		return err
	}
	if batch, _ := cmd.Flags().GetString("batch"); batch != "" {
		flagValues["batch"] = batch
	}
	reqCtx := cmd.Context()
	ctx := &RunContext{
		Factory:      f,
		Args:         args,
		FlagValues:   flagValues,
		ReqContext:   reqCtx,
		Stdin:        cmd.InOrStdin(),
		OutputSchema: def.OutputSchema, // Sprint 1.C：让所有 PrintResult 调用点都能取到 schema
	}

	coalescePositionalAliases(cmd, ctx, def)

	if err := validateArgsMapping(cmd, ctx.Args, def); err != nil {
		return err
	}

	// --output + --jq 互斥（Sprint 1.C 决策 C7）：避免"用户以为写 jq 结果实际写 raw response"的歧义
	//
	// v10.5 P1 修复：拓展覆盖命令级 CliOnly --output。之前 root.PersistentPreRunE
	// 只拦 root persistent --output + --jq；命令级 CliOnly -o（如 `table export csv -o`）
	// 绕过——dry-run 时 jq 生效、真实执行 raw 写盘绕过 jq——同一组合不同语义。
	if f.JQExpr != "" {
		// 全局 root --output（已被 root.PersistentPreRunE 拦，这里是 belt-and-suspenders）
		if f.OutputPath != "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"--output 与 --jq 不能同时使用",
				"二选一：写 envelope 到文件用 --output；过滤后输出用 --jq",
				output.ExitValidation,
			))
		}
		// 命令级 CliOnly --output（v10.5 P1：之前缝隙）
		if cmdOut, ok := ctx.FlagValues["output"].(string); ok && cmdOut != "" {
			for _, fd := range def.Flags {
				if fd.Name == "output" && fd.CliOnly {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.ValidationError),
						"命令级 --output 与全局 --jq 不能同时使用",
						"二选一：写 raw response 到文件用 -o/--output；过滤后输出用 --jq（拿掉一个）",
						output.ExitValidation,
					))
				}
			}
		}
	}

	// Declarative validation（Sprint 1.B D3）：
	// 命令级 Conflicts / RequiresOneOf 先于 input resolver——
	// 防 "--a @missing --b x" 先报文件不存在再报冲突 / 浪费 stdin
	// batch 模式跳过命令级 RequiresOneOf（D2）；Conflicts 始终跑（D1）
	isBatch := false
	if batchPath, ok := ctx.FlagValues["batch"].(string); ok && batchPath != "" {
		isBatch = true
	}
	// 顶层：违规 → 打印完整 envelope JSON 到 stderr + 非零退出
	if issue := validateConflicts(def, ctx); issue != nil {
		return issue.toExit()
	}
	if !isBatch {
		if issue := validateRequiresOneOf(def, ctx); issue != nil {
			return issue.toExit()
		}
	}

	// Input 抽象（Sprint 1.B D3 + D4）：
	// declarative validate 通过后再读文件 / stdin——避免无效输入也消耗资源
	// batch 路径不调本函数（D4：line JSON 不二次解析 @file / -）
	if !isBatch {
		if err := resolveInputAbstraction(def, ctx); err != nil {
			return err
		}
	}
	if err := validateJSONLikeFlagStrings(def, ctx); err != nil {
		return err
	}

	// --dry-run 是**纯本地预演**——不发任何网络请求、不读用户身份、不需要 backend——
	// 因此完全不该被 RequiresAuth / RequiresAgent 闸门拦死。提前读 dry-run flag
	// 并把整个 auth/agent 解析块用 !dryRun 包住，让无 ~/.tabtin/config.json 的
	// fresh 环境（如 CI runner、新装机器）也能跑 dry-run 看 plan。
	//
	// 起因：CI 上 4 个 dry-run 测试（TestDryRunQuietStillOutputsPlanFallback /
	// TestDryRunOutputWritesPlanToFile / TestDryRunQuietOutputAllThree /
	// TestJQAppliedToDryRunPlan）固定失败，根因就是 CI 无 config.json 时
	// RequiresAuth 把 dry-run 也拦了。本地能跑过是因为开发机有 config.json
	// ( placeholder 留下)——典型"测试在开发机绿、CI 红" 模式。
	//
	// 注意 dryRun 在这里**提前**读，与 468 行后面那个 `dryRun, _ := ...` 重复——
	// 后面那个保留以减少 diff 噪声；两次 GetBool 都是 cobra flag 解析后的查询，
	// 完全等价（且 cobra Flags() 内部缓存）。
	dryRun, _ := cmd.Flags().GetBool("dry-run")

	if !dryRun && (def.RequiresAuth || def.RequiresAgent || def.Route == RouteCliServer) {
		cfg, err := f.Config()
		if err != nil {
			return err
		}
		profile := cfg.CurrentProfileConfig()

		if def.RequiresAuth {
			token := config.ResolveToken(profile)
			hostManaged := false
			if token == "" {
				if tr, transportErr := f.Transport(); transportErr == nil {
					hostManaged = transport.AuthSourceOf(tr) == transport.AuthSourceHost
				}
			}
			if token == "" && !hostManaged {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unauthorized),
					"需要认证。请先运行 'tabtin auth login'。",
					"tabtin auth login --url <url> --token <token>",
					output.ExitAuth,
				))
			}
		}

		ctx.AgentID = config.ResolveAgentID(profile)
		ctx.SpaceID = config.ResolveSpaceID(profile)
		ctx.OrganizationID = config.ResolveOrganizationID(profile)

		if def.RequiresAgent && ctx.AgentID == "" && ctx.SpaceID == "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"需要指定 Agent。请先运行 'tabtin agent use <id>'。",
				"tabtin agent list",
				output.ExitValidation,
			))
		}
	}

	// 执行顺序（按 cli-spec.md §8.4 + 规范 §9.4，TabData v5 P0 修复后的完整 gate 图）：
	//
	//   1. RiskDestructive 强制 --yes        ← 真实执行（含 batch）都要确认
	//   2. dry-run 拦截：
	//      - batch + dry-run：executeBatchCommandDryRun 对每行 lineCtx 调 DryRun 打印 plan
	//      - 非 batch + dry-run：调 def.DryRun 钩子
	//   3. batch 真实执行：executeBatchCommand 对每行 merge → lineCtx Validate → buildRequestBody → transport
	//   4. 非 batch 非 dry-run：Validate → Execute / RunFunc / transport
	//
	// **关键设计取舍**（TabData v5 P0 review 后定稿）：
	//
	// - RiskDestructive --yes 必须在 batch 之前——destructive batch 不传 --yes 也能
	//   执行是安全 bug（v4 修复 batch 顺序时漏掉的）。dry-run 不需要 --yes（只预演）。
	//
	// - dry-run 必须在 batch 真实执行之前——`--batch --dry-run` 应该是"预演每行"，
	//   不应该真实打到后端（v4 修复 batch 顺序时漏掉的）。
	//
	// - batch 必须在命令级 Validate 之前——命令级 Validate 要求全部必填，
	//   但 batch 行 JSON 提供这些字段（v3 修复 batch 顺序时正确处理的）。
	//   executeBatchCommand 内部对每行 lineCtx 跑 Validate（pipeline.go::executeBatchCommand）。
	//
	// - dry-run 不跑命令级 Validate——dry-run 仅展示请求形态，
	//   实际请求是否合法应该看 plan 含的内容判断，不是 pipeline 帮你校验。
	//   这与 v3 P1 review 早期取向（"plan 必须基于校验过的输入"）有变化——
	//   batch + dry-run 场景下命令级 Validate 必失败（缺必填），跑了反而误导。
	//   非 batch 命令的 def.Validate 自己在 DryRun 钩子内调即可。

	// dryRun 已在 RequiresAuth 闸门前提前读出，此处直接复用
	batchPath, _ := ctx.FlagValues["batch"].(string)
	// isBatch 已在前面 declarative validation 阶段计算

	// ───── 1. RiskDestructive 强制 --yes（dry-run 跳过——只预演不执行）─────
	// Agent 协议：缺 --yes 时返回 confirmation_required，附带 risk.level/action；
	// Agent 不得自动追加 --yes，须等用户明确确认后再重试。
	if def.Risk == RiskHigh && !dryRun {
		yes, _ := cmd.Flags().GetBool("yes")
		if !yes {
			action := commandSchemaName(cmd)
			return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
				string(errcode.ValidationError),
				"此操作具有高风险，需要确认执行。",
				"请先向用户确认，再在用户明确同意后附加 --yes 重试。不要自动追加 --yes。",
				output.ExitConfirmation,
				output.ErrorEnvelopeOpts{
					Type: "confirmation_required",
					Risk: &output.RiskDetail{
						Level:  "destructive",
						Action: action,
					},
				},
			))
		}
	}

	// ───── 2. dry-run 拦截 ─────
	if dryRun {
		if isBatch {
			return executeBatchCommandDryRun(ctx, f, def, batchPath)
		}
		// 非 batch：dry-run 走 def.DryRun 钩子
		if def.DryRun != nil {
			plan := def.DryRun(ctx)
			if plan == nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.InternalError),
					fmt.Sprintf("命令 %q 的 DryRun 钩子返回 nil", def.Use),
					"DryRun 钩子必须返回 *DryRunPlan，不允许返回 nil",
					output.ExitInternal,
				))
			}
			return printDryRunPlan(sanitizeDryRunPlan(plan), def, f)
		}
		// 没声明 DryRun 钩子，对 RiskDestructive 命令直接报错（规范 §9.1：能 dry-run 才能写）
		if def.Risk == RiskDestructive {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotImplemented),
				fmt.Sprintf("命令 %q 是 RiskDestructive 但未实现 DryRun 钩子，禁止执行", def.Use),
				"在 CommandDef 上添加 DryRun: func(ctx *RunContext) *DryRunPlan { ... }",
				output.ExitGeneral,
			))
		}
		// 兜底（RiskRead/RiskWrite 命令）：构造合成 plan 走统一 envelope 输出路径
		//
		// v10.2 P1 修复：之前只 fmt.Fprintf 到 stderr，导致：
		//   - --dry-run --quiet 静默 0 输出（违反 C1：plan 是核心信息）
		//   - --dry-run --output 不写文件（plan 没经 PrintResultForce）
		//
		// 修法：把 fallback 也构造成 *DryRunPlan，走 printDryRunPlan 统一路径——
		// stdout/--output/quiet 行为与显式 DryRun 钩子完全一致。
		// stderr banner 仍由 printDryRunPlan 内部按 quiet 抑制（保留旧 C5 语义）。
		trType := "unknown"
		if tr, err := f.Transport(); err == nil {
			trType = tr.Type()
		}
		fallbackPlan := &DryRunPlan{
			Description: fmt.Sprintf("%s %s → %s", def.Method, def.Path, def.Short),
			Plan: []DryRunStep{
				{
					Step:   1,
					Method: def.Method,
					URL:    def.Path,
					Body:   sanitizeDryRunBody(buildRequestBody(ctx, def)),
				},
			},
			Extra: map[string]any{
				"transport":   trType,
				"synthesized": true, // 标记这是 fallback 合成的，命令未实现 DryRun 钩子
				"hint":        "command did not declare DryRun hook; this is a generic preview",
			},
		}
		return printDryRunPlan(fallbackPlan, def, f)
	}

	// ───── 3. batch 真实执行 ─────
	if isBatch {
		return executeBatchCommand(ctx, f, def, batchPath)
	}

	// ───── 4. 非 batch 非 dry-run：Validate → Execute ─────
	if def.Validate != nil {
		if err := def.Validate(ctx); err != nil {
			return err
		}
	}

	if def.RunFunc != nil {
		return def.RunFunc(ctx)
	}

	// Execute 钩子（规范 §3）：当命令不走声明式 Method+Path 时由 Execute 处理执行
	// 与 RunFunc 的区别：RunFunc 是旧路径（一个大函数自己负责所有事），
	// Execute 是新规范推荐写法，配合 Validate/DryRun 三钩子代替 RunFunc。
	if def.Execute != nil {
		return def.Execute(ctx)
	}

	return executeTransportCommand(ctx, f, def)
}

// printDryRunPlan 把 DryRunPlan 按 envelope 协议输出（规范 §9.2）：
//   - stderr：人类可读的 "=== Dry Run ===" 分隔
//   - stdout：envelope JSON {ok:true, data:{dry_run:true, description, plan:[...]}}
func printDryRunPlan(plan *DryRunPlan, def CommandDef, f *Factory) error {
	// quiet 抑制 stderr header；stdout plan 仍输出（决策 C1：plan 是核心信息不抑制）
	if !f.Quiet {
		fmt.Fprintf(os.Stderr, "=== Dry Run: %s ===\n", def.Use)
	}

	data := map[string]any{
		"dry_run":     true,
		"description": plan.Description,
		"plan":        plan.Plan,
	}
	if len(plan.Extra) > 0 {
		data["extra"] = plan.Extra
	}
	// dry-run plan 必须输出——绕过 quiet（决策 C1）
	output.PrintResultForce(output.SuccessEnvelope(data), f.Format)
	return nil
}

func validateArgsMapping(cmd *cobra.Command, args []string, def CommandDef) error {
	requiredArgs := requiredArgsFromUse(def.Use)
	for i, argName := range def.ArgsMapping {
		normalizedArgName := kebabToSnake(argName)
		if i < len(args) && args[i] != "" {
			continue
		}
		if !requiredArgs[normalizedArgName] {
			continue
		}
		if cmd.Flags().Changed(kebabName(argName)) {
			continue
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("缺少必填位置参数 <%s>", strings.ReplaceAll(argName, "_", "-")),
			fmt.Sprintf("用法: %s", cmd.UseLine()),
			output.ExitValidation,
		))
	}
	return nil
}

func requiredArgsFromUse(use string) map[string]bool {
	required := make(map[string]bool)
	for _, token := range strings.Fields(use) {
		if len(token) < 3 || token[0] != '<' || token[len(token)-1] != '>' {
			continue
		}
		name := strings.Trim(token, "<>")
		if name != "" {
			required[kebabToSnake(name)] = true
		}
	}
	return required
}

func kebabName(name string) string {
	return strings.ReplaceAll(name, "_", "-")
}

func executeTransportCommand(ctx *RunContext, f *Factory, def CommandDef) error {
	tr, err := f.Transport()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			err.Error(),
			"tabtin daemon start",
			output.ExitServiceUnavail,
		))
	}

	if tr.Type() == "django" && !def.AllowsDjango() {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			fmt.Sprintf("'%s' 需要 TabTin 桌面端或 Daemon 运行（local-only）。当前为 API 直连模式。", def.Use),
			"tabtin daemon start",
			output.ExitServiceUnavail,
		))
	}

	body := buildRequestBody(ctx, def)

	if def.FileField != "" {
		if filePath, ok := ctx.FlagValues["file"].(string); ok && filePath != "" {
			data, readErr := os.ReadFile(filePath)
			if readErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), fmt.Sprintf("无法读取文件 %s: %v", filePath, readErr), "", output.ExitGeneral))
			}
			if def.FileBase64 {
				body[def.FileField] = base64Encode(data)
			} else {
				body[def.FileField] = string(data)
			}
		}
	}

	if def.StdinField != "" {
		if _, exists := body[def.StdinField]; !exists {
			if fi, err := os.Stdin.Stat(); err == nil && (fi.Mode()&os.ModeCharDevice) == 0 {
				data, readErr := io.ReadAll(os.Stdin)
				if readErr == nil && len(data) > 0 {
					content := strings.TrimSpace(string(data))
					var parsed any
					if json.Unmarshal([]byte(content), &parsed) == nil {
						body[def.StdinField] = parsed
					} else {
						body[def.StdinField] = content
					}
				}
			}
		}
	}

	if def.IncludeAgentID {
		if ctx.AgentID == "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"当前无 Agent 上下文",
				"请先在 TabTin 中选择 Agent，或设置 TABTIN_AGENT_ID / --agent-id",
				output.ExitValidation,
			))
		}
		body["agent_id"] = ctx.AgentID
	}

	opts := &transport.RequestOptions{}
	if def.Timeout > 0 {
		opts.Timeout = def.Timeout
	} else if f.GlobalTimeout > 0 {
		opts.Timeout = f.GlobalTimeout
	}

	method := def.Method
	path := def.Path
	if len(def.ArgsMapping) > 0 {
		for i, argName := range def.ArgsMapping {
			placeholder := "{" + argName + "}"
			if strings.Contains(path, placeholder) {
				if i >= len(ctx.Args) || ctx.Args[i] == "" {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.ValidationError),
						fmt.Sprintf("缺少必填参数 <%s>", strings.ReplaceAll(argName, "_", "-")),
						fmt.Sprintf("用法: tabtin %s", def.Use),
						output.ExitValidation,
					))
				}
				path = strings.ReplaceAll(path, placeholder, url.PathEscape(ctx.Args[i]))
				delete(body, argName)
			}
		}
	}

	// Django 直连：改写伪路由为 canonical /api/*。
	if tr.Type() == "django" {
		if def.AdaptRequest != nil {
			remoteMethod, remotePath, remoteBody, adaptErr := def.AdaptRequest(ctx, method, path, body)
			if adaptErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					adaptErr.Error(),
					"",
					output.ExitValidation,
				))
			}
			method, path, body = remoteMethod, remotePath, remoteBody
		} else if def.RemotePath != "" {
			path = def.RemotePath
			if def.RemoteMethod != "" {
				method = def.RemoteMethod
			}
			if len(def.ArgsMapping) > 0 {
				for i, argName := range def.ArgsMapping {
					placeholder := "{" + argName + "}"
					if !strings.Contains(path, placeholder) {
						continue
					}
					if i >= len(ctx.Args) || ctx.Args[i] == "" {
						return output.PrintErrorAndExit(output.ErrorEnvelope(
							string(errcode.ValidationError),
							fmt.Sprintf("缺少必填参数 <%s>", strings.ReplaceAll(argName, "_", "-")),
							fmt.Sprintf("用法: tabtin %s", def.Use),
							output.ExitValidation,
						))
					}
					path = strings.ReplaceAll(path, placeholder, url.PathEscape(ctx.Args[i]))
					delete(body, argName)
				}
			}
		}
	}

	if method == "GET" && len(body) > 0 {
		qv := url.Values{}
		for k, v := range body {
			switch val := v.(type) {
			case []string:
				for _, item := range val {
					qv.Add(k, item)
				}
			case []any:
				for _, item := range val {
					qv.Add(k, fmt.Sprintf("%v", item))
				}
			default:
				qv.Set(k, fmt.Sprintf("%v", v))
			}
		}
		separator := "?"
		if strings.Contains(path, "?") {
			separator = "&"
		}
		path += separator + qv.Encode()
		body = nil
	}

	reqCtx := ctx.ReqContext
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	reqStart := time.Now()
	resp, err := requestWithRetry(reqCtx, tr, method, path, body, opts)
	reqDuration := time.Since(reqStart).Milliseconds()

	if err != nil {
		go output.RecordHistory(output.HistoryEntry{
			Timestamp: output.NowTimestamp(), Command: def.Use,
			Method: method, Path: path, DurationMs: reqDuration, Error: err.Error(),
		})
		errMsg := err.Error()
		code := errcode.Unavailable
		if isNetworkError(errMsg) {
			code = errcode.NetworkError
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(string(code), errMsg, "", output.ExitNetwork))
	}

	go output.RecordHistory(output.HistoryEntry{
		Timestamp: output.NowTimestamp(), Command: def.Use,
		Method: method, Path: path, Status: resp.Status, DurationMs: reqDuration,
	})

	if resp.Status == 202 && def.WaitTaskPath != "" {
		var respData map[string]any
		if json.Unmarshal(resp.Data, &respData) == nil {
			taskData, _ := respData["data"].(map[string]any)
			taskID, _ := taskData["task_id"].(string)
			if taskID != "" {
				fmt.Fprintf(os.Stderr, "⏳ 任务已提交: %s，等待完成...\n", taskID)
				pollTimeout := def.Timeout
				if pollTimeout <= 0 {
					pollTimeout = 5 * time.Minute
				}
				pollResult, pollErr := pollTaskUntilDone(reqCtx, tr, def.WaitTaskPath, taskID, taskPollOptions{
					Timeout:                 pollTimeout,
					WaitForPermanentStorage: def.WaitForPermanentStorage,
					StorageWaitTimeout:      def.StorageWaitTimeout,
				})
				if pollErr != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), pollErr.Error(), "", output.ExitGeneral))
				}
				resp.Data = pollResult
				resp.Status = 200
			}
		}
	}

	if resp.Status == 202 && def.WaitJobPath != "" && ctx.Bool("watch") {
		jobID := extractBrowserJobID(resp.Data)
		if jobID != "" {
			fmt.Fprintf(os.Stderr, "⏳ job 已提交: %s，开始 watch...\n", jobID)
			pollTimeout := def.Timeout
			if pollTimeout <= 0 {
				pollTimeout = 5 * time.Minute
			}
			pollResult, pollErr := pollBrowserJobUntilDone(reqCtx, tr, def.WaitJobPath, def.CancelJobPath, jobID, pollTimeout)
			if pollErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), pollErr.Error(), "", output.ExitGeneral))
			}
			resp.Data = pollResult
			resp.Status = 200
		}
	}

	if resp.Status == 207 {
		// 207 Multi-Status：部分子操作失败（如 table create --fields 建表成功但 bulk 加字段失败）。
		// 不能静默走 exit 0 成功路径——Agent 会误判全成功。统一映射为非零退出 +
		// 结构化错误输出，透传上游 partial / table_id / fields_error 等详情让 Agent 归因到具体失败子操作。
		return handlePartialSuccessResponse(resp)
	}

	if resp.Status >= 400 {
		exitCode := MapHTTPToExitCode(resp.Status)
		var respBody map[string]any
		if json.Unmarshal(resp.Data, &respBody) == nil {
			// 新 envelope ok:false → 走完整透传路径，保留 error.detail / suggestions 等排障信息。
			// 之前只抽 code/message/hint，守卫类错误的 verifiedHrefs 候选全被丢弃，
			// Agent 拿不到任何自救信息。
			if okVal, isBool := respBody["ok"].(bool); isBool && !okVal {
				if _, hasErr := respBody["error"].(map[string]any); hasErr {
					return printEnvelopeErrorAndExitWithFallback(respBody, exitCode)
				}
			}
			code, message, hint := ExtractAPIError(respBody)
			if code != "" || message != "" {
				if code == "" {
					code = HTTPStatusToErrorCode(resp.Status)
				}
				if message == "" {
					message = fmt.Sprintf("API error (HTTP %d)", resp.Status)
				}
				return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, exitCode))
			}
		}
		bodySnippet := string(resp.Data)
		if len(bodySnippet) > 500 {
			bodySnippet = bodySnippet[:500] + "…(已截断)"
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			HTTPStatusToErrorCode(resp.Status),
			fmt.Sprintf("请求失败 (status %d): %s", resp.Status, bodySnippet),
			"",
			exitCode,
		))
	}

	// 在任何 --output / 二进制 / passthrough 写盘 / 输出之前，先做 envelope ok:false 检测——
	// 防止旧 envelope（LEGACY_SHAPE）或业务级失败被当成"成功响应"写入文件、agent 误判（TabData v2 P0-B）
	if envelopeIsFalsy(resp.Data) {
		var env map[string]any
		_ = json.Unmarshal(resp.Data, &env)
		return printEnvelopeErrorAndExit(env)
	}

	// unwrap sendDjangoResult 的 {ok, data} 信封，提取内层对象
	inner := unwrapDataEnvelope(resp.Data)

	// --output 写盘协议（TabData v10.1 P1 修复）：
	//
	// 全局 --output（f.OutputPath / root PersistentFlag）已由 root.PersistentPreRunE 同时
	// 设到 output.globalOutputPath；后续 output.PrintResultWithSchema 入口会按 --format
	// 渲染后写盘——pipeline **不再**自己拦截全局 --output 写 raw bytes，避免与手写命令
	// 行为不一致（v10.1 实验显示：commands --format table --output 写表格，table list
	// 同样组合写 raw envelope JSON，前后矛盾）。
	//
	// pipeline 这里只保留两个特殊写盘分支：
	//   1. 二进制响应（PDF / Excel / 媒体）：必须直接写解码 bytes，否则用户拿到的不是文件
	//   2. 命令级 CliOnly -o（如 cmd/api.go / table export csv -o）：legacy
	//      response-output 写盘语义——写 raw envelope JSON（保留旧文档承诺）
	//
	// 这两种都走"raw 写盘 + 提示已写入"路径；全局 --output 走 output 包统一 format 渲染。
	cmdOutputPath := ""
	if cmdOut, ok := ctx.FlagValues["output"].(string); ok && cmdOut != "" {
		for _, fd := range def.Flags {
			if fd.Name == "output" && fd.CliOnly {
				cmdOutputPath = cmdOut
				break
			}
		}
	}
	// 二进制响应：raw bytes 写盘——优先级最高，无论 outputPath 来源
	isBinaryResp := false
	if isBinary, ok := inner["__binary"].(bool); ok && isBinary {
		isBinaryResp = true
	}

	// 决定 raw 写盘的目标路径：
	//   - 二进制响应优先走全局 --output（用户最清晰意图）；其次走命令级 CliOnly -o
	//   - 文本响应只在命令级 CliOnly -o 时走 raw 写盘（legacy）；全局 --output 流到下游
	//     output 包按 format 渲染
	rawOutputPath := ""
	if isBinaryResp {
		if f.OutputPath != "" {
			rawOutputPath = f.OutputPath
		} else if cmdOutputPath != "" {
			rawOutputPath = cmdOutputPath
		}
	} else if cmdOutputPath != "" {
		rawOutputPath = cmdOutputPath
	}

	if rawOutputPath != "" && def.WaitTaskPath == "" {
		writeData := resp.Data
		if isBinaryResp {
			if b64, ok := inner["base64"].(string); ok {
				decoded, decErr := base64.StdEncoding.DecodeString(b64)
				if decErr == nil {
					writeData = decoded
				} else {
					if !output.IsQuietMode() {
						fmt.Fprintf(os.Stderr, "⚠ 二进制内容解码失败: %v，将写入原始响应\n", decErr)
					}
				}
			}
		} else if rawText, ok := inner["raw"].(string); ok {
			writeData = []byte(rawText)
		}
		if err := os.WriteFile(rawOutputPath, writeData, 0644); err != nil {
			// v10.1 P1：错码统一 IO_ERROR（与手写命令 output.writeResultToFile 一致）
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				"IO_ERROR",
				fmt.Sprintf("无法写入文件 %s: %v", rawOutputPath, err),
				fmt.Sprintf("检查路径是否可写：%s（目录需存在 + 有写权限）", rawOutputPath),
				output.ExitGeneral,
			))
		}
		// v10.1 P1：quiet 时不打"已写入"——成功路径成功 stderr 提示也应安静
		if !output.IsQuietMode() {
			fmt.Fprintf(os.Stderr, "已写入 %s (%d bytes)\n", rawOutputPath, len(writeData))
		}
		return nil
	}

	if isBinary, _ := inner["__binary"].(bool); isBinary {
		// v10.6 P2 修复：binary + --jq 必须明确拒绝——
		// 之前 jq 表达式作用于 inner（含 base64 字段）语义不明，且 auto-save 又会 return
		// 让 jq 完全失效。规范上 binary 数据不应被 jq 处理（jq 只能处理 JSON 结构），
		// 显式拒绝避免用户以为 jq 生效但拿到的是 base64 字符串。
		if output.GetGlobalJQ() != "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"二进制响应不支持 --jq（jq 只能处理 JSON 结构，binary 是 base64 编码）",
				"去掉 --jq，或先 --output 写到文件后用其他工具处理（如 base64 -d | jq）",
				output.ExitValidation,
			))
		}
		ct, _ := inner["content_type"].(string)
		meta := map[string]any{
			"binary":       true,
			"content_type": ct,
			"message":      "二进制数据请使用 --output/-o 写入文件",
		}
		if size, ok := inner["size"].(float64); ok {
			meta["size_bytes"] = int(size)
		} else if b64, ok := inner["base64"].(string); ok {
			if decoded, err := base64.StdEncoding.DecodeString(b64); err == nil {
				meta["size_bytes"] = len(decoded)
			}
		}
		output.PrintResultWithSchema(output.SuccessEnvelope(meta), f.Format, ctx.OutputSchema)
		return nil
	}

	if passthrough, _ := inner["__passthrough"].(bool); passthrough {
		if rawText, ok := inner["raw"].(string); ok {
			return handlePassthrough(rawText)
		}
	}

	var data any
	_ = json.Unmarshal(resp.Data, &data)

	// v10.3 P0：jq 已升到 output 包 PrintResultWithSchema/Force 入口统一应用，
	// pipeline 这里不再单独处理——避免协议分裂（手写命令绕过 jq 的 bug 根源）。
	// jq 失败由 output.applyGlobalJQAndUnwrap 直接 PrintError + os.Exit。

	if f.Format == output.FormatJSON {
		if m, ok := data.(map[string]any); ok {
			if okVal, hasOk := m["ok"]; hasOk {
				// 新 envelope：必须看 ok 的真假——ok:false 是命令失败，应走 PrintErrorAndExit
				if okBool, isBool := okVal.(bool); isBool && !okBool {
					return printEnvelopeErrorAndExit(m)
				}
				output.PrintResultWithSchema(data, f.Format, ctx.OutputSchema)
				return nil
			}
			if _, hasSuccess := m["success"]; hasSuccess {
				innerData := output.UnwrapDjangoEnvelope(data)
				output.PrintResultWithSchema(output.SuccessEnvelope(innerData), f.Format, ctx.OutputSchema)
				return nil
			}
		}
		output.PrintResultWithSchema(output.SuccessEnvelope(data), f.Format, ctx.OutputSchema)
	} else {
		// 非 JSON 格式：data 是 envelope，先看 ok 决定是否走错误分支
		if m, ok := data.(map[string]any); ok {
			if okVal, hasOk := m["ok"]; hasOk {
				if okBool, isBool := okVal.(bool); isBool && !okBool {
					return printEnvelopeErrorAndExit(m)
				}
			}
		}
		output.PrintResultWithSchema(output.UnwrapDjangoEnvelope(data), f.Format, ctx.OutputSchema)
	}

	return nil
}

// handlePassthrough 处理 passthrough raw 响应的输出协议（v10.5 P1 重构）。
//
// 协议（与 cli-spec.md §10 对齐）：
//   - --output 写盘 → 直接写 raw 文件内容（不包 envelope）；显式请求不被 quiet 阻断
//   - --jq → 包成 {raw: "..."} 走 PrintResultForce 让 jq 作用于 .raw 字段
//   - 无 --jq/--output：
//   - --quiet → 静默（passthrough raw 是成功 stdout，与"quiet 抑成功"协议一致）
//   - 无 quiet → stdout 原样 raw
//
// 抽成独立函数让测试可直接断言行为（不需要 mock transport）。
// passthrough 写盘失败统一 IO_ERROR + ExitGeneral。
//
// 注意：本函数会 os.Exit（写盘失败路径）——和其他 PrintResult* 系列一致。
func handlePassthrough(rawText string) error {
	if path := output.GetGlobalOutputPath(); path != "" {
		if err := os.WriteFile(path, []byte(rawText), 0644); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				"IO_ERROR",
				fmt.Sprintf("--output 写盘失败：%s", err.Error()),
				fmt.Sprintf("检查路径是否可写：%s", path),
				output.ExitGeneral,
			))
		}
		return nil
	}
	if jqExpr := output.GetGlobalJQ(); jqExpr != "" {
		_ = jqExpr // 仅作可读性标记
		output.PrintResultForce(map[string]any{"raw": rawText}, output.FormatJSON)
		return nil
	}
	// 无 --jq / --output：服从 quiet（v10.5 P1 修正）
	if output.IsQuietMode() {
		return nil
	}
	fmt.Print(rawText)
	return nil
}

// envelopeIsFalsy 检测响应 body 是否是 envelope ok:false 形态（含 ok 字段且为 false）。
// 用于在 --output / passthrough / 二进制写盘之前拦截"被包成 envelope 的失败"。
// 不是 JSON、没有 ok 字段、ok:true 都返回 false（让原逻辑处理）。
func envelopeIsFalsy(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var env map[string]any
	if err := json.Unmarshal(body, &env); err != nil {
		return false
	}
	okVal, hasOk := env["ok"]
	if !hasOk {
		return false
	}
	okBool, isBool := okVal.(bool)
	return isBool && !okBool
}

// printEnvelopeErrorAndExit 从新 envelope 的 error 字段提取错误信息，按统一退出码协议退出。
// 用于 envelope ok:false 但 HTTP 状态 2xx 的场景（如 LEGACY_SHAPE / 业务级失败）。
//
// 透传上游字段：actor / error.detail / error.console_url / error.risk / meta.endpoint
// （修复 TabData v2 review P1-A：之前只抽 code/message/hint/exit_code，丢失了排障信息）
func printEnvelopeErrorAndExit(env map[string]any) error {
	return printEnvelopeErrorAndExitWithFallback(env, output.ExitGeneral)
}

// printEnvelopeErrorAndExitWithFallback 同 printEnvelopeErrorAndExit，但当 envelope 自身
// 推不出更具体的退出码时使用 fallbackExit（HTTP ≥400 路径按状态码映射，）。
func printEnvelopeErrorAndExitWithFallback(env map[string]any, fallbackExit int) error {
	errObj, _ := env["error"].(map[string]any)
	if errObj == nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			"上游返回 ok:false 但未提供 error 字段",
			"请检查上游 envelope 是否符合协议（应有 error.code/message/hint）",
			output.ExitInternal,
		))
	}
	code, _ := errObj["code"].(string)
	message, _ := errObj["message"].(string)
	hint, _ := errObj["hint"].(string)

	if code == "" {
		code = string(errcode.InternalError)
	}
	if message == "" {
		message = "上游返回错误（无 message 字段）"
	}

	// Electron/Daemon 信封用 suggestions 数组承载行动建议（协议里 Go 侧只有 hint 字段）——
	// 折叠进 hint 透传，不丢失、也不新增协议字段
	if suggestionsRaw, ok := errObj["suggestions"].([]any); ok && len(suggestionsRaw) > 0 {
		parts := make([]string, 0, len(suggestionsRaw))
		for _, s := range suggestionsRaw {
			if str, ok := s.(string); ok && str != "" {
				parts = append(parts, str)
			}
		}
		if len(parts) > 0 {
			joined := strings.Join(parts, "；")
			if hint == "" {
				hint = joined
			} else {
				hint = hint + "；" + joined
			}
		}
	}

	// 透传上游 actor / detail / console_url / risk / endpoint —— 不丢失排障信息
	opts := output.ErrorEnvelopeOpts{
		Detail: errObj["detail"],
	}
	if consoleURL, ok := errObj["console_url"].(string); ok {
		opts.ConsoleURL = consoleURL
	}
	if riskObj, ok := errObj["risk"].(map[string]any); ok {
		level, _ := riskObj["level"].(string)
		action, _ := riskObj["action"].(string)
		if level != "" || action != "" {
			opts.Risk = &output.RiskDetail{Level: level, Action: action}
		}
	}
	if actorObj, ok := env["actor"].(map[string]any); ok {
		actorType, _ := actorObj["type"].(string)
		actorID, _ := actorObj["id"].(string)
		if actorType != "" || actorID != "" {
			opts.Actor = &output.Actor{Type: actorType, ID: actorID}
		}
	}

	// 从 meta.exit_code 取退出码（envelope 协议字段）；无则按 errcode 反推；仍推不出时用 fallback
	exitCode := output.ExitGeneral
	if meta, ok := env["meta"].(map[string]any); ok {
		if ec, ok := meta["exit_code"].(float64); ok && ec > 0 {
			exitCode = int(ec)
		}
		if endpoint, ok := meta["endpoint"].(string); ok {
			opts.Endpoint = endpoint
		}
	}
	if exitCode == output.ExitGeneral {
		exitCode = errcodeToExitCode(errcode.ErrorCode(code))
	}
	if exitCode == output.ExitGeneral && fallbackExit > 0 {
		exitCode = fallbackExit
	}

	return output.PrintErrorAndExit(output.ErrorEnvelopeWith(code, message, hint, exitCode, opts))
}

// handlePartialSuccessResponse 处理 HTTP 207 Multi-Status 响应。
//
// 207 表示"部分子操作失败"——典型场景是 `table create --fields`：表已创建但 bulk 加字段失败。
// 之前的处理只打 stderr 警告，且对 ok:true body（sendDjangoResult 路径）走 exit 0 成功路径，
// Agent 误判全成功。本函数统一行为：
//   - 非零退出（ExitValidation）——Agent 看 exit code 即知失败
//   - stdout 输出错误 envelope（ok:false），在 error.detail 上补 partial_success:true 标记，
//     并透传上游 detail 里的 table_id / fields_error 等结构化详情——Agent 看 JSON 即知哪些子操作失败
//   - stderr 打一行人类可读提示（quiet 抑制）
//
// body 形态兼容：
//   - 新 envelope {ok:false, error:{...}}（crud.ts /create 用 errorResponse）→ 透传 error 字段 + 补标记
//   - legacy {success:false, error:{...}} → 同上
//   - ok:true envelope / 裸 data / 解析失败 → 构造兜底 partial 错误 + body 片段
func handlePartialSuccessResponse(resp *transport.Response) error {
	if !output.IsQuietMode() {
		fmt.Fprintf(os.Stderr, "⚠ 操作部分完成 (HTTP 207)，部分子操作失败，详见 stdout 错误输出\n")
	}

	var env map[string]any
	if json.Unmarshal(resp.Data, &env) == nil {
		isFailureEnvelope := false
		if okVal, hasOk := env["ok"]; hasOk {
			if okBool, isBool := okVal.(bool); isBool && !okBool {
				isFailureEnvelope = true
			}
		} else if successVal, hasSuccess := env["success"]; hasSuccess {
			if successBool, isBool := successVal.(bool); isBool && !successBool {
				isFailureEnvelope = true
			}
		}

		if isFailureEnvelope {
			// 在 error.detail 上补 partial_success:true，让 Agent 按统一字段名感知；
			// 其余字段（code/message/detail/actor/console_url/risk/endpoint）由 printEnvelopeErrorAndExit 透传
			if errObj, ok := env["error"].(map[string]any); ok {
				detailObj, _ := errObj["detail"].(map[string]any)
				if detailObj == nil {
					detailObj = map[string]any{}
					errObj["detail"] = detailObj
				}
				detailObj["partial_success"] = true
				detailObj["http_status"] = 207
			}
			return printEnvelopeErrorAndExit(env)
		}
	}

	// ok:true envelope（sendDjangoResult 路径）/ legacy 无 error 形态 / 裸 data / 解析失败——
	// 构造兜底 partial 错误 envelope，附 body 片段供 Agent 归因
	detail := map[string]any{
		"partial_success": true,
		"http_status":     207,
	}
	if len(resp.Data) > 0 {
		detail["response_body"] = truncateResponseBodySnippet(string(resp.Data))
	}
	return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
		string(errcode.ValidationError),
		"操作部分完成 (HTTP 207)，部分子操作失败",
		"检查 error.detail.partial_success / response_body 确认哪些子操作失败",
		output.ExitValidation,
		output.ErrorEnvelopeOpts{Detail: detail},
	))
}

// errcodeToExitCode 把 errcode 映射到 CLI 退出码（与 cli-protocol.md §6.4 对齐）
func errcodeToExitCode(code errcode.ErrorCode) int {
	switch code {
	case errcode.AuthInvalid, errcode.AuthExpired, errcode.Unauthorized:
		return output.ExitAuth
	case errcode.PermissionDenied, errcode.Forbidden:
		return output.ExitPermission
	case errcode.NotFound:
		return output.ExitNotFound
	case errcode.ValidationError:
		return output.ExitValidation
	case errcode.Timeout:
		return output.ExitTimeout
	case errcode.Unavailable:
		return output.ExitServiceUnavail
	case errcode.NetworkError:
		return output.ExitNetwork
	case errcode.InternalError, errcode.LegacyShape, errcode.LoadFailed:
		return output.ExitInternal
	default:
		return output.ExitGeneral
	}
}

func executeBatchCommand(ctx *RunContext, f *Factory, def CommandDef, batchPath string) error {
	if len(def.ArgsMapping) > 0 {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"batch 模式不支持带路径参数的命令",
			"",
			output.ExitValidation,
		))
	}

	tr, err := f.Transport()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
	}

	reqCtx := ctx.ReqContext
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	var scanner *bufio.Scanner
	if batchPath == "-" {
		scanner = bufio.NewScanner(os.Stdin)
	} else {
		file, err := os.Open(batchPath)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), fmt.Sprintf("无法读取 %s: %v", batchPath, err), "", output.ExitGeneral))
		}
		defer file.Close()
		scanner = bufio.NewScanner(file)
	}
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	lineNum := 0
	successCount := 0
	failCount := 0
	// v10.4 P1：收集每行成功响应到 results 数组——后续以 envelope 整体走全局输出层
	results := make([]any, 0)

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		var lineBody map[string]any
		if err := json.Unmarshal([]byte(line), &lineBody); err != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] JSON 解析失败: %v\n", lineNum, err)
			failCount++
			continue
		}

		// 关键顺序（Sprint 1.B：v5 P1 + v6 P1-2 + Sprint 1.B 修复）：
		//   1. merge lineBody 到 lineCtx.FlagValues（保留 CLI flag 命名 / kebab-case）
		//   2. **validateConflicts + validateRequiresOneOf(lineCtx)** 先跑——输入合法性
		//      （Sprint 1.B D1/D2：line-level 始终跑这两个）
		//   3. **Validate(lineCtx) 跑**——很多命令的 Validate 会改写 FlagValues
		//      （如 session-id → sessionId、modifiers string → slice）。
		//   4. buildRequestBody(lineCtx, def)——基于已 Validate 改写过的 lineCtx 生成
		//      snake_case body 和 fixed fields。
		lineCtx := mergeBatchLineToContext(ctx, lineBody, reqCtx)

		// batch 行级：违规仅打 [batch:n] 简要文本，不喷 envelope JSON
		// （TabData v7 P2-2：避免一行失败先喷 envelope 再喷 batch 文本，stderr 混乱）
		if issue := validateConflicts(def, lineCtx); issue != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] 冲突: %s\n", lineNum, issue.Message)
			failCount++
			continue
		}
		if issue := validateRequiresOneOf(def, lineCtx); issue != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] 缺必填: %s\n", lineNum, issue.Message)
			failCount++
			continue
		}
		if message, _, ok := jsonLikeFlagStringError(def, lineCtx); ok {
			fmt.Fprintf(os.Stderr, "[batch:%d] JSON 参数错误: %s\n", lineNum, message)
			failCount++
			continue
		}

		if def.Validate != nil {
			if err := def.Validate(lineCtx); err != nil {
				fmt.Fprintf(os.Stderr, "[batch:%d] 校验拒绝: %v\n", lineNum, err)
				failCount++
				continue
			}
		}

		body := buildRequestBody(lineCtx, def)

		opts := &transport.RequestOptions{}
		if def.Timeout > 0 {
			opts.Timeout = def.Timeout
		} else if f.GlobalTimeout > 0 {
			opts.Timeout = f.GlobalTimeout
		}

		resp, err := requestWithRetry(reqCtx, tr, def.Method, def.Path, body, opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] 请求失败: %v\n", lineNum, err)
			failCount++
			continue
		}
		if resp.Status >= 400 {
			fmt.Fprintf(os.Stderr, "[batch:%d] HTTP %d: %s\n", lineNum, resp.Status, truncateResponseBodySnippet(string(resp.Data)))
			failCount++
			continue
		}

		// v10.4 P1 修复：per-line 成功响应必须走全局输出层（之前 fmt.Println 绕过 jq/output/quiet/format）
		//
		// 协议：
		//   - 每行响应解为 envelope JSON → 收集到 results 数组
		//   - 行尾 summary 输出 envelope {ok:true, data:{total, success, failed, results:[...]}}
		//   - 走 output.PrintResultWithSchema 统一出口——
		//     jq 作用于整个 envelope（如 `--jq '.results[] | .id'` 取每行 id）；
		//     --output 写盘整份 batch 结果；
		//     --quiet 抑成功 stdout（与单行命令一致）；
		//     --format json/table/csv 都生效
		//
		// 这统一了"batch 是 N 条命令的批量执行"的协议——结果集中输出而不是流式打 stdout。
		// 流式日志类需求由 stderr 进度提示（[batch:N] 失败信息）保留。
		var lineData any
		if jsonErr := json.Unmarshal(resp.Data, &lineData); jsonErr != nil {
			// 反序列化失败时仍保留原始文本（避免吞掉非 JSON 响应）
			lineData = string(resp.Data)
		}
		results = append(results, lineData)
		successCount++
	}

	summary := map[string]any{
		"total":   lineNum,
		"success": successCount,
		"failed":  failCount,
		"results": results,
	}
	// 空行分隔 stderr（quiet 抑）
	if !output.IsQuietMode() {
		fmt.Fprintln(os.Stderr)
	}
	// v10.4 P1：走 PrintResultWithSchema 让 jq / output / quiet / format 都生效
	output.PrintResultWithSchema(output.SuccessEnvelope(summary), f.Format, nil)
	if failCount > 0 {
		return output.NewExitError(output.ExitGeneral)
	}
	return nil
}

// executeBatchCommandDryRun 是 batch + --dry-run 模式下的处理函数（TabData v5 P0 修复）。
// 对每行 lineCtx 跑 def.DryRun 钩子（或 fallback 文本），不发任何真实请求。
//
// 与 executeBatchCommand 的区别：
//   - 不调 transport.Request——绝不真实写后端
//   - 不打印业务响应——只输出每行的 DryRunPlan envelope
//   - line-level Validate 仍跑（让 dry-run 的 plan 基于合法 lineCtx）
func executeBatchCommandDryRun(ctx *RunContext, f *Factory, def CommandDef, batchPath string) error {
	if len(def.ArgsMapping) > 0 {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"batch 模式不支持带路径参数的命令",
			"",
			output.ExitValidation,
		))
	}

	// 与非 batch dry-run 路径一致：RiskDestructive 命令未实现 DryRun 钩子 → NOT_IMPLEMENTED
	// （TabData v6 P1-1 修复——之前 batch dry-run 走 fallback body 预览绕过此 gate）
	if def.Risk == RiskDestructive && def.DryRun == nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotImplemented),
			fmt.Sprintf("命令 %q 是 RiskDestructive 但未实现 DryRun 钩子，禁止执行（batch + dry-run 同样要求）", def.Use),
			"在 CommandDef 上添加 DryRun: func(ctx *RunContext) *DryRunPlan { ... }",
			output.ExitGeneral,
		))
	}

	reqCtx := ctx.ReqContext
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	var scanner *bufio.Scanner
	if batchPath == "-" {
		scanner = bufio.NewScanner(os.Stdin)
	} else {
		file, err := os.Open(batchPath)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), fmt.Sprintf("无法读取 %s: %v", batchPath, err), "", output.ExitGeneral))
		}
		defer file.Close()
		scanner = bufio.NewScanner(file)
	}
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	// quiet 抑制 stderr header（决策 C1 类比：batch dry-run header 也是 stderr 噪声）
	if !f.Quiet {
		fmt.Fprintf(os.Stderr, "=== Dry Run (batch): %s ===\n", def.Use)
	}
	lineNum := 0
	successCount := 0
	failCount := 0
	plans := []any{}

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var lineBody map[string]any
		if err := json.Unmarshal([]byte(line), &lineBody); err != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] JSON 解析失败: %v\n", lineNum, err)
			failCount++
			continue
		}

		lineCtx := mergeBatchLineToContext(ctx, lineBody, reqCtx)

		// Sprint 1.B：先跑 declarative validate（Conflicts / RequiresOneOf）
		// batch 行级仅打简要文本，不喷 envelope JSON（v7 P2-2）
		if issue := validateConflicts(def, lineCtx); issue != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] 冲突: %s\n", lineNum, issue.Message)
			failCount++
			continue
		}
		if issue := validateRequiresOneOf(def, lineCtx); issue != nil {
			fmt.Fprintf(os.Stderr, "[batch:%d] 缺必填: %s\n", lineNum, issue.Message)
			failCount++
			continue
		}
		if message, _, ok := jsonLikeFlagStringError(def, lineCtx); ok {
			fmt.Fprintf(os.Stderr, "[batch:%d] JSON 参数错误: %s\n", lineNum, message)
			failCount++
			continue
		}

		// 跑 line-level Validate——dry-run 的 plan 基于校验过的输入才有意义
		if def.Validate != nil {
			if err := def.Validate(lineCtx); err != nil {
				fmt.Fprintf(os.Stderr, "[batch:%d] 校验拒绝: %v\n", lineNum, err)
				failCount++
				continue
			}
		}

		// 优先调 def.DryRun 钩子（结构化 plan）；fallback 用 build body 文本预览
		var entry map[string]any
		if def.DryRun != nil {
			plan := def.DryRun(lineCtx)
			if plan == nil {
				fmt.Fprintf(os.Stderr, "[batch:%d] DryRun 钩子返回 nil\n", lineNum)
				failCount++
				continue
			}
			sanitized := sanitizeDryRunPlan(plan)
			entry = map[string]any{
				"line":        lineNum,
				"description": sanitized.Description,
				"plan":        sanitized.Plan,
			}
		} else {
			entry = map[string]any{
				"line":   lineNum,
				"method": def.Method,
				"url":    def.Path,
				"body":   sanitizeDryRunBody(buildRequestBody(lineCtx, def)),
			}
		}
		plans = append(plans, entry)
		successCount++
	}

	envelope := map[string]any{
		"dry_run": true,
		"batch":   true,
		"total":   lineNum,
		"success": successCount,
		"failed":  failCount,
		"plans":   plans,
	}
	// batch dry-run plans envelope 必须输出（决策 C1：dry-run plan 是核心信息，quiet 不抑制）
	output.PrintResultForce(output.SuccessEnvelope(envelope), f.Format)
	if failCount > 0 {
		return output.NewExitError(output.ExitGeneral)
	}
	return nil
}

// mergeBatchLineToContext 把 batch 的一行 JSON merge 到 RunContext.FlagValues，
// 返回一个新的 lineCtx——供 def.Validate / buildRequestBody / def.DryRun 使用。
//
// FlagValues key 保留原始命名（kebab-case 或 line JSON 里的任意 key），
// 由 buildRequestBody 在最后做 kebab→snake 转换；这样 def.Validate 收到的
// FlagValues 命名一致（命令级和行级都是 CLI flag 风格）。
func mergeBatchLineToContext(base *RunContext, lineBody map[string]any, reqCtx context.Context) *RunContext {
	merged := make(map[string]any, len(base.FlagValues)+len(lineBody))
	for k, v := range base.FlagValues {
		merged[k] = v
	}
	for k, v := range lineBody {
		merged[k] = v
	}
	// 把 batch flag 本身从 merged 移除——它只是控制 batch 模式的"元 flag"，
	// 不应进入 body / Validate 视野（且会让 isEmptyRequestValue 误判）。
	delete(merged, "batch")
	return &RunContext{
		Factory:        base.Factory,
		Args:           nil,
		FlagValues:     merged,
		AgentID:        base.AgentID,
		SpaceID:        base.SpaceID,
		OrganizationID: base.OrganizationID,
		ReqContext:     reqCtx,
		Stdin:          base.Stdin,
	}
}

func requestWithRetry(ctx context.Context, tr transport.Transport, method, path string, body map[string]any, opts *transport.RequestOptions) (*transport.Response, error) {
	resp, err := tr.Request(ctx, method, path, body, opts)
	if err == nil && resp.Status == 429 {
		retryAfter := 3
		for attempt := 0; attempt < 2; attempt++ {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(retryAfter) * time.Second):
			}
			retryAfter *= 2
			resp, err = tr.Request(ctx, method, path, body, opts)
			if err != nil || resp.Status != 429 {
				break
			}
		}
	}
	return resp, err
}

func buildRequestBody(ctx *RunContext, def CommandDef) map[string]any {
	body := make(map[string]any)

	cliOnly := make(map[string]bool)
	allowEmpty := make(map[string]bool)
	jsonString := make(map[string]bool)
	for _, f := range def.Flags {
		if f.CliOnly {
			cliOnly[f.Name] = true
		}
		if f.AllowEmpty {
			allowEmpty[f.Name] = true
		}
		if isJSONStringFlag(f) {
			jsonString[f.Name] = true
		}
	}

	for k, v := range ctx.FlagValues {
		if cliOnly[k] {
			continue
		}
		// AllowEmpty=true 的 flag 直接放行（含空串）——它把空串当 sentinel 用，
		// 见 FlagDef.AllowEmpty 注释。前置于 isEmptyRequestValue 检查，
		// 以保留三态语义（如 share set --password "" 清空密码）。
		if allowEmpty[k] {
			body[kebabToSnake(k)] = v
			continue
		}
		if isEmptyRequestValue(v) {
			continue
		}
		// 跳过 string 空值——空字符串通常表示"未设置"（用户没传过）。
		//
		// **不跳过 int/int64/float64/bool 零值**：FlagValues 由 extractFlagValues 填充，
		// 它在 cmd.Flags().Changed(name)==true 时才塞——所以 FlagValues 里出现零值
		// 一定是用户显式传过（`--limit 0` / `--offset 0`），必须保留传给后端。
		//
		// 这是 P1-B 修复（TabData v2 review 指出的 TestBuildRequestBody pre-existing 失败）：
		// 之前的实现错误地跳过数字零值，与 extractFlagValues 的 Changed 语义矛盾。
		//
		// AllowEmpty=true 的 flag 已在上面前置分支处理；这里只看普通 flag。
		if s, ok := v.(string); ok && s == "" {
			continue
		}
		key := kebabToSnake(k)
		if str, ok := v.(string); ok {
			if parsed, ok := parseJSONLikeString(str, jsonString[k]); ok {
				body[key] = parsed
				continue
			}
		}
		body[key] = v
	}

	if len(def.ArgsMapping) > 0 {
		for i, argName := range def.ArgsMapping {
			if i < len(ctx.Args) && ctx.Args[i] != "" {
				if _, exists := body[argName]; !exists {
					body[argName] = ctx.Args[i]
				}
			}
		}
	}

	if ctx.SpaceID != "" {
		body["space_id"] = ctx.SpaceID
	}
	if ctx.OrganizationID != "" {
		body["organization_id"] = ctx.OrganizationID
	}

	for k, v := range def.FixedFields {
		body[k] = v
	}

	for from, to := range def.QueryParamRenames {
		if v, ok := body[from]; ok {
			delete(body, from)
			body[to] = v
		}
	}

	return body
}

func validateJSONLikeFlagStrings(def CommandDef, ctx *RunContext) error {
	if message, hint, ok := jsonLikeFlagStringError(def, ctx); ok {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			message,
			hint,
			output.ExitValidation,
		))
	}
	return nil
}

func jsonLikeFlagStringError(def CommandDef, ctx *RunContext) (string, string, bool) {
	for _, flag := range def.Flags {
		if !isJSONStringFlag(flag) {
			continue
		}
		raw, ok := ctx.FlagValues[flag.Name].(string)
		if !ok || !looksLikeJSONContainerForJSONFlag(raw) {
			continue
		}
		if _, ok := parseJSONLikeString(raw, true); ok {
			continue
		}
		return fmt.Sprintf("--%s 必须是合法 JSON", flag.Name),
			fmt.Sprintf("使用原始 JSON，如 --%s %s；长内容可写入文件后用 --%s @%s.json", flag.Name, jsonFlagExample(flag.Name), flag.Name, flag.Name),
			true
	}
	return "", "", false
}

func jsonFlagExample(flagName string) string {
	switch flagName {
	case "fields":
		return "'[{\"name\":\"书名\",\"field_type\":\"text\"}]'"
	case "records":
		return "'[{\"record_id\":\"rec_xxx\",\"data\":{\"AAA\":\"aaa\"}}]'"
	default:
		return "'{\"AAA\":\"aaa\"}'"
	}
}

func isJSONStringFlag(flag FlagDef) bool {
	return flag.Type == FlagString && strings.Contains(strings.ToLower(flag.Desc), "json")
}

func looksLikeJSONContainer(raw string) bool {
	trimmed := strings.TrimSpace(stripUTF8BOM(raw))
	return len(trimmed) > 1 && (trimmed[0] == '[' || trimmed[0] == '{')
}

func looksLikeJSONContainerForJSONFlag(raw string) bool {
	trimmed := stripShellQuoteIfJSONContainer(stripUTF8BOM(raw))
	return len(trimmed) > 1 && (trimmed[0] == '[' || trimmed[0] == '{')
}

func parseJSONLikeString(raw string, allowEscapedQuotes bool) (any, bool) {
	trimmed := strings.TrimSpace(stripUTF8BOM(raw))
	if allowEscapedQuotes {
		trimmed = stripShellQuoteIfJSONContainer(trimmed)
	}
	if !looksLikeJSONContainer(trimmed) {
		return nil, false
	}
	var parsed any
	if json.Unmarshal([]byte(trimmed), &parsed) == nil {
		return parsed, true
	}
	// Agent 常直接产出 JSONL 喂 --records @file——
	// 整体解析失败时按 JSONL 兜底聚合为数组，省掉一步手工转换。
	if jsonlItems, ok := parseJSONLines(trimmed); ok {
		return jsonlItems, true
	}
	if !allowEscapedQuotes || !strings.Contains(trimmed, `\"`) {
		return nil, false
	}
	// Agent 在 shell 单引号里经常仍输出 JSON 风格转义：
	//   --fields '[{\"name\":\"书名\"}]'
	// 这种值不是合法 JSON，但去掉多余的 quote 转义后就是用户想传的数组。
	unescapedQuotes := strings.ReplaceAll(trimmed, `\"`, `"`)
	if json.Unmarshal([]byte(unescapedQuotes), &parsed) == nil {
		return parsed, true
	}
	return nil, false
}

// parseJSONLines 把 JSONL（每行一个独立 JSON 值）聚合为数组。
// 收紧条件：≥2 个非空行且**每行都是完整合法 JSON** 才成立——
// 多行 pretty-printed 的单个 JSON（单行不自足）不会被误聚合成错误类型。
func parseJSONLines(raw string) ([]any, bool) {
	lines := strings.Split(raw, "\n")
	items := make([]any, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var item any
		if json.Unmarshal([]byte(line), &item) != nil {
			return nil, false
		}
		items = append(items, item)
	}
	if len(items) < 2 {
		return nil, false
	}
	return items, true
}

func stripShellQuoteIfJSONContainer(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) < 2 {
		return trimmed
	}
	first := trimmed[0]
	last := trimmed[len(trimmed)-1]
	if (first == '\'' && last == '\'') || (first == '"' && last == '"') {
		inner := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		if len(inner) > 1 && (inner[0] == '[' || inner[0] == '{') {
			return inner
		}
	}
	return trimmed
}

func isEmptyRequestValue(v any) bool {
	switch val := v.(type) {
	case nil:
		return true
	case string:
		return val == ""
	case []string:
		return len(val) == 0
	case []any:
		return len(val) == 0
	default:
		return false
	}
}

func unwrapDataEnvelope(raw []byte) map[string]any {
	var outer map[string]any
	if json.Unmarshal(raw, &outer) != nil {
		return nil
	}
	if inner, ok := outer["data"].(map[string]any); ok {
		return inner
	}
	return outer
}

// extractFlagValues 从 cobra command 取所有 Changed 过的 flag 值并塞 RunContext.FlagValues。
//
// 必须为 FlagDef 闭集中所有 9 种 Type 都提供读取分支——否则新 flag 类型注册到
// cobra 后用户能传值，但 pipeline 拿不到（TabData v3 P0 指出的"加了一处忘了其他"bug）。
//
// 同时对 FlagString / FlagFile / FlagEnum 在 Enum 非空时做**强校验**——非法值直接返回
// 错误（pipeline 会包装成 ExitValidation 退出），不是只 stderr warning。
func extractFlagValues(cmd *cobra.Command, flags []FlagDef) (map[string]any, error) {
	vals := make(map[string]any)
	for _, f := range flags {
		if !cmd.Flags().Changed(f.Name) {
			continue
		}
		switch f.Type {
		case FlagString:
			v, _ := cmd.Flags().GetString(f.Name)
			if len(f.Enum) > 0 && !containsStr(f.Enum, v) {
				return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					fmt.Sprintf("--%s 的值 %q 不在允许范围内", f.Name, v),
					fmt.Sprintf("允许值：%s", strings.Join(f.Enum, ", ")),
					output.ExitValidation,
				))
			}
			vals[f.Name] = v
		case FlagFile:
			// FlagFile 语义（Sprint 1.B D7）：只做 SafeInputPath 校验 + 规范化路径，
			// **不读文件内容**——内容由命令 Execute 钩子自行读。需要"自动读内容"用 FlagString + @file。
			v, _ := cmd.Flags().GetString(f.Name)
			if v != "" {
				cleaned, err := SafeInputPath(v)
				if err != nil {
					return nil, err
				}
				vals[f.Name] = cleaned
			} else {
				vals[f.Name] = v
			}
		case FlagEnum:
			v, _ := cmd.Flags().GetString(f.Name)
			if len(f.Enum) > 0 && !containsStr(f.Enum, v) {
				return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					fmt.Sprintf("--%s 的值 %q 不在 Enum 允许范围内", f.Name, v),
					fmt.Sprintf("允许值：%s", strings.Join(f.Enum, ", ")),
					output.ExitValidation,
				))
			}
			vals[f.Name] = v
		case FlagInt:
			v, _ := cmd.Flags().GetInt(f.Name)
			vals[f.Name] = v
		case FlagBool:
			v, _ := cmd.Flags().GetBool(f.Name)
			vals[f.Name] = v
		case FlagStringArray:
			v, _ := cmd.Flags().GetStringArray(f.Name)
			vals[f.Name] = v
		case FlagStringSlice:
			v, _ := cmd.Flags().GetStringSlice(f.Name)
			vals[f.Name] = v
		case FlagFloat:
			v, _ := cmd.Flags().GetFloat64(f.Name)
			vals[f.Name] = v
		case FlagDuration:
			v, _ := cmd.Flags().GetDuration(f.Name)
			vals[f.Name] = v
		default:
			return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				fmt.Sprintf("flag %q 使用未知 Type %q（闭集见 cli-spec.md §5.2）", f.Name, string(f.Type)),
				"",
				output.ExitInternal,
			))
		}
	}
	return vals, nil
}

func containsStr(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
}

func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func kebabToSnake(s string) string {
	return strings.ReplaceAll(s, "-", "_")
}

func MapHTTPToExitCode(status int) int {
	switch status {
	case 400, 422:
		return output.ExitValidation
	case 401:
		return output.ExitAuth
	case 403:
		return output.ExitPermission
	case 404:
		return output.ExitNotFound
	case 409:
		return output.ExitGeneral
	case 429:
		return output.ExitTimeout
	case 500:
		return output.ExitInternal
	case 502, 503:
		return output.ExitServiceUnavail
	case 504:
		return output.ExitTimeout
	default:
		return output.ExitGeneral
	}
}

func HTTPStatusToErrorCode(status int) string {
	switch status {
	case 400, 422:
		return string(errcode.ValidationError)
	case 401:
		return string(errcode.Unauthorized)
	case 403:
		return string(errcode.PermissionDenied)
	case 404:
		return string(errcode.NotFound)
	case 409:
		return string(errcode.Conflict)
	case 429:
		return string(errcode.RateLimitExceeded)
	case 500:
		return string(errcode.InternalError)
	case 502:
		return string(errcode.Unavailable)
	case 503:
		return string(errcode.Unavailable)
	case 504:
		return string(errcode.Timeout)
	default:
		return string(errcode.InternalError)
	}
}

func isNetworkError(msg string) bool {
	patterns := []string{
		"dial", "connection refused", "ECONNREFUSED",
		"no such host", "network is unreachable",
		"connect:",
	}
	lower := strings.ToLower(msg)
	for _, p := range patterns {
		if strings.Contains(lower, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

// extractAPIError tries to extract structured error info from a Django API response.
// Handles these patterns:
//   - {"error":{"code":"...","message":"...","hint":"..."}}
//   - {"ok":false,"error":{"code":"...","message":"..."}}
//   - {"success":false,"error":{"code":"...","message":"..."}}
//   - {"message":"..."} or {"detail":"..."}
func ExtractAPIError(body map[string]any) (code, message, hint string) {
	if errObj, ok := body["error"].(map[string]any); ok {
		code, _ = errObj["code"].(string)
		message, _ = errObj["message"].(string)
		hint, _ = errObj["hint"].(string)
		if message != "" {
			return
		}
	}

	if errStr, ok := body["error"].(string); ok && errStr != "" {
		message = errStr
		return
	}

	if msg, ok := body["message"].(string); ok && msg != "" {
		message = msg
		return
	}
	if detail, ok := body["detail"].(string); ok && detail != "" {
		message = detail
		return
	}
	if detailAny, exists := body["detail"]; exists && detailAny != nil {
		if b, err := json.Marshal(detailAny); err == nil {
			message = string(b)
			return
		}
	}
	return
}

type taskPollOptions struct {
	Timeout                 time.Duration
	WaitForPermanentStorage bool
	StorageWaitTimeout      time.Duration
}

func pollTaskUntilDone(ctx context.Context, tr transport.Transport, basePath string, taskID string, options taskPollOptions) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	deadline := time.Now().Add(timeout)
	var storageDeadline time.Time
	var lastGeneratedResult map[string]any
	interval := 2 * time.Second
	pollPath := basePath
	if strings.Contains(pollPath, "{task_id}") {
		pollPath = strings.ReplaceAll(pollPath, "{task_id}", url.PathEscape(taskID))
	} else {
		separator := "?"
		if strings.Contains(pollPath, "?") {
			separator = "&"
		}
		pollPath += separator + "id=" + url.QueryEscape(taskID)
	}

	for {
		now := time.Now()
		if !storageDeadline.IsZero() && now.After(storageDeadline) && lastGeneratedResult != nil {
			fmt.Fprintln(os.Stderr, "⚠️ 图片已生成，但永久存储等待超时；当前仅返回临时预览")
			return annotateMediaDelivery(lastGeneratedResult, "temporary_preview")
		}
		if storageDeadline.IsZero() && now.After(deadline) {
			return nil, fmt.Errorf("任务超时（%v），task_id=%s", timeout, taskID)
		}

		resp, err := tr.Request(ctx, "GET", pollPath, nil, nil)
		if err != nil {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(interval):
			}
			continue
		}

		var result map[string]any
		if json.Unmarshal(resp.Data, &result) != nil {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(interval):
			}
			continue
		}

		if resp.Status >= 400 {
			code, message, _ := ExtractAPIError(result)
			if message == "" {
				message = fmt.Sprintf("任务状态请求失败 (HTTP %d)", resp.Status)
			}
			if code != "" {
				return nil, fmt.Errorf("%s: %s", code, message)
			}
			return nil, fmt.Errorf("%s", message)
		}

		data, _ := result["data"].(map[string]any)
		status, _ := data["status"].(string)

		switch status {
		case "succeeded", "completed", "complete":
			if options.WaitForPermanentStorage {
				done, deliveryStatus := permanentStorageDecision(data)
				if done {
					switch deliveryStatus {
					case "permanent":
						fmt.Fprintln(os.Stderr, "✅ 图片已生成并永久保存")
					case "partial":
						fmt.Fprintln(os.Stderr, "⚠️ 图片已部分永久保存；其余图片仅为临时预览")
					case "temporary_preview":
						fmt.Fprintln(os.Stderr, "⚠️ 图片已生成，但永久存储失败；当前仅返回临时预览")
					}
					return annotateMediaDelivery(result, deliveryStatus)
				}

				lastGeneratedResult = result
				if storageDeadline.IsZero() {
					storageTimeout := options.StorageWaitTimeout
					if storageTimeout <= 0 {
						storageTimeout = 90 * time.Second
					}
					storageDeadline = time.Now().Add(storageTimeout)
					fmt.Fprintln(os.Stderr, "⏳ 图片已生成，等待永久存储...")
				}
				break
			}
			if result, ok := data["result"].(map[string]any); ok {
				if op, ok := result["outputPath"].(string); ok {
					fmt.Fprintf(os.Stderr, "✅ 任务完成: %s\n", op)
				} else {
					fmt.Fprintf(os.Stderr, "✅ 任务完成\n")
				}
			} else {
				fmt.Fprintf(os.Stderr, "✅ 任务完成\n")
			}
			return resp.Data, nil
		case "failed":
			errMsg, _ := data["error"].(string)
			if errMsg == "" {
				errMsg, _ = data["error_message"].(string)
			}
			if errMsg == "" {
				errMsg = "任务执行失败"
			}
			return nil, fmt.Errorf("%s", errMsg)
		case "cancelled", "canceled":
			return nil, fmt.Errorf("任务已取消: %s", taskID)
		default:
			if phase, ok := data["progress_phase"].(string); ok {
				pct, _ := data["progress_percent"].(float64)
				detail, _ := data["progress_detail"].(string)
				if detail != "" {
					fmt.Fprintf(os.Stderr, "  [%s] %.0f%% %s\r", phase, pct, detail)
				}
			}
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

func permanentStorageDecision(data map[string]any) (bool, string) {
	storageStatus, _ := data["storage_status"].(string)
	switch storageStatus {
	case "succeeded":
		// 新服务端的 succeeded 必须同时带稳定产物身份。若状态先于文件投影可见，
		// 继续等待而不是把空产物误报成已永久保存。
		if hasNonEmptySlice(data["stored_files"]) || hasNonEmptySlice(data["stored_urls"]) {
			return true, "permanent"
		}
		return false, ""
	case "partial":
		return true, "partial"
	case "failed":
		return true, "temporary_preview"
	case "not_started", "storing":
		return false, ""
	}

	if hasNonEmptySlice(data["stored_files"]) || hasNonEmptySlice(data["stored_urls"]) {
		return true, "permanent"
	}
	return false, ""
}

func hasNonEmptySlice(value any) bool {
	switch items := value.(type) {
	case []any:
		return len(items) > 0
	case []string:
		return len(items) > 0
	default:
		return false
	}
}

func annotateMediaDelivery(result map[string]any, deliveryStatus string) ([]byte, error) {
	data, _ := result["data"].(map[string]any)
	if data == nil {
		data = make(map[string]any)
		result["data"] = data
	}
	data["delivery_status"] = deliveryStatus
	switch deliveryStatus {
	case "permanent":
		data["delivery_message"] = "图片已永久保存"
	case "partial":
		data["delivery_message"] = "部分图片已永久保存；其余图片当前仅为临时预览"
	case "temporary_preview":
		data["delivery_message"] = "图片已生成，但永久存储尚未完成；当前仅为临时预览"
	}
	return json.Marshal(result)
}

func extractBrowserJobID(raw []byte) string {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	if id, _ := body["jobId"].(string); id != "" {
		return id
	}
	if id, _ := body["job_id"].(string); id != "" {
		return id
	}
	data, _ := body["data"].(map[string]any)
	if data == nil {
		return ""
	}
	if id, _ := data["jobId"].(string); id != "" {
		return id
	}
	if id, _ := data["job_id"].(string); id != "" {
		return id
	}
	return ""
}

func pollBrowserJobUntilDone(ctx context.Context, tr transport.Transport, statusPath string, cancelPath string, jobID string, timeout time.Duration) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(timeout)
	interval := 1 * time.Second
	body := map[string]any{"jobId": jobID, "job_id": jobID}

	cancelJob := func(reason string) {
		if cancelPath == "" {
			return
		}
		cancelCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = tr.Request(cancelCtx, "POST", cancelPath, map[string]any{
			"jobId":  jobID,
			"job_id": jobID,
			"reason": reason,
		}, nil)
	}

	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("job watch 超时（%v），jobId=%s", timeout, jobID)
		}

		resp, err := tr.Request(ctx, "POST", statusPath, body, nil)
		if err != nil {
			select {
			case <-ctx.Done():
				cancelJob("client_cancelled")
				return nil, ctx.Err()
			case <-time.After(interval):
			}
			continue
		}

		var result map[string]any
		if json.Unmarshal(resp.Data, &result) != nil {
			select {
			case <-ctx.Done():
				cancelJob("client_cancelled")
				return nil, ctx.Err()
			case <-time.After(interval):
			}
			continue
		}

		if resp.Status >= 400 {
			code, message, _ := ExtractAPIError(result)
			if message == "" {
				message = fmt.Sprintf("job status 请求失败 (HTTP %d)", resp.Status)
			}
			if code != "" {
				return nil, fmt.Errorf("%s: %s", code, message)
			}
			return nil, fmt.Errorf("%s", message)
		}

		data, _ := result["data"].(map[string]any)
		status, _ := data["status"].(string)
		progress, _ := data["progress"].(map[string]any)

		switch status {
		case "completed":
			fmt.Fprintf(os.Stderr, "✅ job 完成: %s\n", jobID)
			return resp.Data, nil
		case "failed":
			msg := "job 执行失败"
			if errObj, _ := data["error"].(map[string]any); errObj != nil {
				if m, _ := errObj["message"].(string); m != "" {
					msg = m
				}
			}
			return nil, fmt.Errorf("%s", msg)
		case "cancelled":
			return nil, fmt.Errorf("job 已取消: %s", jobID)
		default:
			if progress != nil {
				phase, _ := progress["phase"].(string)
				pct, _ := progress["percent"].(float64)
				detail, _ := progress["detail"].(string)
				if detail != "" {
					fmt.Fprintf(os.Stderr, "  [%s] %.0f%% %s\r", phase, pct, detail)
				} else if phase != "" {
					fmt.Fprintf(os.Stderr, "  [%s] %.0f%%\r", phase, pct)
				}
			}
		}

		select {
		case <-ctx.Done():
			cancelJob("client_cancelled")
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}
