package browser

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestBrowserDoctorNoRuntimeStillReportsStaticHealth(t *testing.T) {
	env := newBrowserDoctorTestEnv(t)
	report := runBrowserDoctor(t.Context(), env, browserDoctorOptions{})

	if report.SchemaVersion != 1 {
		t.Fatalf("schemaVersion = %d, want 1", report.SchemaVersion)
	}
	if report.OverallStatus != browserDoctorStatusWarn {
		t.Fatalf("overall = %q, want warn; report=%+v", report.OverallStatus, report)
	}
	if report.Summary.Failures != 0 {
		t.Fatalf("failures = %d, want 0", report.Summary.Failures)
	}
	assertDoctorCheck(t, report, "capabilities.contract", browserDoctorStatusOK)
	assertDoctorCheck(t, report, "patchright.dependency", browserDoctorStatusWarn)
	assertDoctorCheck(t, report, "cli.selection", browserDoctorStatusWarn)
}

func TestBrowserDoctorSelectsElectronBeforeDaemon(t *testing.T) {
	env := newBrowserDoctorTestEnv(t)
	writeDiscovery(t, env.configDir(), "server.json", browserDoctorDiscovery{Sock: filepath.Join(env.homeDir(), "electron.sock"), Token: "e", PID: 101, Source: "electron"})
	writeDiscovery(t, env.configDir(), "daemon-server.json", browserDoctorDiscovery{Sock: filepath.Join(env.homeDir(), "daemon.sock"), Token: "d", PID: 202, Source: "daemon"})
	touch(t, filepath.Join(env.homeDir(), "electron.sock"))
	touch(t, filepath.Join(env.homeDir(), "daemon.sock"))
	env.pidAlive = func(pid int) bool { return pid == 101 || pid == 202 }

	report := runBrowserDoctor(t.Context(), env, browserDoctorOptions{})
	check := assertDoctorCheck(t, report, "cli.selection", browserDoctorStatusOK)
	if got := check.Detail["runtime"]; got != "electron" {
		t.Fatalf("selected runtime = %v, want electron", got)
	}
}

func TestBrowserDoctorFixRemovesStaleDiscoveryOnly(t *testing.T) {
	env := newBrowserDoctorTestEnv(t)
	stalePath := filepath.Join(env.configDir(), "daemon-server.json")
	writeDiscovery(t, env.configDir(), "daemon-server.json", browserDoctorDiscovery{Sock: filepath.Join(env.homeDir(), "missing.sock"), Token: "d", PID: 404, Source: "daemon"})
	env.pidAlive = func(pid int) bool { return false }

	report := runBrowserDoctor(t.Context(), env, browserDoctorOptions{Fix: true})
	if _, err := os.Stat(stalePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale discovery should be removed, stat err=%v", err)
	}
	if len(report.Fixes) == 0 || report.Fixes[0].Status != "applied" {
		t.Fatalf("expected applied fix, got %+v", report.Fixes)
	}
}

func TestBrowserDoctorFixDoesNotRemoveLivePidMissingSocket(t *testing.T) {
	env := newBrowserDoctorTestEnv(t)
	path := filepath.Join(env.configDir(), "daemon-server.json")
	writeDiscovery(t, env.configDir(), "daemon-server.json", browserDoctorDiscovery{Sock: filepath.Join(env.homeDir(), "missing.sock"), Token: "d", PID: 202, Source: "daemon"})
	env.pidAlive = func(pid int) bool { return pid == 202 }

	report := runBrowserDoctor(t.Context(), env, browserDoctorOptions{Fix: true})
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("live-pid discovery with missing socket must not be auto removed, stat err=%v", err)
	}
	if len(report.Fixes) != 1 || report.Fixes[0].ID != "fix.none" {
		t.Fatalf("expected no safe fix, got %+v", report.Fixes)
	}
}

func TestBrowserDoctorStrictExitDecision(t *testing.T) {
	report := browserDoctorReport{Summary: browserDoctorSummary{Failures: 1}}
	if !browserDoctorShouldExitNonZero(report, browserDoctorOptions{Strict: true}) {
		t.Fatal("strict + failures should return non-zero")
	}
	if browserDoctorShouldExitNonZero(report, browserDoctorOptions{Strict: false}) {
		t.Fatal("non-strict + failures should stay exit 0")
	}
}

func TestBrowserDoctorCapabilitiesExpectedCount(t *testing.T) {
	env := newBrowserDoctorTestEnv(t)
	report := runBrowserDoctor(t.Context(), env, browserDoctorOptions{})
	check := assertDoctorCheck(t, report, "capabilities.contract", browserDoctorStatusOK)
	if got := check.Detail["expectedActionCount"]; got != float64(browserDoctorExpectedActionCount) && got != browserDoctorExpectedActionCount {
		t.Fatalf("expectedActionCount detail = %v, want %d", got, browserDoctorExpectedActionCount)
	}
	if got := check.Detail["actualActionCount"]; got != float64(browserDoctorExpectedActionCount) && got != browserDoctorExpectedActionCount {
		t.Fatalf("actualActionCount detail = %v, want %d", got, browserDoctorExpectedActionCount)
	}
}

func TestBrowserDoctorCommandIsDiagnosticNotAction(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	found := false
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		rel := browserRelativePath(leaf)
		if rel != "doctor" {
			continue
		}
		found = true
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatal("doctor command missing CommandDef")
		}
		if def.Path != "" || def.Method != "" {
			t.Fatalf("doctor must stay local-only, method=%q path=%q", def.Method, def.Path)
		}
	}
	if !found {
		t.Fatal("browser doctor command not registered")
	}
}

func newBrowserDoctorTestEnv(t *testing.T) browserDoctorEnv {
	t.Helper()
	tmp := t.TempDir()
	configDir := filepath.Join(tmp, ".tabtin")
	home := filepath.Join(tmp, "home")
	repo := filepath.Join(tmp, "repo")
	mkdir(t, configDir)
	mkdir(t, home)
	mkdir(t, filepath.Join(repo, "packages", "browser-core", "src", "generated"))
	mkdir(t, filepath.Join(repo, "apps", "tabtin-daemon"))
	writeFile(t, filepath.Join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
	writeFile(t, filepath.Join(repo, "packages", "browser-core", "src", "generated", "browser-cli-contract.json"), `{
  "schemaVersion": 1,
  "commands": [
    {"id": "context", "selfDescribe": true},
    {"id": "capabilities", "selfDescribe": true},
    {"id": "doctor", "diagnostic": true},
    {"id": "open"},
    {"id": "tab.list"},
    {"id": "snapshot"},
    {"id": "extract"},
    {"id": "markdown"},
    {"id": "network"},
    {"id": "console"},
    {"id": "route"},
    {"id": "job.status"},
    {"id": "job.cancel"},
    {"id": "cookies.get"},
    {"id": "cookies.set"},
    {"id": "cookies.clear"},
    {"id": "record.start"},
    {"id": "replay.run"},
    {"id": "session.list"},
    {"id": "resource.list"},
    {"id": "stream.parse"},
    {"id": "pdf"},
    {"id": "wait"},
    {"id": "observe"},
    {"id": "eval"},
    {"id": "act"},
    {"id": "capture"},
    {"id": "screenshot"},
    {"id": "nav"},
    {"id": "batch"},
    {"id": "clear-session"},
    {"id": "random-ua"},
    {"id": "tab.switch"},
    {"id": "tab.close"},
    {"id": "tab.state"},
    {"id": "resource.inspect"},
    {"id": "resource.capture"},
    {"id": "resource.download"},
    {"id": "resource.probe"},
    {"id": "resource.smart-download"},
    {"id": "stream.download"},
    {"id": "stream.info"},
    {"id": "session.create"},
    {"id": "session.switch"},
    {"id": "session.close"},
    {"id": "session.close-all"},
    {"id": "session.save"},
    {"id": "session.load"},
    {"id": "record.stop"},
    {"id": "record.status"},
    {"id": "replay.list"},
    {"id": "route-list"},
    {"id": "unroute"}
  ]
}`)
	writeFile(t, filepath.Join(repo, "apps", "tabtin-daemon", "package.json"), `{"dependencies":{"patchright-core":"1.58.2"}}`)
	return browserDoctorEnv{
		now:       func() time.Time { return time.Date(2026, 6, 10, 11, 35, 0, 0, time.UTC) },
		configDir: func() string { return configDir },
		homeDir:   func() string { return home },
		repoRoot:  func() string { return repo },
		pidAlive:  func(pid int) bool { return false },
		dialUnix: func(string, time.Duration) (net.Conn, error) {
			return nil, errors.New("not used in unit tests")
		},
		remove:   os.Remove,
		stat:     os.Stat,
		readFile: os.ReadFile,
	}
}

func assertDoctorCheck(t *testing.T, report browserDoctorReport, id string, status string) browserDoctorCheck {
	t.Helper()
	for _, check := range report.Checks {
		if check.ID == id {
			if check.Status != status {
				t.Fatalf("check %s status = %q, want %q; check=%+v", id, check.Status, status, check)
			}
			return check
		}
	}
	t.Fatalf("missing check %s in %+v", id, report.Checks)
	return browserDoctorCheck{}
}

func writeDiscovery(t *testing.T, dir, name string, d browserDoctorDiscovery) {
	t.Helper()
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, name), string(raw))
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func touch(t *testing.T, path string) {
	t.Helper()
	writeFile(t, path, "")
}
