package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdCompletionInstall(_ *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "completion-install",
		Short: "安装 Shell 补全到当前 Shell",
		Long: `自动检测当前 Shell 并安装补全脚本。

支持 bash、zsh、fish。安装后需要重新打开终端生效。`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			shell := detectShell()
			if shell == "" {
				return fmt.Errorf("无法检测当前 Shell。请手动使用 'tabtin completion bash/zsh/fish'")
			}

			switch shell {
			case "zsh":
				return installZsh(cmd.Root())
			case "bash":
				return installBash(cmd.Root())
			case "fish":
				return installFish(cmd.Root())
			default:
				return fmt.Errorf("不支持的 Shell: %s。支持 bash、zsh、fish", shell)
			}
		}),
	}
}

func detectShell() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	base := filepath.Base(shell)
	switch {
	case strings.Contains(base, "zsh"):
		return "zsh"
	case strings.Contains(base, "bash"):
		return "bash"
	case strings.Contains(base, "fish"):
		return "fish"
	default:
		return base
	}
}

func installZsh(rootCmd *cobra.Command) error {
	var dir string
	if runtime.GOOS == "darwin" {
		dir = filepath.Join(os.Getenv("HOME"), ".zsh/completions")
	} else {
		dir = filepath.Join(os.Getenv("HOME"), ".local/share/zsh/site-functions")
	}

	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建补全目录失败: %w", err)
	}

	path := filepath.Join(dir, "_tabtin")
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("创建补全文件失败: %w", err)
	}
	defer f.Close()

	if err := rootCmd.GenZshCompletion(f); err != nil {
		return fmt.Errorf("生成补全脚本失败: %w", err)
	}

	rcFile := filepath.Join(os.Getenv("HOME"), ".zshrc")
	rcContent, _ := os.ReadFile(rcFile)
	fpathLine := fmt.Sprintf("fpath=(%s $fpath)", dir)
	if !strings.Contains(string(rcContent), fpathLine) {
		appendToFile(rcFile, fmt.Sprintf("\n# TabTin CLI completion\n%s\nautoload -Uz compinit && compinit\n", fpathLine))
	}

	fmt.Fprintf(os.Stderr, "✓ Zsh 补全已安装到 %s\n", path)
	fmt.Fprintf(os.Stderr, "  请重新打开终端或运行 'source ~/.zshrc' 生效\n")
	return nil
}

func installBash(rootCmd *cobra.Command) error {
	var dir string
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("brew", "--prefix").Output()
		if err != nil {
			dir = "/usr/local/etc/bash_completion.d"
		} else {
			dir = filepath.Join(strings.TrimSpace(string(out)), "etc/bash_completion.d")
		}
	} else {
		dir = filepath.Join(os.Getenv("HOME"), ".local/share/bash-completion/completions")
	}

	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建补全目录失败: %w", err)
	}

	path := filepath.Join(dir, "tabtin")
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("创建补全文件失败: %w", err)
	}
	defer f.Close()

	if err := rootCmd.GenBashCompletion(f); err != nil {
		return fmt.Errorf("生成补全脚本失败: %w", err)
	}

	fmt.Fprintf(os.Stderr, "✓ Bash 补全已安装到 %s\n", path)
	fmt.Fprintf(os.Stderr, "  请重新打开终端生效\n")
	return nil
}

func installFish(rootCmd *cobra.Command) error {
	dir := filepath.Join(os.Getenv("HOME"), ".config/fish/completions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建补全目录失败: %w", err)
	}

	path := filepath.Join(dir, "tabtin.fish")
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("创建补全文件失败: %w", err)
	}
	defer f.Close()

	if err := rootCmd.GenFishCompletion(f, true); err != nil {
		return fmt.Errorf("生成补全脚本失败: %w", err)
	}

	fmt.Fprintf(os.Stderr, "✓ Fish 补全已安装到 %s\n", path)
	return nil
}

func appendToFile(path, content string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(content)
	return err
}
