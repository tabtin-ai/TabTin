package cmdutil

import (
	"context"
	"io"
	"strings"
	"time"

	"github.com/TabTin/tabtin-cli/internal/output"
)

type RouteMode string

const (
	RouteCliServer RouteMode = "cli_server"
	RouteDirect    RouteMode = "direct"
)

// RuntimeRequirement 描述命令在无 Desktop/Daemon 时是否可走 Django 直连。
//
// 与 RouteMode 正交：Route 仍决定请求默认打到 CliServer 伪路由还是 Direct；
// Runtime 决定 DjangoTransport 下是否放行（ 独立远程 CLI）。
type RuntimeRequirement string

const (
	// RuntimeCloud：可在 Django 直连下执行（Path 通常已是 /api/...，或声明了 RemotePath/AdaptRequest）。
	RuntimeCloud RuntimeRequirement = "cloud"
	// RuntimeLocal：必须 Desktop/Daemon（browser/desktop/phone/terminal 等本机能力）。
	RuntimeLocal RuntimeRequirement = "local"
	// RuntimeHybrid：CliServer 与 Django 皆可；Django 下优先 RemotePath/AdaptRequest。
	RuntimeHybrid RuntimeRequirement = "hybrid"
)

type FlagType string

const (
	// 既有四种类型——值与 `tabtin commands --format json` 历史输出保持兼容。
	// 注意 FlagStringArray 字符串值是 "string_array"（snake），与规范 §5.2 文档里
	// 写的 "stringArray" (camel) 不一致——这是已落地的现状，改字符串值会破坏前端
	// cli-output-render 等下游消费者。下次规范修订时拉齐。
	FlagString      FlagType = "string"
	FlagInt         FlagType = "int"
	FlagBool        FlagType = "bool"
	FlagStringArray FlagType = "string_array" // 多次出现累积：--tag a --tag b

	// 规范 v1 §5.2 新增的类型闭集扩展。
	//
	// pipeline 已实现（2026-05-19 v3 + Sprint 1.B 起）：
	//   - 5 种类型都在 RegisterCommand 注册到 cobra
	//   - 5 种类型都在 extractFlagValues 读取并塞 RunContext.FlagValues
	//   - FlagEnum 在 extractFlagValues 强校验：非法值直接 ExitValidation
	//   - FlagFile 在 extractFlagValues 走 SafeInputPath 校验（防 .., null byte, 不存在, 目录）
	//     + 保留 cleaned absolute path（不读内容；要读用 ReadInputFile）
	//   - FlagString 默认开启 @file / stdin / @@转义输入抽象
	//   - **但**名字以 -id/-ids/-token/-key/-secret/-password/-uuid 等 opaque identifier
	//     后缀结尾的 FlagString 自动 opt-out（启发式，TabData v8 引入）——
	//     这些 flag 值就是字符串本身（UUID / token 等），不该被 @ 解析
	//   - 显式 NoFileInput=true 也 opt-out（与启发式叠加）
	//   - FlagString 的 --help 自动追加 "(supports @file, - for stdin)" 提示
	//     （启发式 opt-out / NoFileInput=true 时不加）
	FlagFloat       FlagType = "float"
	FlagDuration    FlagType = "duration"     // time.Duration（如 --timeout 30s）
	FlagStringSlice FlagType = "string_slice" // 逗号分隔：--tags a,b,c
	FlagFile        FlagType = "file"         // 文件路径（自动 SafeInputPath；保留路径不读内容）
	FlagEnum        FlagType = "enum"         // 必须配 Enum 字段，框架已强制校验
)

type FlagDef struct {
	Name     string
	Short    string
	Type     FlagType
	Default  any
	Desc     string
	Required bool
	Hidden   bool
	Enum     []string
	CliOnly  bool // 不发送到后端，仅 CLI 本地使用（如 --output、--file）

	// NoFileInput 关闭 FlagString 默认开启的 `@file` / stdin 输入抽象（规范 §5.3）。
	//
	// 默认行为（NoFileInput=false）：FlagString 默认支持下面三种输入，但 opaque identifier
	// 启发式例外（详见下面"两个 opt-out 路径"）：
	//   --content "literal"     # 字面量
	//   --content @path/to/file # 读文件
	//   --content -             # 读 stdin（单进程内仅第一个 `-` 生效）
	//
	// pipeline 关闭 input 抽象的两个路径（都生效）：
	//   1. **opaque identifier 启发式**（Sprint 1.B v8 起）：flag 名以
	//      -id/-ids/-token/-key/-secret/-password/-uuid 等结尾的 FlagString
	//      框架自动 opt-out——不需要手写 NoFileInput=true。这覆盖了 ID/token/key 类 flag。
	//
	//   2. **显式 NoFileInput=true**：仍然 opt-out——用于不在启发式后缀闭集但确实是
	//      opaque 的 flag（如 `--api-version`、`--format` 这类字符串配置 flag）。
	//
	// 两者效果：跳过 @file / stdin / @@ 抽象解析 + --help 不追加 "(supports @file...)" 提示。
	NoFileInput bool

	// AllowEmpty 让 string 空值不被 buildRequestBody 当作"未设置"过滤。
	//
	// 默认（false）：FlagString 用空串当 sentinel 是反模式——`buildRequestBody`
	// （pipeline.go）会在空串时跳过该字段，与"用户没传"行为等价。这保护绝大多数
	// 业务字段（如 --title ""）不会被误传给后端清空。
	//
	// opt-in（true）：用于"空串本身是合法的三态语义信号"的少数 flag。例如：
	//   - `tabtin doc share set --password ""` 想清空密码（三态：未传=保留旧值；
	//     空串=清空；非空=设新值）。CreateShareRequest.password 在后端就是这套语义。
	//
	// 触发条件：FlagDef 标 AllowEmpty=true **且** 用户显式传过（cobra Changed=true，
	// 即 FlagValues 里有该 key）。两者缺一就走默认过滤路径。
	//
	// 不影响：FlagStringArray/FlagStringSlice 的空数组（仍按"未设置"处理）；
	// 数字零值（pipeline 已用 Changed 区分，不受本字段影响）。
	AllowEmpty bool
}

type RiskLevel string

// Risk 三档（规范 §8.1）。
//
// ⚠️ 兼容性注意：规范文档里的字符串值是 "read" / "write" / "destructive"，但本实现
// 保留旧字符串值（""/"write"/"high-risk-write"）以兼容存量 105+ 命令、
// `tabtin commands --format json` 输出消费者（如 packages/agent-runtime/src/capability/core/__tests__/restricted-shell-allowlist.test.ts
// 硬编码比较 `s.risk === 'high-risk-write'`）。新写命令统一用语义化名字 RiskRead/RiskDestructive。
// 待 agent-runtime 等下游迁移完，再把字符串值整体切到规范值。
const (
	RiskRead        RiskLevel = ""                // 只读，无副作用（与旧 RiskNone 同值）
	RiskWrite       RiskLevel = "write"           // 写但可逆（archive/trash/update/创建）
	RiskDestructive RiskLevel = "high-risk-write" // 不可逆（hard delete/广播效应）（与旧 RiskHigh 同值）
)

// 兼容别名——所有现有命令源码里的 RiskNone / RiskHigh 引用继续编译；
// 新代码请直接用 RiskRead / RiskDestructive。
const (
	// Deprecated: 改用 RiskRead。语义化名称对齐规范 §8.1。
	RiskNone = RiskRead
	// Deprecated: 改用 RiskDestructive。语义化名称对齐规范 §8.1。
	RiskHigh = RiskDestructive
)

// String 返回 RiskLevel 的底层字符串值。给测试断言、日志、envelope 序列化用。
func (r RiskLevel) String() string {
	return string(r)
}

// FieldSchema 是 internal/output.FieldSchema 的类型别名。
//
// **下沉到 internal/output**（Sprint 1.C）：因为 cmdutil 已 import output（output 是底层），
// FieldSchema 必须放 output 才能让 PrintResultWithSchema 直接消费它。
// cmdutil 保留此 alias 让所有现有引用（`cmdutil.FieldSchema{...}`）继续工作。
//
// 详细字段语义、JSON tag、Type 闭集见 internal/output/envelope.go::FieldSchema。
type FieldSchema = output.FieldSchema

// AdaptRequestFunc 在 Django 直连下把 CliServer 伪路由请求改写为 canonical Django API。
// method/path/body 是 buildRequestBody 之后、即将发往 transport 的值；返回值用于真正的 HTTP 调用。
type AdaptRequestFunc func(ctx *RunContext, method, path string, body map[string]any) (remoteMethod, remotePath string, remoteBody map[string]any, err error)

type CommandDef struct {
	Use       string
	Short     string
	Long      string
	Example   string
	Aliases   []string
	Route     RouteMode
	Method    string
	Path      string
	Flags     []FlagDef
	HasFormat bool
	Risk      RiskLevel
	Timeout   time.Duration

	// Runtime 标记云端/本地执行要求。空值由 EffectiveRuntime 启发式推断：
	// Path 以 /api/ 开头或 RouteDirect → cloud；声明 RemotePath/AdaptRequest → hybrid；其余 local。
	Runtime RuntimeRequirement

	// RemoteMethod / RemotePath：Django 直连时覆盖 Method/Path（保持 CliServer 伪路由不变）。
	RemoteMethod string
	RemotePath   string

	// AdaptRequest：Django 直连时的完整请求改写（表/云盘伪路由 → canonical API）。
	// 优先于 RemoteMethod/RemotePath。
	AdaptRequest AdaptRequestFunc

	// Hidden 把命令从 `--help` 与 `tabtin commands`（Agent 命令发现面）中隐去，
	// 但命令仍可被显式调用（cobra Hidden 语义）。用于收敛入口而保留底层能力，
	// 例如 `slide create`（云项目进阶命令）对 Agent 隐藏、只暴露 `slide render`。
	Hidden bool

	RequiresAuth  bool
	RequiresAgent bool
	// IncludeAgentID 把 RunContext 中解析出的 Agent ID 注入请求参数 agent_id。
	// 仅用于本地路由需要显式 Agent 作用域的命令，避免全局扩大 wire contract。
	IncludeAgentID bool

	ArgsMapping []string

	StdinField string

	// FileField: when --file flag is present, read file content and inject into body[FileField].
	// If FileBase64 is true, the content is base64-encoded (for binary files like Excel).
	FileField  string
	FileBase64 bool

	Idempotent bool
	Tips       []string

	// FixedFields 注入静态字段到请求 body，不暴露为 flag。
	// 用于多个子命令复用同一后端路由（典型：export csv/json/excel/pdf 共用 POST /table/export，
	// 各自通过 FixedFields={"format": "csv"} 区分）。
	FixedFields map[string]any

	// QueryParamRenames 把 buildRequestBody 产出的 query key 重命名为后端 API 名（仅 GET）。
	// key = flag 经 kebabToSnake 后的 body 字段；value = 实际 query string 参数名。
	// 例：doc search 的 --query → body["query"]，API 要 q → {"query": "q"}。
	QueryParamRenames map[string]string

	// WaitTaskPath: when 202 response contains task_id, poll this path until task completes.
	// Use "{task_id}" in the path for REST detail routes (e.g. "/media/tasks/{task_id}");
	// otherwise task_id is appended as a query parameter for legacy task endpoints.
	WaitTaskPath string
	// WaitForPermanentStorage 让媒体命令在生成成功后继续等待 OSS 永久交付终态。
	WaitForPermanentStorage bool
	// StorageWaitTimeout 从首次观察到生成成功开始单独计时；超时返回临时预览而非失败。
	StorageWaitTimeout time.Duration

	// WaitJobPath: when a browser command is called with --watch and receives
	// 202 {data:{jobId}}, poll this route until the job reaches a terminal
	// state. CancelJobPath is used for best-effort Ctrl-C cancellation.
	WaitJobPath   string
	CancelJobPath string

	// OutputSchema 描述命令 stdout JSON 输出的字段集（L31）。
	//
	// 仅高频列表型 / 单对象型命令需声明（doc list / memo list / browser tab list 等）。
	// 留空时 runtime 端 cli-output-render 走 inferColumns 启发式兜底。
	// 通过 `tabtin commands --format json` 透传给 ShellCap.cliCommandSchemas。
	OutputSchema []FieldSchema

	// ===== 规范 v1 新增字段（additive，pipeline 后续接入）=====

	// Layer 是规范 §2 的三层架构标识：L1（传输层）/L2（业务命令层）/L3（Agent 编排层）。
	//
	// MustRegisterCommand 注册期会断言此字段非空（本 Sprint 后续提交接入）；
	// 当前仅作字段声明，存量命令可空着，迁移时再补。
	Layer string

	// DryRun 是规范 §9 的 dry-run 钩子。Risk != RiskRead 的命令必须实现，否则传
	// --dry-run 由框架报 NOT_IMPLEMENTED 错误。
	//
	// 钩子返回完整的将执行计划（多步编排逐步列出），框架自动序列化到 envelope.data。
	// 不允许在钩子里发任何写请求；可以做只读校验、解析 URL、读文件。
	//
	// **pipeline 已真实调用**（2026-05-19 v2 起）：传 `--dry-run` 时框架优先调用本钩子，
	// 输出 envelope JSON 含 `data.plan` 数组（cli-protocol.md §1.6）。
	// RiskDestructive 命令未声明 DryRun 时，`--dry-run` 直接报 NOT_IMPLEMENTED 错误。
	DryRun func(ctx *RunContext) *DryRunPlan

	// Execute 是规范 §3.1 推荐的主逻辑钩子。与 (Method + Path) 互斥：
	//   - 声明式命令（仅 Method + Path）：pipeline 走 executeTransportCommand
	//   - 自定义命令（声明 Execute）：pipeline 调用 Execute(ctx) 拿结果
	//
	// 比 RunFunc 更收敛——Execute 内禁止自己写 envelope / 自己处理 --jq /
	// 自己拼 stderr。这些统一由 pipeline 在 Execute 返回后做。
	//
	// **pipeline 已真实调用**（2026-05-19 v2 起）：当 Method+Path 为空且 def.Execute != nil 时
	// pipeline 调用 def.Execute(ctx)。RunFunc 仍是过渡期保留路径，新代码请用 Execute。
	Execute func(ctx *RunContext) error

	// Conflicts 声明 flag 之间的互斥关系（map: flag → 与之互斥的 flag 列表，建议对称声明）：
	//   Conflicts: map[string][]string{
	//       "markdown":      {"markdown-file"},
	//       "markdown-file": {"markdown"},
	//   }
	//
	// 实现状态（Sprint 1.B 起）：pipeline 在 extractFlagValues 后立即跑命令级 validateConflicts；
	// batch 每行 merge 后也跑 line-level。判空用 isEmptyRequestValue（空值视为未提供）。
	// 违规即 ExitValidation；不允许命令自己在 Validate 里手写 if/else 互斥。
	Conflicts map[string][]string

	// RequiresOneOf 声明"至少传一组里的一个 flag"约束（每组是 []string）：
	//   RequiresOneOf: [][]string{{"markdown", "markdown-file"}}
	//
	// 实现状态（Sprint 1.B 起）：pipeline 仅非 batch 跑命令级 validateRequiresOneOf；
	// batch 命令级跳过（字段从行 JSON 来），改在 line-level 跑。判空用 isEmptyRequestValue。
	RequiresOneOf [][]string

	// Showcase 标记该命令是否进入 TabDoc「能力总览」等用户向展示面。
	// 与 Risk 配合：破坏性命令（RiskDestructive）默认不展示，除非显式 Showcase=true。
	Showcase bool

	// ShowcaseGroup 是 Showcase 命令在用户向 UI 中的分组 id（如 browse / blocks）。
	// 仅 Showcase=true 时需要；分组中文 label 由 doc_showcase.go 的闭集映射提供。
	ShowcaseGroup string

	// AIHelp 是面向 Agent/skill 的能力说明（何时用、关键 flag、踩坑）。
	// 与 Short/Long（给人看的 help）分离；tabdoc-operator SKILL 命令表从此字段生成。
	AIHelp string

	// RiskDeclared 标记 Risk 字段是"显式声明"而非"零值未填"。
	//
	// 起因：RiskRead 字符串值是 ""（与零值同），MustRegisterCommand 无法区分
	// "命令作者显式写了 Risk: RiskRead" vs "命令作者忘填 Risk"——TabData Agent
	// v1 review 指出的 P1-1。
	//
	// 解法：MustRegisterCommand 调用方写 `RiskDeclared: true` 显式声明已确认 Risk。
	// 未声明时 MustRegisterCommand 直接 panic 提示。
	//
	// 兼容性：本字段是 bool 零值 false，存量走 RegisterCommand 路径的命令完全不受影响。
	RiskDeclared bool

	Validate func(ctx *RunContext) error
	RunFunc  func(ctx *RunContext) error
}

// EffectiveRuntime 返回命令的运行时要求（含启发式默认）。
func (d CommandDef) EffectiveRuntime() RuntimeRequirement {
	if d.Runtime != "" {
		return d.Runtime
	}
	if d.AdaptRequest != nil || d.RemotePath != "" {
		return RuntimeHybrid
	}
	if strings.HasPrefix(d.Path, "/api/") || d.Route == RouteDirect {
		return RuntimeCloud
	}
	return RuntimeLocal
}

// AllowsDjango 表示 DjangoTransport 下是否允许执行。
func (d CommandDef) AllowsDjango() bool {
	switch d.EffectiveRuntime() {
	case RuntimeCloud, RuntimeHybrid:
		return true
	default:
		return false
	}
}

type CommandSchema struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Long        string   `json:"long,omitempty"`
	Example     string   `json:"example,omitempty"`
	Aliases     []string `json:"aliases,omitempty"`
	ArgsMapping []string `json:"args_mapping,omitempty"`
	Method      string   `json:"method,omitempty"`
	Path        string   `json:"path,omitempty"`
	Risk        string   `json:"risk,omitempty"`
	// RiskDeclared 透传 CommandDef.RiskDeclared：让 codegen 护栏区分
	// "显式声明 RiskRead" vs "忘填 Risk 被默认为零值 safe"——后者对设备操控命令
	// 是安全漏洞（Plan 受限 shell 会放行）。omitempty：false 不输出。
	RiskDeclared bool `json:"risk_declared,omitempty"`
	Idempotent   bool `json:"idempotent,omitempty"`
	HasFormat    bool `json:"has_format,omitempty"`
	RequiresAuth bool `json:"requires_auth,omitempty"`
	// Runtime：cloud | local | hybrid，供 Agent 过滤本机能力命令。
	Runtime string       `json:"runtime,omitempty"`
	Flags   []FlagSchema `json:"flags,omitempty"`

	// ── PlatformSurface 扩展字段（W4 E2）──────────────────────────
	// omitempty 保持向后兼容：原生 CLI 命令不填这些字段，JSON 输出不变；
	// surface 来源的命令则携带这三个字段，让 Agent 区分并自动发现新能力。

	// Source 标记命令来源：空字符串 = 原生 cobra 命令，"surface" = PlatformSurface
	Source string `json:"source,omitempty"`
	// ErrorCodes 是 surface 声明的业务错误码闭集，Agent 可据此做错误分支处理
	ErrorCodes []string `json:"error_codes,omitempty"`
	// Kind 标记 surface 种类："local"（本地能力）/ "proxied"（代理到 Django）
	Kind string `json:"kind,omitempty"`

	// OutputSchema 是 stdout JSON 输出的字段元数据列表（L31）。
	// 仅列表型 / 单对象型命令声明；UI 端 cli_output_table 据此优先用声明的列名
	// + 类型，避免 inferColumns 启发式漂移。
	OutputSchema []FieldSchema `json:"output_schema,omitempty"`

	// Showcase / ShowcaseGroup：TabDoc 能力总览等用户向展示面消费（见 cmd/doc_showcase.go）。
	Showcase      bool   `json:"showcase,omitempty"`
	ShowcaseGroup string `json:"showcase_group,omitempty"`

	// AIHelp：Agent/skill 消费（见 cmd/doc_ai_help.go）。
	AIHelp string `json:"ai_help,omitempty"`

	// ── pure group 顶层命令──────────────────────────
	// IsGroup=true 表示这是 cobra group 命令（无 Run/RunE，仅路由子命令，
	// 裸跑显示 help）。之前 `tabtin commands` 只输出注册过 CommandDef 的
	// leaf，`doc`/`mcp`/`browser` 这类入口命令不在输出里，relevant-cli
	// 召回池缺入口条目。group 条目仅供发现/召回；受限模式 risk 判定必须
	// 跳过它们（见 agent-runtime buildRiskMapFromSchemas），否则未注册的
	// 写子命令会借 group 前缀被误放行。
	IsGroup bool `json:"is_group,omitempty"`
	// Subcommands 是 group 直接子命令名列表（发现提示用，非完整 schema）。
	Subcommands []string `json:"subcommands,omitempty"`

	// Hidden：命令仍可显式调用，但默认不进 `tabtin commands` 发现面
	// 。受限模式 risk map 经 `--include-hidden` 仍需读到
	// Risk 字段，因此 schema 输出打标而非整条丢弃。
	Hidden bool `json:"hidden,omitempty"`
}

type FlagSchema struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Default  any      `json:"default,omitempty"`
	Desc     string   `json:"description"`
	Enum     []string `json:"enum,omitempty"`
	CliOnly  bool     `json:"cli_only,omitempty"`
}

type RunContext struct {
	Factory        *Factory
	Args           []string
	FlagValues     map[string]any
	AgentID        string
	SpaceID        string
	OrganizationID string
	// ReqContext 来自 Cobra Command.Context()，用于取消与传输层 Request。
	ReqContext context.Context
	// Stdin 保留 Cobra 的输入流，便于命令安全读取不应出现在参数或历史记录中的敏感值。
	Stdin io.Reader
	// OutputSchema 是当前命令 def.OutputSchema 的引用——pipeline 创 RunContext 时填，
	// 让所有 PrintResult 调用点能取到 schema 走 PrintResultWithSchema 渲染（Sprint 1.C）。
	// nil 表示命令未声明 schema，等价于走 PrintResult 启发式。
	OutputSchema []FieldSchema
}

// Str 取 string 类型 flag 值。flag 未传或类型不匹配返回空串。
// 规范化的便利方法——避免每个命令都写 `v, _ := ctx.FlagValues["x"].(string)`。
func (c *RunContext) Str(name string) string {
	v, _ := c.FlagValues[name].(string)
	return v
}

// Int 取 int 类型 flag 值。flag 未传或类型不匹配返回 0。
func (c *RunContext) Int(name string) int {
	v, _ := c.FlagValues[name].(int)
	return v
}

// Bool 取 bool 类型 flag 值。flag 未传或类型不匹配返回 false。
func (c *RunContext) Bool(name string) bool {
	v, _ := c.FlagValues[name].(bool)
	return v
}

// StrSlice 取 string slice 类型 flag 值。flag 未传或类型不匹配返回 nil。
func (c *RunContext) StrSlice(name string) []string {
	v, _ := c.FlagValues[name].([]string)
	return v
}

// Changed 判断某 flag 是否被用户显式传过（用 FlagValues 是否存在 key 判断——
// extractFlagValues 只塞 Changed=true 的 flag）。
//
// 关键场景：parent-id 空字符串是合法值（置为顶级），不能用 v != "" 过滤；
// 必须用 ok 判断"是否被设置"。
func (c *RunContext) Changed(name string) bool {
	_, ok := c.FlagValues[name]
	return ok
}
