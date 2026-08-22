package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/output"
)

// TestDoctorReport_WorstExit 锁定 doctor 退出码契约：worstExit 取所有 ❌ 中
// 最严重一项（数值越大越严重），✅/⚠️ 不抬退出码。harness preflight 直接 gate
// 这个码，回归会让「全绿却非零」或「有故障却 0」漏过去。
func TestDoctorReport_WorstExit(t *testing.T) {
	tests := []struct {
		name string
		run  func(r *doctorReport)
		want int
	}{
		{
			name: "全通过 → 0",
			run: func(r *doctorReport) {
				r.ok("config", "x")
				r.ok("transport", "x")
				r.ok("cli_server", "x")
			},
			want: output.ExitOK,
		},
		{
			name: "仅 ⚠️ 不计失败 → 0",
			run: func(r *doctorReport) {
				r.ok("config", "x")
				r.warn("cli_server", "status 503")
				r.warn("backend", "status 502")
			},
			want: output.ExitOK,
		},
		{
			name: "仅 auth ❌ → 3",
			run: func(r *doctorReport) {
				r.ok("backend", "x")
				r.fail("auth", "expired", output.ExitAuth)
			},
			want: output.ExitAuth,
		},
		{
			name: "config(1)+cli_server(8) 取最严重 → 8",
			run: func(r *doctorReport) {
				r.fail("config", "bad", output.ExitGeneral)
				r.fail("cli_server", "down", output.ExitServiceUnavail)
			},
			want: output.ExitServiceUnavail,
		},
		{
			name: "顺序无关：先 8 后 1 仍 → 8",
			run: func(r *doctorReport) {
				r.fail("cli_server", "down", output.ExitServiceUnavail)
				r.fail("config", "bad", output.ExitGeneral)
			},
			want: output.ExitServiceUnavail,
		},
		{
			name: "backend(6) 高于 auth(3) → 6",
			run: func(r *doctorReport) {
				r.fail("auth", "expired", output.ExitAuth)
				r.fail("backend", "unreachable", output.ExitNetwork)
			},
			want: output.ExitNetwork,
		},
		{
			name: "permission(4) 高于 auth(3)、低于 network(6) → 6",
			run: func(r *doctorReport) {
				r.fail("auth", "403", output.ExitPermission)
				r.fail("backend", "unreachable", output.ExitNetwork)
			},
			want: output.ExitNetwork,
		},
		{
			name: "permission(4) 高于 auth(3) → 4",
			run: func(r *doctorReport) {
				r.fail("auth", "expired", output.ExitAuth)
				r.fail("auth", "403", output.ExitPermission)
			},
			want: output.ExitPermission,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rep := &doctorReport{worstExit: output.ExitOK}
			tt.run(rep)
			if rep.worstExit != tt.want {
				t.Errorf("worstExit = %d, want %d", rep.worstExit, tt.want)
			}
		})
	}
}

// TestDoctorReport_Degraded 锁定 D-1：条件性降级项默认 ⚠️ 退 0，--strict 才升 ❌ 计退出码。
// 这是「直连模式对 RouteDirect 用户正常、对 RouteCliServer harness 阻断」的关键开关。
func TestDoctorReport_Degraded(t *testing.T) {
	t.Run("非 strict：degraded → ⚠️ 不计退出码", func(t *testing.T) {
		rep := &doctorReport{worstExit: output.ExitOK, strict: false}
		rep.degraded("cli_server", "直连模式", output.ExitServiceUnavail)
		if rep.worstExit != output.ExitOK {
			t.Errorf("非 strict 下 degraded 不应抬退出码，worstExit=%d", rep.worstExit)
		}
		if got := rep.results[0]["status"]; got != "⚠️" {
			t.Errorf("非 strict 下 degraded 应记 ⚠️，得到 %q", got)
		}
	})
	t.Run("strict：degraded → ❌ 计退出码", func(t *testing.T) {
		rep := &doctorReport{worstExit: output.ExitOK, strict: true}
		rep.degraded("cli_server", "直连模式", output.ExitServiceUnavail)
		if rep.worstExit != output.ExitServiceUnavail {
			t.Errorf("strict 下 degraded 应抬到 %d，得到 %d", output.ExitServiceUnavail, rep.worstExit)
		}
		if got := rep.results[0]["status"]; got != "❌" {
			t.Errorf("strict 下 degraded 应记 ❌，得到 %q", got)
		}
	})
}

// TestDoctorSeverityRank_AllUsedCodesRegistered 守护「doctor 实际 fail 用到的退出码
// 必须在 doctorSeverityRank 里登记」。漏登记 → rank 为 0 → fail 不抬退出码 → ❌ 却退 0
// 的静默盲区。新增 doctor fail 档位时，把码加进这里即可同时被强约束。
func TestDoctorSeverityRank_AllUsedCodesRegistered(t *testing.T) {
	usedByDoctor := []int{
		output.ExitGeneral,
		output.ExitAuth,
		output.ExitPermission,
		output.ExitNetwork,
		output.ExitServiceUnavail,
	}
	for _, code := range usedByDoctor {
		if doctorSeverityRank[code] == 0 {
			t.Errorf("退出码 %d 被 doctor 使用但未在 doctorSeverityRank 登记（rank=0 会导致 ❌ 不抬退出码）", code)
		}
	}
}

// TestDoctorReport_FailRecordsRow 确认 fail/ok/warn 都把行写进 results，
// 且 status 标记正确——doctor JSON 输出消费方（preflight 脚本）按 status 字段判定。
func TestDoctorReport_FailRecordsRow(t *testing.T) {
	rep := &doctorReport{worstExit: output.ExitOK}
	rep.ok("config", "ok-detail")
	rep.warn("cli_server", "warn-detail")
	rep.fail("backend", "fail-detail", output.ExitNetwork)

	if len(rep.results) != 3 {
		t.Fatalf("results len = %d, want 3", len(rep.results))
	}
	wantStatus := []string{"✅", "⚠️", "❌"}
	for i, want := range wantStatus {
		if got := rep.results[i]["status"]; got != want {
			t.Errorf("results[%d] status = %q, want %q", i, got, want)
		}
	}
}

func TestShouldSkipStartupTransportDiscovery(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "browser doctor", args: []string{"browser", "doctor"}, want: true},
		{name: "global format before browser doctor", args: []string{"--format", "json", "browser", "doctor"}, want: true},
		{name: "global format equals before browser doctor", args: []string{"--format=json", "browser", "doctor"}, want: true},
		{name: "browser doctor local flags", args: []string{"browser", "doctor", "--strict", "--fix"}, want: true},
		{name: "browser capabilities still discovers dynamic commands", args: []string{"browser", "capabilities"}, want: false},
		{name: "root doctor unchanged", args: []string{"doctor"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldSkipStartupTransportDiscovery(tt.args); got != tt.want {
				t.Fatalf("shouldSkipStartupTransportDiscovery(%v) = %v, want %v", tt.args, got, tt.want)
			}
		})
	}
}

func TestBrowserDoctorExecuteDoesNotStartupCleanDiscovery(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", tmp)
	stalePath := filepath.Join(tmp, "daemon-server.json")
	if err := os.WriteFile(stalePath, []byte(`{"sock":"/tmp/missing.sock","token":"tok","pid":999999}`), 0o600); err != nil {
		t.Fatal(err)
	}

	oldArgs := os.Args
	os.Args = []string{"tabtin", "browser", "doctor", "--format", "json"}
	defer func() { os.Args = oldArgs }()

	if code := Execute(); code != output.ExitOK {
		t.Fatalf("browser doctor default should exit 0, got %d", code)
	}
	if _, err := os.Stat(stalePath); err != nil {
		t.Fatalf("browser doctor startup must not auto-clean discovery before --fix, stat err=%v", err)
	}
}
