package cmd

// App Market H1 — install 子命令的共享 shim（v3.1 方向锚对齐）。
//
// 设计原则（harness 接管 G1 决策）：
//   - Go 端只做"薄 shim"——把子命令 + 参数透传给 Python `tabtin_cli`。
//   - 治理层（CliInvocationParser / PermissionRuleEngine / CliAuditEvent / HITL /
//     执行前 verify stub）全部在 Python 侧，Go 不重复实现。
//   - 退出码透传 Python 进程的 exit code，保持 A5 定义的协议
//     （0 / 2 / 78 / 126 / 127）不变。
//
// v3.1（2026-04-19）：`tabtin connect` 子命令整体删除（方向锚 H8）；本 shim 现在
// 只服务 install 一个 Go 子命令。
//
// 定位 Python 的策略（优先级递减）：
//  1. 环境变量 TABTIN_PYTHON              — 用户显式指定
//  2. 环境变量 TABTIN_REPO_ROOT           — 从显式 repo root 推导
//     <root>/apps/tabtin_django/venv/bin/python
//  3. 从当前 binary 位置或 cwd 向上查找 apps/tabtin_django/manage.py，
//     推出 repo root + venv python
//  4. 系统 PATH 中的 python3（最后兜底，依赖用户 PYTHONPATH 已配好）
//
// 这种分层 fallback 允许：
//   - 开发场景：用户 cd 到 repo 或 TabTin Electron bundle 里的 binary 自动定位
//   - CI 场景：显式 TABTIN_PYTHON 指 venv python
//   - 生产场景（H2）：Electron 打包时可直接设置 TABTIN_PYTHON 指向 bundle python
//
// 本文件 H1 引入，H2 如果把治理层整体 Go 化，本 shim 可整体删除。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/output"
)

const (
	pythonCliModule       = "apps.services.agent_engine.cli.tabtin_cli"
	djangoSettingsDefault = "tabtin.settings"
)

// pythonShimConfig 捕获 fork Python 所需的全部环境信息。
// 每次 shim 调用都会解析一次（无 cache）——成本仅 几 ms 文件系统查找，对 CLI 可忽略。
type pythonShimConfig struct {
	PythonBin   string // python 解释器绝对路径（或 PATH 中的名字，如 "python3"）
	DjangoDir   string // apps/tabtin_django 绝对路径（PYTHONPATH 根）
	RepoRoot    string // monorepo 根路径（用作子进程 cwd）
	DebugOrigin string // 本次定位结果的来源说明，失败时展示给用户
}

// resolvePythonShim 按上述优先级找 Python。
//
// 失败时返回的 error 已包含 actionable 说明，调用方直接打印即可。
func resolvePythonShim() (pythonShimConfig, error) {
	if pyBin := strings.TrimSpace(os.Getenv("TABTIN_PYTHON")); pyBin != "" {
		djangoDir := os.Getenv("TABTIN_DJANGO_DIR")
		repoRoot := os.Getenv("TABTIN_REPO_ROOT")
		if djangoDir == "" || repoRoot == "" {
			// TABTIN_PYTHON 显式设置但 repo root 没给——尝试自动发现
			if root, ok := findRepoRoot(); ok {
				repoRoot = root
				djangoDir = filepath.Join(root, "apps", "tabtin_django")
			} else {
				return pythonShimConfig{}, errors.New(
					"TABTIN_PYTHON 已设置但找不到 repo root。请同时设置 TABTIN_REPO_ROOT 环境变量",
				)
			}
		}
		return pythonShimConfig{
			PythonBin:   pyBin,
			DjangoDir:   djangoDir,
			RepoRoot:    repoRoot,
			DebugOrigin: "TABTIN_PYTHON env",
		}, nil
	}

	if explicitRoot := strings.TrimSpace(os.Getenv("TABTIN_REPO_ROOT")); explicitRoot != "" {
		djangoDir := filepath.Join(explicitRoot, "apps", "tabtin_django")
		venvPy := filepath.Join(djangoDir, "venv", "bin", "python")
		if _, err := os.Stat(venvPy); err == nil {
			return pythonShimConfig{
				PythonBin:   venvPy,
				DjangoDir:   djangoDir,
				RepoRoot:    explicitRoot,
				DebugOrigin: "TABTIN_REPO_ROOT env + venv",
			}, nil
		}
		// venv 不存在时也可尝试系统 python3（依赖 PYTHONPATH）
		return pythonShimConfig{
			PythonBin:   "python3",
			DjangoDir:   djangoDir,
			RepoRoot:    explicitRoot,
			DebugOrigin: "TABTIN_REPO_ROOT env + PATH python3",
		}, nil
	}

	if root, ok := findRepoRoot(); ok {
		djangoDir := filepath.Join(root, "apps", "tabtin_django")
		venvPy := filepath.Join(djangoDir, "venv", "bin", "python")
		if _, err := os.Stat(venvPy); err == nil {
			return pythonShimConfig{
				PythonBin:   venvPy,
				DjangoDir:   djangoDir,
				RepoRoot:    root,
				DebugOrigin: "auto-discovered repo root + venv",
			}, nil
		}
		return pythonShimConfig{
			PythonBin:   "python3",
			DjangoDir:   djangoDir,
			RepoRoot:    root,
			DebugOrigin: "auto-discovered repo root + PATH python3",
		}, nil
	}

	return pythonShimConfig{}, errors.New(
		"定位 Python tabtin_cli 失败。请设置以下环境变量之一：\n" +
			"  TABTIN_PYTHON       — 指向可用的 python 解释器（需已能 import apps.services.agent_engine.cli.tabtin_cli）\n" +
			"  TABTIN_REPO_ROOT    — 指向 monorepo 根（含 apps/tabtin_django/manage.py）\n" +
			"或从 monorepo 任意子目录运行本命令",
	)
}

// findRepoRoot 从当前 binary 位置与 cwd 向上查找 apps/tabtin_django/manage.py。
// 找到则返回 repo root 绝对路径。
func findRepoRoot() (string, bool) {
	seen := map[string]struct{}{}
	candidates := []string{}

	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			candidates = append(candidates, filepath.Dir(real))
		} else {
			candidates = append(candidates, filepath.Dir(exe))
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}

	for _, start := range candidates {
		dir := start
		for {
			if _, ok := seen[dir]; ok {
				break
			}
			seen[dir] = struct{}{}

			marker := filepath.Join(dir, "apps", "tabtin_django", "manage.py")
			if _, err := os.Stat(marker); err == nil {
				return dir, true
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", false
}

// forkPythonTabtinCli fork python `-m apps.services.agent_engine.cli.tabtin_cli <subcmd> <args>`。
//
// 行为：
//   - stdin/stdout/stderr 透传给子进程，不 buffer（保证第三方 CLI 这类交互式子命令 OAuth 能工作）
//   - 信号由 Go CLI cobra 的 signal.NotifyContext 接管；ctx 取消时子进程会被 SIGKILL
//     （cobra 已配好 signal.NotifyContext(context.Background(), os.Interrupt, SIGTERM)）
//   - 退出码透传：正常退出 → Python 返回什么就什么；exec 启动失败 → ExitGeneral
//     并打印 debug 信息
func forkPythonTabtinCli(ctx context.Context, subcmd string, args []string) error {
	cfg, err := resolvePythonShim()
	if err != nil {
		return err
	}

	cmdArgs := []string{"-m", pythonCliModule, subcmd}
	cmdArgs = append(cmdArgs, args...)

	proc := exec.CommandContext(ctx, cfg.PythonBin, cmdArgs...)

	proc.Dir = cfg.RepoRoot
	proc.Stdin = os.Stdin
	proc.Stdout = os.Stdout
	proc.Stderr = os.Stderr

	// 继承当前环境，只补充/覆盖必要变量
	env := os.Environ()
	pythonPath := cfg.DjangoDir
	if existing := os.Getenv("PYTHONPATH"); existing != "" {
		pythonPath = cfg.DjangoDir + string(os.PathListSeparator) + existing
	}
	env = appendOrOverrideEnv(env, "PYTHONPATH", pythonPath)
	if os.Getenv("DJANGO_SETTINGS_MODULE") == "" {
		env = append(env, "DJANGO_SETTINGS_MODULE="+djangoSettingsDefault)
	}
	proc.Env = env

	runErr := proc.Run()
	if runErr == nil {
		return nil
	}

	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		// 透传 Python 子进程退出码（A5 协议：0/2/78/126/127/其他）
		// 用 output.ExitError 让 root.go 的 Execute() 能识别并回传给 os.Exit
		return output.NewExitError(exitErr.ExitCode())
	}

	// 真实 exec 失败（python binary 不存在 / permission denied 等）
	return fmt.Errorf(
		"fork python tabtin_cli 失败 (origin=%s, python=%s, django_dir=%s): %w",
		cfg.DebugOrigin, cfg.PythonBin, cfg.DjangoDir, runErr,
	)
}

// appendOrOverrideEnv 如果 key 已在 env 里就替换，否则追加。
// 主要用于 PYTHONPATH 场景——要让 django_dir 排在用户已有 PYTHONPATH 前面。
func appendOrOverrideEnv(env []string, key, value string) []string {
	prefix := key + "="
	replaced := false
	out := env[:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			out = append(out, prefix+value)
			replaced = true
			continue
		}
		out = append(out, kv)
	}
	if !replaced {
		out = append(out, prefix+value)
	}
	return out
}
