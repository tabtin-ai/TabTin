package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

const (
	browserDoctorStatusOK   = "ok"
	browserDoctorStatusWarn = "warn"
	browserDoctorStatusFail = "fail"

	browserDoctorExpectedActionCount = 50
	browserDoctorStaleThreshold      = 7 * 24 * time.Hour
	browserDoctorDialTimeout         = 700 * time.Millisecond
	browserDoctorHTTPTimeout         = 2 * time.Second
)

type browserDoctorEnv struct {
	now       func() time.Time
	configDir func() string
	homeDir   func() string
	repoRoot  func() string
	pidAlive  func(int) bool
	dialUnix  func(string, time.Duration) (net.Conn, error)
	remove    func(string) error
	stat      func(string) (os.FileInfo, error)
	readFile  func(string) ([]byte, error)
}

func defaultBrowserDoctorEnv() browserDoctorEnv {
	return browserDoctorEnv{
		now:       time.Now,
		configDir: config.Dir,
		homeDir:   browserDoctorHomeDir,
		repoRoot:  findRepoRoot,
		pidAlive:  processAlive,
		dialUnix: func(sock string, timeout time.Duration) (net.Conn, error) {
			return net.DialTimeout("unix", sock, timeout)
		},
		remove:   os.Remove,
		stat:     os.Stat,
		readFile: os.ReadFile,
	}
}

type browserDoctorDiscovery struct {
	Sock      string `json:"sock"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt,omitempty"`
	Source    string `json:"source,omitempty"`
}

type browserDoctorReport struct {
	SchemaVersion int                  `json:"schemaVersion"`
	GeneratedAt   string               `json:"generatedAt"`
	OverallStatus string               `json:"overallStatus"`
	Checks        []browserDoctorCheck `json:"checks"`
	Fixes         []browserDoctorFix   `json:"fixes,omitempty"`
	Suggestions   []string             `json:"suggestions,omitempty"`
	Summary       browserDoctorSummary `json:"summary"`
}

type browserDoctorSummary struct {
	OK       int `json:"ok"`
	Warnings int `json:"warnings"`
	Failures int `json:"failures"`
}

type browserDoctorCheck struct {
	ID         string         `json:"id"`
	Label      string         `json:"label"`
	Status     string         `json:"status"`
	Summary    string         `json:"summary"`
	Detail     map[string]any `json:"detail,omitempty"`
	Suggestion string         `json:"suggestion,omitempty"`
	SafeFix    string         `json:"safeFix,omitempty"`
}

type browserDoctorFix struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Path    string `json:"path,omitempty"`
	Error   string `json:"error,omitempty"`
}

type browserDoctorOptions struct {
	Fix    bool
	Strict bool
}

func browserDoctorCommandDef(f *cmdutil.Factory) cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use:   "doctor",
		Short: "浏览器健康自检",
		Long: `本地只读检查 TabWeb 运行链路：CLI Server/socket、Electron/Daemon discovery、
browser capabilities 契约版本、Patchright/Daemon 可用性，以及旧 bundle / 僵死进程风险。

默认只观察本机发现文件、进程、socket 与仓库静态契约；不会启动 live stack，也不会打开网页。
默认即使发现 warn/fail 也退出 0，方便排障查看完整报告；--strict 会在存在 fail 时返回非 0。
--fix 只清理已经确认安全的 discovery 文件：JSON 损坏、缺 sock/token、或 PID 已死；危险修复仅给提示。`,
		Example:    "  tabtin browser doctor\n  tabtin browser doctor --format json\n  tabtin browser doctor --strict --format json\n  tabtin browser doctor --fix --format json",
		Route:      cmdutil.RouteDirect,
		HasFormat:  true,
		Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "fix", Type: cmdutil.FlagBool, CliOnly: true, Desc: "只执行安全修复：清理 JSON 损坏、缺 sock/token、或 PID 已死的 discovery 文件；不会杀进程、重启服务或安装依赖"},
			{Name: "strict", Type: cmdutil.FlagBool, CliOnly: true, Desc: "存在 fail 检查项时返回非 0；默认仅输出诊断报告并退出 0"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			report := runBrowserDoctor(ctx.ReqContext, defaultBrowserDoctorEnv(), browserDoctorOptions{Fix: ctx.Bool("fix"), Strict: ctx.Bool("strict")})
			if f.Format == output.FormatJSON {
				output.PrintResult(output.SuccessEnvelope(report), f.Format)
			} else {
				output.PrintResult(renderBrowserDoctorText(report), f.Format)
			}
			if browserDoctorShouldExitNonZero(report, browserDoctorOptions{Strict: ctx.Bool("strict")}) {
				return output.NewExitError(output.ExitServiceUnavail)
			}
			return nil
		},
	}
}

func runBrowserDoctor(ctx context.Context, env browserDoctorEnv, opts browserDoctorOptions) browserDoctorReport {
	if env.now == nil {
		env = defaultBrowserDoctorEnv()
	}
	report := browserDoctorReport{
		SchemaVersion: 1,
		GeneratedAt:   env.now().UTC().Format(time.RFC3339),
		OverallStatus: browserDoctorStatusOK,
	}
	discoveries := checkBrowserDoctorDiscovery(&report, env)
	checkBrowserDoctorSelection(&report, env, discoveries)
	checkBrowserDoctorCapabilities(&report, env)
	checkBrowserDoctorDaemon(&report, env)
	checkBrowserDoctorPatchright(&report, env)
	checkBrowserDoctorSocketHealth(ctx, &report, env, discoveries)
	checkBrowserDoctorStaleRisks(&report, env, discoveries)
	if opts.Fix {
		applyBrowserDoctorSafeFixes(&report, env)
	}
	propagateBrowserDoctorSummary(&report)
	_ = ctx
	return report
}

func checkBrowserDoctorDiscovery(report *browserDoctorReport, env browserDoctorEnv) []browserDoctorRuntimeDiscovery {
	files := []struct {
		name    string
		runtime string
	}{
		{"server.json", "electron"},
		{"dev-server.json", "electron"},
		{"daemon-server.json", "daemon"},
	}
	out := make([]browserDoctorRuntimeDiscovery, 0, len(files))
	for _, item := range files {
		path := filepath.Join(env.configDir(), item.name)
		raw, err := env.readFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				report.addCheck(browserDoctorCheck{
					ID:      "discovery." + strings.TrimSuffix(item.name, ".json"),
					Label:   item.runtime + " discovery",
					Status:  browserDoctorStatusWarn,
					Summary: item.name + " 不存在",
					Detail:  map[string]any{"path": path, "runtime": item.runtime},
				})
				continue
			}
			report.addCheck(browserDoctorCheck{
				ID:         "discovery." + strings.TrimSuffix(item.name, ".json"),
				Label:      item.runtime + " discovery",
				Status:     browserDoctorStatusWarn,
				Summary:    item.name + " 不可读",
				Detail:     map[string]any{"path": path, "error": err.Error()},
				Suggestion: "检查 ~/.tabtin 权限，或重启对应 runtime 重新写入 discovery 文件",
			})
			continue
		}
		var d browserDoctorDiscovery
		if err := json.Unmarshal(raw, &d); err != nil {
			report.addCheck(browserDoctorCheck{
				ID:         "discovery." + strings.TrimSuffix(item.name, ".json"),
				Label:      item.runtime + " discovery",
				Status:     browserDoctorStatusFail,
				Summary:    item.name + " JSON 损坏",
				Detail:     map[string]any{"path": path, "error": err.Error()},
				SafeFix:    "remove-discovery:" + path,
				Suggestion: "可用 --fix 清理损坏 discovery 文件，再重启对应 runtime",
			})
			out = append(out, browserDoctorRuntimeDiscovery{Runtime: item.runtime, File: item.name, Path: path, Discovery: d, ParseError: err})
			continue
		}
		alive := d.PID <= 0 || env.pidAlive(d.PID)
		sockExists := false
		if d.Sock != "" {
			if _, err := env.stat(expandHome(d.Sock, env.homeDir())); err == nil {
				sockExists = true
			}
		}
		status := browserDoctorStatusOK
		summary := item.name + " 可用"
		safeFix := ""
		suggestion := ""
		if d.Sock == "" || d.Token == "" {
			status = browserDoctorStatusFail
			summary = item.name + " 缺 sock/token"
			safeFix = "remove-discovery:" + path
			suggestion = "可用 --fix 清理无效 discovery 文件，再重启对应 runtime"
		} else if d.PID > 0 && !alive {
			status = browserDoctorStatusFail
			summary = fmt.Sprintf("%s 指向已退出 PID %d", item.name, d.PID)
			safeFix = "remove-discovery:" + path
			suggestion = "可用 --fix 清理 stale discovery 文件；需要浏览器能力时再启动 Electron 或 Daemon"
		} else if !sockExists {
			status = browserDoctorStatusWarn
			summary = item.name + " 的 socket 文件不存在"
			suggestion = "若进程仍在，先重启对应 runtime 重新监听 socket；doctor 不会自动删除仍可能属于活进程的 discovery"
		}
		detail := map[string]any{
			"path":       path,
			"runtime":    item.runtime,
			"sock":       d.Sock,
			"pid":        d.PID,
			"pidAlive":   alive,
			"sockExists": sockExists,
			"hasToken":   d.Token != "",
			"source":     d.Source,
			"startedAt":  d.StartedAt,
		}
		report.addCheck(browserDoctorCheck{
			ID:         "discovery." + strings.TrimSuffix(item.name, ".json"),
			Label:      item.runtime + " discovery",
			Status:     status,
			Summary:    summary,
			Detail:     detail,
			Suggestion: suggestion,
			SafeFix:    safeFix,
		})
		out = append(out, browserDoctorRuntimeDiscovery{Runtime: item.runtime, File: item.name, Path: path, Discovery: d})
	}
	return out
}

type browserDoctorRuntimeDiscovery struct {
	Runtime    string
	File       string
	Path       string
	Discovery  browserDoctorDiscovery
	ParseError error
}

func checkBrowserDoctorSelection(report *browserDoctorReport, env browserDoctorEnv, discoveries []browserDoctorRuntimeDiscovery) {
	if sock := os.Getenv("TABTIN_SOCK"); strings.TrimSpace(sock) != "" {
		token := os.Getenv("_TABTIN_TRANSPORT_TOKEN")
		status := browserDoctorStatusOK
		summary := "TABTIN_SOCK 显式覆盖 discovery"
		if token == "" {
			status = browserDoctorStatusWarn
			summary = "TABTIN_SOCK 已设置但缺 _TABTIN_TRANSPORT_TOKEN"
		}
		report.addCheck(browserDoctorCheck{
			ID:         "cli.selection",
			Label:      "CLI Server selection",
			Status:     status,
			Summary:    summary,
			Detail:     map[string]any{"sock": sock, "hasToken": token != ""},
			Suggestion: "显式指定 socket 时必须同时传 _TABTIN_TRANSPORT_TOKEN，否则 CLI Server 会 401",
		})
		return
	}
	for _, name := range []string{"server.json", "dev-server.json", "daemon-server.json"} {
		for _, d := range discoveries {
			if d.File != name || d.ParseError != nil || d.Discovery.Sock == "" || d.Discovery.Token == "" {
				continue
			}
			if d.Discovery.PID > 0 && !env.pidAlive(d.Discovery.PID) {
				continue
			}
			report.addCheck(browserDoctorCheck{
				ID:      "cli.selection",
				Label:   "CLI Server selection",
				Status:  browserDoctorStatusOK,
				Summary: fmt.Sprintf("默认会选择 %s (%s)", d.Runtime, d.File),
				Detail:  map[string]any{"runtime": d.Runtime, "file": d.File, "sock": d.Discovery.Sock, "pid": d.Discovery.PID},
			})
			return
		}
	}
	report.addCheck(browserDoctorCheck{
		ID:         "cli.selection",
		Label:      "CLI Server selection",
		Status:     browserDoctorStatusWarn,
		Summary:    "没有可自动发现的 Electron/Daemon CLI Server",
		Suggestion: "启动桌面端或 Daemon；doctor 不会自动启动 live stack",
	})
}

func checkBrowserDoctorSocketHealth(ctx context.Context, report *browserDoctorReport, env browserDoctorEnv, discoveries []browserDoctorRuntimeDiscovery) {
	probed := 0
	for _, d := range discoveries {
		if d.ParseError != nil || d.Discovery.Sock == "" || d.Discovery.Token == "" {
			continue
		}
		if d.Discovery.PID > 0 && !env.pidAlive(d.Discovery.PID) {
			continue
		}
		if _, err := env.stat(expandHome(d.Discovery.Sock, env.homeDir())); err != nil {
			continue
		}
		probed++
		statusCode, body, err := probeBrowserDoctorHealth(ctx, d.Discovery, env)
		status := browserDoctorStatusOK
		summary := fmt.Sprintf("%s /health 正常", d.Runtime)
		detail := map[string]any{
			"runtime": d.Runtime,
			"file":    d.File,
			"sock":    d.Discovery.Sock,
		}
		if err != nil {
			status = browserDoctorStatusWarn
			summary = fmt.Sprintf("%s socket 可见但 /health 不可达", d.Runtime)
			detail["error"] = err.Error()
		} else {
			detail["httpStatus"] = statusCode
			detail["health"] = body
			if statusCode != 200 {
				status = browserDoctorStatusWarn
				summary = fmt.Sprintf("%s /health 返回 HTTP %d", d.Runtime, statusCode)
			}
		}
		report.addCheck(browserDoctorCheck{
			ID:         "cli_server.health." + d.Runtime,
			Label:      d.Runtime + " CLI Server health",
			Status:     status,
			Summary:    summary,
			Detail:     detail,
			Suggestion: "若 socket 文件存在但 /health 不可达，优先重启对应 runtime；doctor 不会自动杀进程或重启",
		})
	}
	if probed == 0 {
		report.addCheck(browserDoctorCheck{
			ID:      "cli_server.health",
			Label:   "CLI Server health",
			Status:  browserDoctorStatusWarn,
			Summary: "没有可探测的本地 CLI Server socket",
			Detail:  map[string]any{"probed": 0},
		})
	}
}

func checkBrowserDoctorCapabilities(report *browserDoctorReport, env browserDoctorEnv) {
	root := env.repoRoot()
	contractPath := filepath.Join(root, "packages", "browser-core", "src", "generated", "browser-cli-contract.json")
	raw, err := env.readFile(contractPath)
	if err != nil {
		report.addCheck(browserDoctorCheck{
			ID:         "capabilities.contract",
			Label:      "Browser capabilities contract",
			Status:     browserDoctorStatusWarn,
			Summary:    "找不到 browser-cli-contract.json",
			Detail:     map[string]any{"path": contractPath, "error": err.Error()},
			Suggestion: "在仓库根运行 `python3 scripts/generate-browser-contract.py` 或检查构建产物",
		})
		return
	}
	var contract struct {
		SchemaVersion int `json:"schemaVersion"`
		Commands      []struct {
			ID           string `json:"id"`
			SelfDescribe bool   `json:"selfDescribe,omitempty"`
			Diagnostic   bool   `json:"diagnostic,omitempty"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		report.addCheck(browserDoctorCheck{
			ID:         "capabilities.contract",
			Label:      "Browser capabilities contract",
			Status:     browserDoctorStatusFail,
			Summary:    "browser-cli-contract.json 损坏",
			Detail:     map[string]any{"path": contractPath, "error": err.Error()},
			Suggestion: "重新生成 contract JSON，避免 capabilities 自报与 CLI 命令树漂移",
		})
		return
	}
	actionCount := 0
	diagnostics := []string{}
	for _, c := range contract.Commands {
		if c.Diagnostic {
			diagnostics = append(diagnostics, c.ID)
			continue
		}
		if !c.SelfDescribe {
			actionCount++
		}
	}
	status := browserDoctorStatusOK
	summary := fmt.Sprintf("schema=%d, actions=%d/%d", contract.SchemaVersion, actionCount, browserDoctorExpectedActionCount)
	if contract.SchemaVersion <= 0 || actionCount != browserDoctorExpectedActionCount {
		status = browserDoctorStatusWarn
		summary = fmt.Sprintf("能力契约数量异常：actions=%d, expected=%d", actionCount, browserDoctorExpectedActionCount)
	}
	report.addCheck(browserDoctorCheck{
		ID:      "capabilities.contract",
		Label:   "Browser capabilities contract",
		Status:  status,
		Summary: summary,
		Detail: map[string]any{
			"path":                contractPath,
			"schemaVersion":       contract.SchemaVersion,
			"commandCount":        len(contract.Commands),
			"actualActionCount":   actionCount,
			"expectedActionCount": browserDoctorExpectedActionCount,
			"diagnosticLeaves":    diagnostics,
		},
		Suggestion: "若 Electron/Daemon capabilities 数量与此处不一致，优先怀疑运行中实例仍在用旧 bundle",
	})
}

func checkBrowserDoctorDaemon(report *browserDoctorReport, env browserDoctorEnv) {
	statePaths := []string{
		filepath.Join(env.homeDir(), ".tabtin-daemon", "state.json"),
		filepath.Join(env.homeDir(), ".tabtin", "daemon", "state.json"),
	}
	for _, p := range statePaths {
		raw, err := env.readFile(p)
		if err != nil {
			continue
		}
		var state map[string]any
		if err := json.Unmarshal(raw, &state); err != nil {
			report.addCheck(browserDoctorCheck{
				ID:         "daemon.state",
				Label:      "Daemon state",
				Status:     browserDoctorStatusWarn,
				Summary:    "state.json 损坏",
				Detail:     map[string]any{"path": p, "error": err.Error()},
				Suggestion: "危险修复：不要手动改 state；重启 Daemon 让它重写状态文件",
			})
			return
		}
		pid := intFromAny(state["pid"])
		status := browserDoctorStatusOK
		summary := "Daemon state 可读"
		if pid > 0 && !env.pidAlive(pid) {
			status = browserDoctorStatusWarn
			summary = fmt.Sprintf("Daemon state 指向已退出 PID %d", pid)
		}
		report.addCheck(browserDoctorCheck{
			ID:      "daemon.state",
			Label:   "Daemon state",
			Status:  status,
			Summary: summary,
			Detail: map[string]any{
				"path":         p,
				"pid":          pid,
				"pidAlive":     pid <= 0 || env.pidAlive(pid),
				"version":      state["version"],
				"wsStatus":     state["ws_status"],
				"capabilities": state["capabilities"],
			},
			Suggestion: "若 state 版本或 capabilities 明显旧于仓库，重启 Daemon；doctor 不会自动杀进程",
		})
		return
	}
	report.addCheck(browserDoctorCheck{
		ID:         "daemon.state",
		Label:      "Daemon state",
		Status:     browserDoctorStatusWarn,
		Summary:    "未发现 Daemon state.json",
		Suggestion: "这对只使用 Electron browser 是正常的；需要 headless runtime 时启动 Daemon",
	})
}

func checkBrowserDoctorPatchright(report *browserDoctorReport, env browserDoctorEnv) {
	root := env.repoRoot()
	pkgPath := filepath.Join(root, "apps", "tabtin-daemon", "package.json")
	raw, err := env.readFile(pkgPath)
	if err != nil {
		report.addCheck(browserDoctorCheck{
			ID:         "patchright.dependency",
			Label:      "Patchright dependency",
			Status:     browserDoctorStatusWarn,
			Summary:    "无法读取 Daemon package.json",
			Detail:     map[string]any{"path": pkgPath, "error": err.Error()},
			Suggestion: "在仓库 worktree 内运行 doctor，或检查 apps/tabtin-daemon/package.json",
		})
		return
	}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		report.addCheck(browserDoctorCheck{
			ID:      "patchright.dependency",
			Label:   "Patchright dependency",
			Status:  browserDoctorStatusFail,
			Summary: "Daemon package.json 损坏",
			Detail:  map[string]any{"path": pkgPath, "error": err.Error()},
		})
		return
	}
	version := pkg.Dependencies["patchright-core"]
	if version == "" {
		report.addCheck(browserDoctorCheck{
			ID:         "patchright.dependency",
			Label:      "Patchright dependency",
			Status:     browserDoctorStatusFail,
			Summary:    "Daemon 未声明 patchright-core",
			Detail:     map[string]any{"path": pkgPath},
			Suggestion: "危险修复：不要由 doctor 安装依赖；走 pnpm workspace 正常补依赖并 review",
		})
		return
	}
	installedPath := filepath.Join(root, "apps", "tabtin-daemon", "node_modules", "patchright-core", "package.json")
	_, installedErr := env.stat(installedPath)
	status := browserDoctorStatusOK
	summary := "patchright-core 已声明"
	if installedErr != nil {
		status = browserDoctorStatusWarn
		summary = "patchright-core 已声明，但当前 worktree 未见本地安装产物"
	}
	report.addCheck(browserDoctorCheck{
		ID:      "patchright.dependency",
		Label:   "Patchright dependency",
		Status:  status,
		Summary: summary,
		Detail: map[string]any{
			"packageJson": pkgPath,
			"declared":    version,
			"installed":   installedErr == nil,
		},
		Suggestion: "缺安装产物时使用仓库 pnpm/workspace 流程，勿运行 npm install",
	})
}

func checkBrowserDoctorStaleRisks(report *browserDoctorReport, env browserDoctorEnv, discoveries []browserDoctorRuntimeDiscovery) {
	riskCount := 0
	for _, d := range discoveries {
		if d.ParseError != nil {
			riskCount++
			continue
		}
		if d.Discovery.PID > 0 && !env.pidAlive(d.Discovery.PID) {
			riskCount++
			continue
		}
		if st, err := env.stat(d.Path); err == nil && env.now().Sub(st.ModTime()) > browserDoctorStaleThreshold {
			riskCount++
		}
	}
	status := browserDoctorStatusOK
	summary := "未发现明显 stale discovery 风险"
	if riskCount > 0 {
		status = browserDoctorStatusWarn
		summary = fmt.Sprintf("发现 %d 个旧 discovery / stale process 风险", riskCount)
	}
	report.addCheck(browserDoctorCheck{
		ID:         "stale.discovery",
		Label:      "旧 bundle / stale process 风险",
		Status:     status,
		Summary:    summary,
		Detail:     map[string]any{"riskCount": riskCount, "thresholdHours": int(browserDoctorStaleThreshold.Hours())},
		Suggestion: "若 capabilities 数量旧、source 版本旧或 discovery 过期但 PID 仍存活，请重启 Electron/Daemon；--fix 仅清理 JSON 损坏、缺 sock/token、或 PID 已死的 discovery 文件",
	})
}

func applyBrowserDoctorSafeFixes(report *browserDoctorReport, env browserDoctorEnv) {
	seen := map[string]bool{}
	for i, check := range report.Checks {
		if !strings.HasPrefix(check.SafeFix, "remove-discovery:") {
			continue
		}
		path := strings.TrimPrefix(check.SafeFix, "remove-discovery:")
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		err := env.remove(path)
		fix := browserDoctorFix{ID: check.ID, Path: path}
		if err == nil || errors.Is(err, os.ErrNotExist) {
			fix.Status = "applied"
			fix.Summary = "已清理无效 discovery 文件"
			report.Checks[i].Summary += "（已清理）"
		} else {
			fix.Status = "failed"
			fix.Summary = "清理 discovery 文件失败"
			fix.Error = err.Error()
		}
		report.Fixes = append(report.Fixes, fix)
	}
	if len(report.Fixes) == 0 {
		report.Fixes = append(report.Fixes, browserDoctorFix{ID: "fix.none", Status: "skipped", Summary: "没有可安全自动修复的项目"})
	}
}

func (r *browserDoctorReport) addCheck(check browserDoctorCheck) {
	if check.Detail != nil {
		keys := make([]string, 0, len(check.Detail))
		for k := range check.Detail {
			keys = append(keys, k)
		}
		sort.Strings(keys)
	}
	r.Checks = append(r.Checks, check)
	if check.Suggestion != "" {
		r.Suggestions = appendUniqueString(r.Suggestions, check.Suggestion)
	}
}

func propagateBrowserDoctorSummary(report *browserDoctorReport) {
	for _, c := range report.Checks {
		switch c.Status {
		case browserDoctorStatusFail:
			report.Summary.Failures++
		case browserDoctorStatusWarn:
			report.Summary.Warnings++
		default:
			report.Summary.OK++
		}
	}
	if report.Summary.Failures > 0 {
		report.OverallStatus = browserDoctorStatusFail
	} else if report.Summary.Warnings > 0 {
		report.OverallStatus = browserDoctorStatusWarn
	} else {
		report.OverallStatus = browserDoctorStatusOK
	}
}

func renderBrowserDoctorText(report browserDoctorReport) []map[string]any {
	rows := make([]map[string]any, 0, len(report.Checks)+2)
	rows = append(rows, map[string]any{
		"check":   "overall",
		"status":  report.OverallStatus,
		"summary": fmt.Sprintf("ok=%d warn=%d fail=%d", report.Summary.OK, report.Summary.Warnings, report.Summary.Failures),
	})
	for _, c := range report.Checks {
		rows = append(rows, map[string]any{
			"check":      c.Label,
			"status":     c.Status,
			"summary":    c.Summary,
			"suggestion": c.Suggestion,
		})
	}
	for _, f := range report.Fixes {
		rows = append(rows, map[string]any{
			"check":   "fix:" + f.ID,
			"status":  f.Status,
			"summary": f.Summary,
		})
	}
	return rows
}

func browserDoctorShouldExitNonZero(report browserDoctorReport, opts browserDoctorOptions) bool {
	return opts.Strict && report.Summary.Failures > 0
}

func appendUniqueString(items []string, item string) []string {
	for _, existing := range items {
		if existing == item {
			return items
		}
	}
	return append(items, item)
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

func expandHome(path string, home string) string {
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}

func findRepoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return dir
		}
		dir = parent
	}
}

func browserDoctorHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return os.TempDir()
	}
	return home
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

func probeBrowserDoctorHealth(ctx context.Context, d browserDoctorDiscovery, env browserDoctorEnv) (int, map[string]any, error) {
	sock := expandHome(d.Sock, env.homeDir())
	conn, err := env.dialUnix(sock, browserDoctorDialTimeout)
	if err != nil {
		return 0, nil, err
	}
	defer conn.Close()

	reqCtx, cancel := context.WithTimeout(ctx, browserDoctorHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "GET", "/health", nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("X-TabTin-Token", d.Token)
	req.Header.Set("X-TabTin-Caller-Pid", fmt.Sprintf("%d", os.Getpid()))
	req.Host = "localhost"
	_ = conn.SetDeadline(env.now().Add(browserDoctorHTTPTimeout))
	if err := req.Write(conn); err != nil {
		return 0, nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	return resp.StatusCode, body, nil
}
