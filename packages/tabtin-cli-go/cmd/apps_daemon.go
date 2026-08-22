package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// ─── Daemon ──────────────────────────────────────────────────────

func newCmdDaemon(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "daemon", Short: "Daemon 管理"}

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "status", Short: "Daemon 状态", Example: "  tabtin daemon status", Route: cmdutil.RouteDirect, HasFormat: true,
		RunFunc: daemonStatusFunc(f),
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk（W5.5）
		Use: "stop", Short: "停止 Daemon", Example: "  tabtin daemon stop", Route: cmdutil.RouteDirect,
		Risk:    cmdutil.RiskWrite,
		RunFunc: daemonStopFunc(),
	})

	// daemon start 是 tabtin-daemon binary 的薄 shim：
	//   1. PATH 里能找到 tabtin-daemon → 直接 exec（继承 stdio + 信号）
	//   2. 找不到 → 在 monorepo 里查 apps/tabtin-daemon/dist/index.js，用 node 跑
	//   3. 都不行 → 打印明确的安装/启动指引（不再叫 Agent 跑一个不存在的命令）
	// 历史 hint 的"请使用 npx tabtin-daemon"既不准确（包名是 @tabtin/daemon）
	// 也跟主命令自相矛盾——`tabtin daemon start` 喊你去跑另一条命令。
	// 单独注册（不进 stubs[]）——它是真启动逻辑而非 stub，与 status/stop 同级。
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "start", Short: "启动 Daemon", Route: cmdutil.RouteDirect,
		Example: "  tabtin daemon start\n" +
			"  tabtin daemon start --dry-run    # 只解析 launcher（bin/args/source），不真正 exec\n" +
			"  TABTIN_DEBUG=1 tabtin daemon start    # exec 前把解析结果打到 stderr",
		Risk:    cmdutil.RiskWrite,
		RunFunc: daemonStartFunc(),
		// start 不发 HTTP，是 exec 本地 daemon binary；dry-run 只跑 resolveDaemonLauncher
		// （LookPath + Stat，纯只读）报告将执行什么，绝不 exec。
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			plan := cmdutil.NewDryRunPlan().Desc("启动本地 tabtin-daemon 进程（exec binary，不发 HTTP 请求）")
			bin, args, source, err := resolveDaemonLauncher(ctx.Args)
			if err != nil {
				return plan.Set("resolved", false).Set("error", err.Error())
			}
			return plan.
				Set("resolved", true).
				Set("source", source).
				Set("command", append([]string{bin}, args...))
		},
	})

	stubs := []cmdutil.CommandDef{
		{Use: "config", Short: "Daemon 配置", Example: "  tabtin daemon config", Route: cmdutil.RouteDirect, HasFormat: true, RunFunc: daemonStubFunc("config", "请使用 tabtin config 管理配置")},
		{Use: "logs", Short: "查看日志", Example: "  tabtin daemon logs", Route: cmdutil.RouteDirect, RunFunc: daemonLogsFunc()},
		{Use: "doctor", Short: "环境诊断", Example: "  tabtin daemon doctor", Route: cmdutil.RouteDirect, HasFormat: true, RunFunc: daemonStubFunc("doctor", "请使用 tabtin doctor 进行环境诊断")},
		{Use: "update", Short: "更新 Daemon", Example: "  tabtin daemon update", Route: cmdutil.RouteDirect, Risk: cmdutil.RiskWrite, RunFunc: daemonStubFunc("update", "请使用包管理器更新: npm update -g @tabtin/daemon")},
	}
	for _, def := range stubs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

func daemonStatusFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		discoveryPath := config.DaemonDiscoveryPath()
		data, err := os.ReadFile(discoveryPath)
		if err != nil {
			output.PrintResult(output.SuccessEnvelope(map[string]any{
				"status": "stopped",
				"detail": "Daemon 未运行或 discovery 文件不存在",
			}), f.Format)
			return nil
		}
		var info map[string]any
		if err := json.Unmarshal(data, &info); err != nil {
			output.PrintResult(output.SuccessEnvelope(map[string]any{"status": "unknown", "error": "discovery 文件格式异常"}), f.Format)
			return nil
		}
		info["status"] = "running"
		if tr, trErr := f.Transport(); trErr == nil {
			reqCtx := ctx.ReqContext
			if reqCtx == nil {
				reqCtx = context.Background()
			}
			resp, reqErr := tr.Request(reqCtx, "GET", "/health", nil, nil)
			if reqErr == nil && resp.Status == 200 {
				var health map[string]any
				if json.Unmarshal(resp.Data, &health) == nil {
					if d, ok := health["data"].(map[string]any); ok {
						for k, v := range d {
							info[k] = v
						}
					}
				}
			} else {
				info["status"] = "unreachable"
			}
		}
		output.PrintResult(output.SuccessEnvelope(info), f.Format)
		return nil
	}
}

func daemonStopFunc() func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		discoveryPath := config.DaemonDiscoveryPath()
		data, err := os.ReadFile(discoveryPath)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.Unavailable), "Daemon 未运行", "tabtin daemon start", output.ExitServiceUnavail,
			))
		}
		var info map[string]any
		if err := json.Unmarshal(data, &info); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), "discovery 文件格式异常", "", output.ExitGeneral,
			))
		}
		pid, ok := info["pid"].(float64)
		if !ok || pid <= 0 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), "无法获取 Daemon PID", "", output.ExitGeneral,
			))
		}
		proc, err := os.FindProcess(int(pid))
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), fmt.Sprintf("找不到进程 %d", int(pid)), "", output.ExitGeneral,
			))
		}
		if err := proc.Signal(os.Interrupt); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), fmt.Sprintf("停止 Daemon 失败: %v", err), "", output.ExitGeneral,
			))
		}
		output.PrintResult(output.SuccessEnvelope(map[string]any{
			"message": fmt.Sprintf("已向 Daemon (PID %d) 发送停止信号", int(pid)),
			"pid":     int(pid),
		}), ctx.Factory.Format)
		return nil
	}
}

func daemonLogsFunc() func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		logPaths := config.DaemonLogPaths()
		var foundPaths []string
		for _, p := range logPaths {
			if _, err := os.Stat(p); err == nil {
				foundPaths = append(foundPaths, p)
			}
		}
		if len(foundPaths) == 0 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound), "未找到 Daemon 日志文件", "tabtin daemon start", output.ExitNotFound,
			))
		}
		output.PrintResult(output.SuccessEnvelope(map[string]any{
			"log_paths": foundPaths,
			"hint":      fmt.Sprintf("使用 tail -f %s 查看实时日志", foundPaths[0]),
		}), ctx.Factory.Format)
		return nil
	}
}

func daemonStubFunc(name, hint string) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		output.PrintResult(output.SuccessEnvelope(map[string]any{
			"command": fmt.Sprintf("tabtin daemon %s", name),
			"hint":    hint,
		}), ctx.Factory.Format)
		return nil
	}
}

// daemonStartFunc 把 `tabtin daemon start` 桥接到真实的 tabtin-daemon binary。
//
// 历史问题：本命令之前是个 stub，只会输出 "请使用 npx tabtin-daemon 启动 Daemon"；
// 同时所有 RouteCliServer 命令在 daemon 没跑时返回的 hint 是 "tabtin daemon start"。
// 两条 hint 互相指——Agent / 用户照着跑一圈回到原地。
//
// 现在的行为（按优先级）：
//  1. PATH 中存在 `tabtin-daemon` → exec 它，stdio/信号/退出码全透传
//  2. monorepo dev 场景：找到 apps/tabtin-daemon/dist/index.js → `node <path> start ...`
//  3. 上面都没有 → 打印 actionable 错误：列出所有真实可用的安装/启动方式
//
// 设计：透传 ctx.Args（cobra 已解析），不重复解析 flag——保持 wrapper 行为简单可预期。
func daemonStartFunc() func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		bin, args, source, err := resolveDaemonLauncher(ctx.Args)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound), err.Error(),
				"安装：npm install -g @tabtin/daemon；首次启动：tabtin-daemon init --token <token> && tabtin-daemon start",
				output.ExitNotFound,
			))
		}

		if os.Getenv("TABTIN_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[debug] tabtin daemon start → %s (source=%s) %s\n",
				bin, source, strings.Join(args, " "))
		}

		proc := exec.Command(bin, args...)
		proc.Stdin = os.Stdin
		proc.Stdout = os.Stdout
		proc.Stderr = os.Stderr
		runErr := proc.Run()
		if runErr == nil {
			return nil
		}
		var exitErr *exec.ExitError
		// errors.As 的等价形式——避免再 import errors，沿用项目里已有的 syscall + ExitError 解包
		if ee, ok := runErr.(*exec.ExitError); ok {
			exitErr = ee
		}
		if exitErr != nil {
			if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Exited() {
				return output.NewExitError(ws.ExitStatus())
			}
			return output.NewExitError(exitErr.ExitCode())
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("执行 %s 失败: %v", bin, runErr), "", output.ExitGeneral,
		))
	}
}

// resolveDaemonLauncher 找出该用什么 binary + 参数来启动 daemon。
//
// 返回：bin, args, source（用于 debug 提示）, error。
// extraArgs 是用户在 `tabtin daemon start` 后面附加的位置参数，会原样接到 daemon 调用的尾巴。
func resolveDaemonLauncher(extraArgs []string) (string, []string, string, error) {
	if path, err := exec.LookPath("tabtin-daemon"); err == nil {
		args := append([]string{"start"}, extraArgs...)
		return path, args, "PATH", nil
	}

	if repoRoot, ok := findRepoRoot(); ok {
		distEntry := filepath.Join(repoRoot, "apps", "tabtin-daemon", "dist", "index.js")
		if _, statErr := os.Stat(distEntry); statErr == nil {
			if nodePath, lookErr := exec.LookPath("node"); lookErr == nil {
				args := append([]string{distEntry, "start"}, extraArgs...)
				return nodePath, args, "monorepo:apps/tabtin-daemon/dist", nil
			}
		}
	}

	return "", nil, "", fmt.Errorf(
		"未找到 tabtin-daemon 可执行文件。三种安装方式任选其一：\n" +
			"  1. 全局安装：npm install -g @tabtin/daemon\n" +
			"  2. monorepo 内构建：pnpm --filter @tabtin/daemon build （会生成 apps/tabtin-daemon/dist/index.js）\n" +
			"  3. monorepo dev 模式：cd apps/tabtin-daemon && pnpm dev start\n" +
			"安装好后请先 tabtin-daemon init --token <token>，再 tabtin-daemon start。\n" +
			"（如果你只是想用桌面端，启动 TabTin Electron App 即可，无需 daemon）",
	)
}

// ─── Skill ───────────────────────────────────────────────────────
