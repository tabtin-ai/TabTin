package table

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestQuotedAtFileArgvContract 模拟 PowerShell 对 '@file.json' 去引号后的 argv：
// CLI 收到的值必须是 @path（带 @ 前缀），而不是被 splatting 拆开的数组 / hashtable。
func TestQuotedAtFileArgvContract(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "groups.json")
	content := `[{"field_id":"f56fb0ef-f572-45e9-9f2e-8aec62b8fe5d","direction":"asc"}]`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	// PowerShell 单引号包裹后 argv 里就是 @C:\...\groups.json
	argvValue := "@" + path
	if strings.HasPrefix(argvValue, "@{") {
		t.Fatalf("argv looks like hashtable splat: %q", argvValue)
	}
	if !strings.HasPrefix(argvValue, "@") {
		t.Fatalf("missing @file prefix: %q", argvValue)
	}

	rawPath := strings.TrimPrefix(argvValue, "@")
	got, err := os.ReadFile(rawPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Fatalf("file content mismatch: %q", got)
	}
}

// TestPowerShellQuotedAtFileNotSplatted 在 Windows 上用真实 PowerShell 验证
// --data '@file.json' 不会被当成 splatting，且参数以 @path 形式传到下游。
func TestPowerShellQuotedAtFileNotSplatted(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PowerShell splat 回归仅在 Windows 上跑")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "patch.json")
	if err := os.WriteFile(path, []byte(`{"测试单选":"好吧"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	script := `
$ErrorActionPreference = 'Stop'
$path = $env:TABTIN_PS_TEST_FILE
# 与 Skill / help 推荐写法一致：单引号包住 @file，避免 PowerShell splatting
$arg = '@' + $path
$argsList = @('--data', $arg)
$val = $argsList[1]
if ($val -isnot [string]) { throw "expected string, got $($val.GetType().FullName)" }
if (-not $val.StartsWith('@')) { throw "expected @file prefix, got $val" }
if ($val.StartsWith('@{')) { throw "looks like splat hashtable: $val" }
Write-Output $val
`
	cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
	cmd.Env = append(os.Environ(), "TABTIN_PS_TEST_FILE="+path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("powershell failed: %v\n%s", err, out)
	}
	got := strings.TrimSpace(string(out))
	if !strings.HasPrefix(got, "@") {
		t.Fatalf("missing @ prefix: %q", got)
	}
	if strings.HasPrefix(got, "@{") {
		t.Fatalf("looks like splat: %q", got)
	}
	if !strings.HasSuffix(strings.ToLower(got), strings.ToLower(filepath.Base(path))) {
		t.Fatalf("got %q, expected to end with %s", got, filepath.Base(path))
	}
}
