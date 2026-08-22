package configcmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// setupPurgeConfigDir 隔离 TABTIN_CONFIG_DIR 到临时 .tabtin 子目录，避免测试
// 触碰开发机真实 ~/.tabtin，并落一个占位配置文件模拟真实场景。
func setupPurgeConfigDir(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	dir := filepath.Join(tmp, ".tabtin")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"version":2}`), 0600); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	t.Setenv("TABTIN_CONFIG_DIR", dir)
	return dir
}

func TestConfigPurgeWithYesRemovesDir(t *testing.T) {
	dir := setupPurgeConfigDir(t)

	f := cmdutil.NewFactory()
	cmd := newCmdConfigPurge(f)
	cmd.SetArgs([]string{"--yes"})
	cmd.SetOut(new(strings.Builder))
	cmd.SetErr(new(strings.Builder))

	if err := cmd.Execute(); err != nil {
		t.Fatalf("purge --yes 应成功: %v", err)
	}

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("purge --yes 后目录应被删除，仍存在: %s", dir)
	}
}

func TestConfigPurgeWithoutYesRequiresConfirmation(t *testing.T) {
	dir := setupPurgeConfigDir(t)

	f := cmdutil.NewFactory()
	cmd := newCmdConfigPurge(f)
	cmd.SetIn(strings.NewReader("no\n"))
	cmd.SetOut(new(strings.Builder))
	cmd.SetErr(new(strings.Builder))

	if err := cmd.Execute(); err == nil {
		t.Fatal("未确认时应报错拒绝清除")
	}

	if _, err := os.Stat(dir); err != nil {
		t.Errorf("未确认时不应删除目录: %v", err)
	}
}

func TestConfigPurgeInteractiveYesConfirms(t *testing.T) {
	dir := setupPurgeConfigDir(t)

	f := cmdutil.NewFactory()
	cmd := newCmdConfigPurge(f)
	cmd.SetIn(strings.NewReader("yes\n"))
	cmd.SetOut(new(strings.Builder))
	cmd.SetErr(new(strings.Builder))

	if err := cmd.Execute(); err != nil {
		t.Fatalf("交互输入 yes 应成功: %v", err)
	}

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("确认后目录应被删除，仍存在: %s", dir)
	}
}

func TestConfigPurgeNoopWhenDirMissing(t *testing.T) {
	tmp := t.TempDir()
	dir := filepath.Join(tmp, "does-not-exist", ".tabtin")
	t.Setenv("TABTIN_CONFIG_DIR", dir)

	f := cmdutil.NewFactory()
	cmd := newCmdConfigPurge(f)
	cmd.SetArgs([]string{"--yes"})
	cmd.SetOut(new(strings.Builder))
	cmd.SetErr(new(strings.Builder))

	if err := cmd.Execute(); err != nil {
		t.Fatalf("目录不存在时应视为无需清理的成功: %v", err)
	}
}

// ：TABTIN_CONFIG_DIR 误配置成空串/家目录本身/文件系统根时拒绝清除，
// 防止 purge 变成误删家目录的破坏性命令。
func TestValidatePurgeDirRejectsDangerousPaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("无法解析家目录，跳过")
	}

	cases := []struct {
		name string
		dir  string
	}{
		{"empty", ""},
		{"home itself", home},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validatePurgeDir(tc.dir); err == nil {
				t.Errorf("validatePurgeDir(%q) 应拒绝，却放行了", tc.dir)
			}
		})
	}
}

// TABTIN_CONFIG_DIR 允许指向任意自定义目录名（不要求 .tabtin* 前缀）——
// 这是该环境变量本身的既有设计（供用户/测试/CI 隔离），purge 不该更挑剔。
func TestValidatePurgeDirAllowsCustomNamedDir(t *testing.T) {
	tmp := t.TempDir()

	for _, name := range []string{".tabtin", "custom-config-dir", "tabtin-config"} {
		dir := filepath.Join(tmp, name)
		if err := validatePurgeDir(dir); err != nil {
			t.Errorf("validatePurgeDir(%q) 应放行，却拒绝: %v", dir, err)
		}
	}
}
