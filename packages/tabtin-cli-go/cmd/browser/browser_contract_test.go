// browser_contract_test.go — BR-7「Browser Runtime Contract」漂移检测（纯静态不变量）。
//
// 契约不是另造一份重复 schema，而是两份已有事实源的并集 + 一组完整性约束：
//   - CLI 侧：Go CommandDef 声明（入参 / Method / Path / Risk / FixedFields）——见 browser.go。
//   - 双端侧：browser-core 能力矩阵（每 action 的 electron/daemon 支持级别 + 降级原因）。
//
// 机器可读投影 = packages/browser-core/src/generated/browser-cli-contract.json（由本文件
// 的导出测试生成），跨语言锚点（TS 矩阵单测消费它）就靠它。
//
// 本文件落「最小 4 条漂移检测」（BR-7）：
//
//	① 每 CLI Path 必有 route（聚焦 Daemon：扁平 route 表可静态枚举；Daemon 是黑洞/漂移高发端）。
//	② 多动作端点必有互异 FixedFields（共享同一路由的命令必须靠 FixedFields 区分 action）。
//	③ route 源码里 `tabtin browser <cmd>` 建议必须真实存在（防 note 指向不存在命令）。
//	④ CLI 命令全集 ↔ 契约 JSON 一致（Go 侧锚点；TS 矩阵单测另从同一 JSON 锚 daemon 矩阵）。
//
// 「先只校验、不动 route 实现」：这些测试只读、不改任何 route。
package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// contractJSONRelPath 是契约机器可读投影的落盘位置（相对仓库根）。
// 放在 browser-core 下，方便 TS 矩阵单测就近 import；将来矩阵拆 browser-contract 包时一起迁。
const contractJSONRelPath = "packages/browser-core/src/generated/browser-cli-contract.json"

// selfDescribeActionIDs 是 browser 自描述命令（context / capabilities，BR-5/6）。
// 它们是真实 CLI 命令、但不属于「操作 action 矩阵」（矩阵描述的是它们之外的操作）。
var selfDescribeActionIDs = map[string]bool{
	"context":      true,
	"capabilities": true,
}

// diagnosticActionIDs 是本地诊断/运维入口，不发 browser action，也不属于能力矩阵。
var diagnosticActionIDs = map[string]bool{
	"doctor": true,
}

// ─────────────────────────────────────────────────────────────────────────────
// 仓库文件读取助手（测试从 cmd/browser 包目录跑，统一按仓库根定位 route 源码 / JSON）
// ─────────────────────────────────────────────────────────────────────────────

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("找不到仓库根（向上未见 pnpm-workspace.yaml）")
		}
		dir = parent
	}
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("读取 %s: %v", rel, err)
	}
	return string(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
// check ② 多动作端点必有互异 FixedFields
// ─────────────────────────────────────────────────────────────────────────────

// fixedFieldsFingerprint 把 FixedFields 序列化成稳定指纹（key 升序），用于判重。
func fixedFieldsFingerprint(ff map[string]any) string {
	if len(ff) == 0 {
		return ""
	}
	keys := make([]string, 0, len(ff))
	for k := range ff {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		raw, _ := json.Marshal(ff[k])
		parts = append(parts, k+"="+string(raw))
	}
	return strings.Join(parts, "&")
}

// TestBrowserMultiActionEndpointsHaveDistinctFixedFields 断言：≥2 个 browser CLI 命令
// 共享同一 (Method, Path) 时，每条都必须声明非空且互异的 FixedFields。
//
// 防 BR-1 类静默退化：cookies get/set/clear 共用 POST /browser/cookies，若不发 action
// 区分，后端无法分辨 → Electron 400 / Daemon 静默退化成 get。FixedFields 就是这道区分。
func TestBrowserMultiActionEndpointsHaveDistinctFixedFields(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	type cmdInfo struct {
		rel string
		def *cmdutil.CommandDef
	}
	byEndpoint := map[string][]cmdInfo{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		def := cmdutil.GetCommandDef(leaf)
		if def == nil || def.Path == "" {
			continue
		}
		key := def.Method + " " + def.Path
		byEndpoint[key] = append(byEndpoint[key], cmdInfo{browserRelativePath(leaf), def})
	}

	for key, cmds := range byEndpoint {
		if len(cmds) < 2 {
			continue
		}
		seen := map[string]string{}
		for _, ci := range cmds {
			fp := fixedFieldsFingerprint(ci.def.FixedFields)
			if fp == "" {
				t.Errorf("多动作端点 %q 的命令 %q 缺 FixedFields —— 共享同一路由的命令必须用 FixedFields 钦定 action，否则后端无法区分（BR-1 类静默退化）", key, ci.rel)
				continue
			}
			if other, ok := seen[fp]; ok {
				t.Errorf("多动作端点 %q 的命令 %q 与 %q 的 FixedFields 相同（%s）—— 必须互异才能区分 action", key, ci.rel, other, fp)
			}
			seen[fp] = ci.rel
		}
	}
}

func TestBrowserLongTaskWatchForcesAsyncJob(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	for _, rel := range []string{"stream download", "resource smart-download", "replay run"} {
		var def *cmdutil.CommandDef
		for _, leaf := range walkLeafBrowserCommands(cmd) {
			if browserRelativePath(leaf) == rel {
				def = cmdutil.GetCommandDef(leaf)
				break
			}
		}
		if def == nil {
			t.Fatalf("找不到 browser 命令 %q", rel)
		}
		if def.WaitJobPath != "/browser/job/status" || def.CancelJobPath != "/browser/job/cancel" {
			t.Fatalf("%s 未注册 job watch 路径: wait=%q cancel=%q", rel, def.WaitJobPath, def.CancelJobPath)
		}
		hasWatchCliOnly := false
		for _, fl := range def.Flags {
			if fl.Name == "watch" && fl.CliOnly {
				hasWatchCliOnly = true
				break
			}
		}
		if !hasWatchCliOnly {
			t.Fatalf("%s 缺 CLI-only --watch flag", rel)
		}
		ctx := &cmdutil.RunContext{FlagValues: map[string]any{"watch": true}}
		if err := def.Validate(ctx); err != nil {
			t.Fatalf("%s Validate(--watch): %v", rel, err)
		}
		if got, _ := ctx.FlagValues["async"].(bool); !got {
			t.Fatalf("%s --watch 应转换成 async=true，got %v", rel, ctx.FlagValues["async"])
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// check ① 每 CLI Path 必有 route（聚焦 Daemon）
// ─────────────────────────────────────────────────────────────────────────────

// daemonKnownNoRoutePaths：Daemon 端确无 handler（请求 → 404 UNKNOWN_ROUTE）的 CLI Path。
// 能力矩阵已对这些 action 如实标 daemon=unsupported（BR-3）。
//
// 维护契约：新增 browser CLI 命令若 Daemon 不打算实现，必须**两处同步**——
//  1. 在此登记（让本检测放行、并显式记录这是「有意不支持」而非「忘了实现」）；
//  2. 把能力矩阵该 action 的 daemon 列标 unsupported（带原因）。
//
// 反之若给某条补了 Daemon handler，记得从这里删掉、把矩阵上调。
//
// `browser home` 依赖 Electron Renderer 的本地浏览器偏好和工作台标签状态；Daemon
// 没有对应产品 surface，故有意不支持而非遗漏 route。
var daemonKnownNoRoutePaths = map[string]bool{
	"/browser/home": true,
}

var daemonRouteLiteralRe = regexp.MustCompile(`route === '(/[^']*)'`)

// BR-8 P3c：route 编排逐步收进 Orchestrator 后，daemon 不再逐个 `route === '/x'`，而是用
// 分发表（如 `RESOURCE_STREAM_ROUTES: Record<string,string> = { '/resources': 'resource.list', ... }`）
// 把 route 字面量映射到 action id 再统一调 handleBrowserAction。扫描器须同时认这种表分发键，
// 否则会把「实际可达」的 route 误报成 404 黑洞。键形态特定（'/path': 'dotted.action'），不会误匹配。
var daemonRouteTableRe = regexp.MustCompile(`'(/[^']+)':\s*'[a-z]+\.[a-z.-]+'`)

// scanDaemonServedRoutes 扫 Daemon 扁平 route 分发表（单文件、统一 `route === '/x'`），
// 返回其服务的子路径集合（已剥 /browser 前缀的形态，如 "/cookies"）。
//
// 为什么只扫 Daemon、不扫 Electron：Electron route 按域拆 11 个子模块、且嵌套剥前缀
// （主分发器剥 /browser、session 子分发器再剥 /browser/session），同一路径在源码里以不同
// 深度的字面量出现，静态枚举不可靠。而 Electron 端能力矩阵恒为 full（矩阵单测已锁），
// 其覆盖完整性由「矩阵声明 + 未来 BR-12 双端 live 探针」兜底。Daemon 才是黑洞 / 漂移高发端。
func scanDaemonServedRoutes(t *testing.T) map[string]bool {
	t.Helper()
	content := readRepoFile(t, "apps/tabtin-daemon/src/cli/routes/browser.ts")
	served := map[string]bool{}
	for _, m := range daemonRouteLiteralRe.FindAllStringSubmatch(content, -1) {
		served[m[1]] = true
	}
	// 同时认 Orchestrator 分发表（BR-8 P3c）里的 route 键。
	for _, m := range daemonRouteTableRe.FindAllStringSubmatch(content, -1) {
		served[m[1]] = true
	}
	if len(served) == 0 {
		t.Fatal("Daemon browser.ts 未扫到任何 `route === '/x'` 或分发表键 —— 分发形态可能变了，请更新 scanDaemonServedRoutes")
	}
	return served
}

// TestBrowserCliPathsHaveDaemonRoute 断言每条 browser CLI 命令的 Path 要么有 Daemon route
// handler、要么在 daemonKnownNoRoutePaths 名单里（且矩阵已标 unsupported）。
//
// 防 BR-3 类静默 404 黑洞：CLI 暴露了命令、Daemon 却无对应 route → Agent 把脚本从 Electron
// 搬到 Daemon 时悄悄 404。新命令漏 Daemon 实现、又没登记成「有意不支持」时本检测变红。
func TestBrowserCliPathsHaveDaemonRoute(t *testing.T) {
	served := scanDaemonServedRoutes(t)
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	for _, leaf := range walkLeafBrowserCommands(cmd) {
		def := cmdutil.GetCommandDef(leaf)
		if def == nil || def.Path == "" {
			continue
		}
		rel := browserRelativePath(leaf)
		sub := strings.TrimPrefix(def.Path, "/browser")
		if served[sub] {
			continue
		}
		if daemonKnownNoRoutePaths[def.Path] {
			continue
		}
		t.Errorf("CLI 命令 %q（path %s）在 Daemon 路由表里既无 handler、也不在 daemonKnownNoRoutePaths —— "+
			"这是静默 404 黑洞（BR-3 类）。要么给 Daemon 补 handler，要么登记到 daemonKnownNoRoutePaths "+
			"并把能力矩阵该 action 的 daemon 列标 unsupported（带原因）", rel, def.Path)
	}
}

// TestDaemonKnownNoRoutePathsAreRealCommands 反向防腐：no-route 名单不能留死引用——
// 名单里的 Path 必须仍对应一条真实 CLI 命令（命令改名 / 删除后及时清理名单）。
func TestDaemonKnownNoRoutePathsAreRealCommands(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	realPaths := map[string]bool{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		if def := cmdutil.GetCommandDef(leaf); def != nil && def.Path != "" {
			realPaths[def.Path] = true
		}
	}
	for p := range daemonKnownNoRoutePaths {
		if !realPaths[p] {
			t.Errorf("daemonKnownNoRoutePaths 含 %q，但已无对应 CLI 命令 —— 请清理名单", p)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// check ③ route 源码里 `tabtin browser <cmd>` 建议必须真实存在
// ─────────────────────────────────────────────────────────────────────────────

var suggestionRe = regexp.MustCompile(`tabtin browser ([a-z][a-zA-Z0-9-]*(?:\s+[a-z][a-zA-Z0-9-]*)*)`)

// validBrowserCommandPaths 收集 browser 命令树里所有可达路径（含中间分组与叶子），
// 形如 "route" / "tab" / "tab list" / "resource smart-download"。
func validBrowserCommandPaths(t *testing.T) map[string]bool {
	t.Helper()
	f := cmdutil.NewFactory()
	root := NewCmdBrowser(f)
	valid := map[string]bool{}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if rel := browserRelativePath(c); rel != "" {
			valid[rel] = true
		}
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(root)
	return valid
}

// resolveSuggestion 取建议词串的最长合法命令前缀；找到即认为该建议指向真实命令。
// （自然语言里 `tabtin browser open the page` 会贪婪匹配出 "open the page"，
//
//	这里逐步缩短到 "open" 命中即放行——只在「首词就不是命令」时才判失败。）
func resolveSuggestion(suggested string, valid map[string]bool) bool {
	words := strings.Fields(suggested)
	for i := len(words); i >= 1; i-- {
		if valid[strings.Join(words[:i], " ")] {
			return true
		}
	}
	return false
}

// collectRouteSourceFiles 列出两端 browser route 源码（相对仓库根）：
// Electron 主分发器 + browser 子模块 + 共享 session 分发器，外加 Daemon 单文件。
func collectRouteSourceFiles(t *testing.T) []string {
	t.Helper()
	root := repoRoot(t)
	files := []string{
		"apps/tabtin-daemon/src/cli/routes/browser.ts",
		"apps/tabtin-electron/src/main/cli/routes/browser.ts",
		"apps/tabtin-electron/src/main/cli/routes/session.ts",
	}
	matches, err := filepath.Glob(filepath.Join(root, "apps/tabtin-electron/src/main/cli/routes/browser/*.ts"))
	if err != nil {
		t.Fatalf("glob electron browser routes: %v", err)
	}
	for _, m := range matches {
		rel, err := filepath.Rel(root, m)
		if err != nil {
			t.Fatalf("rel: %v", err)
		}
		files = append(files, filepath.ToSlash(rel))
	}
	return files
}

// TestBrowserRouteSuggestionsReferenceRealCommands 扫两端 route 源码里所有
// `tabtin browser <cmd>` 形式的用户向建议，断言每个被建议的命令都真实存在。
//
// 防 BR-2 类活样本：Daemon /route-list 的 note 曾叫用户「使用 tabtin browser route 设置拦截」，
// 而那时 `tabtin browser route` 命令根本不存在——建议指向不存在的命令，比报错更误导 Agent。
func TestBrowserRouteSuggestionsReferenceRealCommands(t *testing.T) {
	valid := validBrowserCommandPaths(t)
	for _, file := range collectRouteSourceFiles(t) {
		content := readRepoFile(t, file)
		for _, m := range suggestionRe.FindAllStringSubmatch(content, -1) {
			suggested := strings.TrimSpace(m[1])
			if resolveSuggestion(suggested, valid) {
				continue
			}
			t.Errorf("%s 的文案建议了 `tabtin browser %s`，但该命令不存在 —— "+
				"route 里给出的命令必须真实可达（BR-2 类：note 指向不存在命令会误导 Agent）", file, suggested)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// check ④ CLI 命令全集 ↔ 契约 JSON（跨语言锚点的 Go 侧）
// ─────────────────────────────────────────────────────────────────────────────

type browserContractCommand struct {
	ID           string         `json:"id"`
	SelfDescribe bool           `json:"selfDescribe,omitempty"`
	Diagnostic   bool           `json:"diagnostic,omitempty"`
	Method       string         `json:"method,omitempty"`
	Path         string         `json:"path,omitempty"`
	Risk         string         `json:"risk,omitempty"`
	PolicyRisk   string         `json:"policyRisk,omitempty"`
	Idempotent   bool           `json:"idempotent,omitempty"`
	FixedFields  map[string]any `json:"fixedFields,omitempty"`
}

type browserContract struct {
	SchemaVersion int                      `json:"schemaVersion"`
	GeneratedFrom string                   `json:"generatedFrom"`
	Note          string                   `json:"note"`
	Commands      []browserContractCommand `json:"commands"`
}

// riskToContractString 把内部 RiskLevel（""/"write"/"high-risk-write"）映射成契约语义词。
func riskToContractString(r cmdutil.RiskLevel) string {
	switch r {
	case cmdutil.RiskWrite:
		return "write"
	case cmdutil.RiskDestructive:
		return "high-risk-write"
	default:
		return "read"
	}
}

var browserHighRiskPolicyActions = map[string]bool{
	"act":               true,
	"batch":             true,
	"clear-session":     true,
	"cookies.clear":     true,
	"eval":              true,
	"replay.run":        true,
	"route":             true,
	"session.close-all": true,
	"session.load":      true,
	"unroute":           true,
}

// browserAutoAllowPolicyActions 记录「会改变浏览器当前视图，但不需要打断用户」的导航动作。
// 它们保留 CLI RiskWrite：命令本身仍是状态变化；仅 Electron browser policy 读取
// policyRisk=read 后自动放行，避免 Agent 在正常浏览链路中反复请求确认。
var browserAutoAllowPolicyActions = map[string]bool{
	"open":       true,
	"nav":        true,
	"tab.switch": true,
}

// buildBrowserContract 把 browser CLI 叶子命令投影成契约（按 id 升序，稳定输出）。
func buildBrowserContract(t *testing.T) browserContract {
	t.Helper()
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	cmds := make([]browserContractCommand, 0, 64)
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			continue
		}
		id := strings.ReplaceAll(browserRelativePath(leaf), " ", ".")
		cmds = append(cmds, browserContractCommand{
			ID:           id,
			SelfDescribe: selfDescribeActionIDs[id],
			Diagnostic:   diagnosticActionIDs[id],
			Method:       def.Method,
			Path:         def.Path,
			Risk:         riskToContractString(def.Risk),
			PolicyRisk:   browserPolicyRisk(id),
			Idempotent:   def.Idempotent,
			FixedFields:  def.FixedFields,
		})
	}
	sort.Slice(cmds, func(i, j int) bool { return cmds[i].ID < cmds[j].ID })
	return browserContract{
		SchemaVersion: 1,
		GeneratedFrom: "packages/tabtin-cli-go/cmd/browser/browser.go (via TestExportBrowserContractToFile)",
		Note:          "BR-7 Browser Runtime Contract 的机器可读投影（CLI 侧）。请勿手改：跑 scripts/generate-browser-contract.py 重新生成。",
		Commands:      cmds,
	}
}

func browserPolicyRisk(id string) string {
	if browserAutoAllowPolicyActions[id] {
		return "read"
	}
	if browserHighRiskPolicyActions[id] {
		return "high-risk-write"
	}
	return ""
}

// marshalBrowserContract 是契约 JSON 的唯一序列化口径（导出落盘 / up-to-date 校验共用，
// 保证两边字节级一致）：2 空格缩进 + 末尾换行。
func marshalBrowserContract(c browserContract) ([]byte, error) {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

// TestBrowserContractJSONUpToDate 断言落盘契约 JSON 与当前 CLI 命令树一致。
// 漂移（加/删/改命令未重新生成）即红，提示跑 generate 脚本。纯 go test 即可触发，
// 不依赖 python（python --check 是 CI 里的等价守门）。
func TestBrowserContractJSONUpToDate(t *testing.T) {
	want, err := marshalBrowserContract(buildBrowserContract(t))
	if err != nil {
		t.Fatalf("marshal contract: %v", err)
	}
	got := readRepoFile(t, contractJSONRelPath)
	if got != string(want) {
		t.Errorf("%s 与当前 CLI 命令树不一致 —— 运行 `python3 scripts/generate-browser-contract.py` 重新生成", contractJSONRelPath)
	}
}

func TestBrowserContractPolicyRiskHighRiskWrite(t *testing.T) {
	contract := buildBrowserContract(t)
	byID := make(map[string]browserContractCommand, len(contract.Commands))
	for _, cmd := range contract.Commands {
		byID[cmd.ID] = cmd
	}

	for _, id := range []string{"act", "batch", "eval", "route", "unroute", "cookies.clear"} {
		cmd, ok := byID[id]
		if !ok {
			t.Fatalf("missing browser contract command %q", id)
		}
		if cmd.Risk != "write" {
			t.Fatalf("%s execution risk = %q, want write（不要改变 CLI 默认 --yes 行为）", id, cmd.Risk)
		}
		if cmd.PolicyRisk != "high-risk-write" {
			t.Fatalf("%s policyRisk = %q, want high-risk-write", id, cmd.PolicyRisk)
		}
	}

	for _, id := range []string{"open", "nav", "tab.switch"} {
		cmd, ok := byID[id]
		if !ok {
			t.Fatalf("missing browser contract command %q", id)
		}
		if cmd.Risk != "write" {
			t.Fatalf("%s execution risk = %q, want write（保留 CLI 默认 --yes 行为）", id, cmd.Risk)
		}
		if cmd.PolicyRisk != "read" {
			t.Fatalf("%s policyRisk = %q, want read（浏览器策略自动放行）", id, cmd.PolicyRisk)
		}
	}
}

// TestExportBrowserContractToFile 供 scripts/generate-browser-contract.py 导出落盘。
func TestExportBrowserContractToFile(t *testing.T) {
	outPath := os.Getenv("TABTIN_BROWSER_CONTRACT_EXPORT")
	if outPath == "" {
		t.Skip("TABTIN_BROWSER_CONTRACT_EXPORT 未设置")
	}
	raw, err := marshalBrowserContract(buildBrowserContract(t))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}
