// cookies_action_test.go — BR-1 回归护栏：cookies get/set/clear 必须各自钦定 action。
//
// 三命令共用 POST /browser/cookies，靠 FixedFields["action"] 区分。漏发 action 会在
// Electron 上 400、在 Daemon 上静默退化成 get（BR-1 根因）。本测试把「每条命令带对
// 应 action」钉死，防止 FixedFields 被误删后双端又静默漂移。
package browser

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestCookiesCommandsCarryFixedAction(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	want := map[string]string{
		"cookies get":   "get",
		"cookies set":   "set",
		"cookies clear": "clear",
	}

	seen := map[string]bool{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		rel := browserRelativePath(leaf)
		expected, ok := want[rel]
		if !ok {
			continue
		}
		seen[rel] = true

		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatalf("命令 %q 无 CommandDef", rel)
		}
		if def.Path != "/browser/cookies" {
			t.Errorf("命令 %q Path=%q, want /browser/cookies", rel, def.Path)
		}
		got, present := def.FixedFields["action"]
		if !present {
			t.Errorf("命令 %q 缺 FixedFields[\"action\"]（会导致双端 400 / 静默退化）", rel)
			continue
		}
		if got != expected {
			t.Errorf("命令 %q FixedFields[\"action\"]=%v, want %q", rel, got, expected)
		}
	}

	for rel := range want {
		if !seen[rel] {
			t.Errorf("未在 browser 命令树中找到 %q（命令改名或注册失败？）", rel)
		}
	}
}
