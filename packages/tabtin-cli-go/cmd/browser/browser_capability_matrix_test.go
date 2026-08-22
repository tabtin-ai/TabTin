// browser_capability_matrix_test.go —— BR-5/6 自描述层的 Go 侧锚点。
//
// 跨语言双锚：
//   - 本测试锁「browser CLI 叶子命令（除 context/capabilities 两个自描述命令外）」
//     == browser action 全集。
//   - TS 侧 `packages/browser-core/src/__tests__/capability-matrix.test.ts` 锁
//     「能力矩阵 == 同一份 browser action 全集」。
//
// 任何人增删一条 browser CLI 命令 → 本 Go 测试红，提醒同步 TS 能力矩阵；
// 反之删矩阵条目 → TS 测试红。两侧各守各自能枚举的那半边，合起来防双端漂移。
package browser

import (
	"sort"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// expectedBrowserActionIDs 与 capability-matrix.ts 的 EXPECTED_ACTION_IDS 一一对应
// （CLI 叶子命令路径里的空格换成点：`tab list` → `tab.list`）。
var expectedBrowserActionIDs = []string{
	// 顶层（12）——命令面重设计：observe/snapshot/capture/screenshot → glance，
	// extract/markdown/pdf → print。
	"open", "home", "act", "glance", "eval", "wait", "print",
	"nav", "network", "network.to-api", "console", "batch",
	"clear-session", "random-ua",
	// tab（4）
	"tab.list", "tab.switch", "tab.close", "tab.state",
	// resource（6）
	"resource.list", "resource.inspect", "resource.capture", "resource.download",
	"resource.probe", "resource.smart-download",
	// stream（3）
	"stream.parse", "stream.download", "stream.info",
	// session（7）
	"session.list", "session.create", "session.switch", "session.close",
	"session.close-all", "session.save", "session.load",
	// cookies（3）
	"cookies.get", "cookies.set", "cookies.clear",
	// record（3）
	"record.start", "record.stop", "record.status",
	// replay（2）
	"replay.run", "replay.list",
	// route（3，BR-2 拦截）
	"route", "route-list", "unroute",
	// job（2，BR-10 长任务异步 + 取消）
	"job.status", "job.cancel",
}

// selfDescribeLeaves 是自描述命令本身（不属于「action 矩阵」，矩阵描述的是它们之外的操作命令）。
var selfDescribeLeaves = map[string]struct{}{
	"context":      {},
	"capabilities": {},
}

var diagnosticLeaves = map[string]struct{}{
	"doctor": {},
}

// TestBrowserCommandLeavesMatchExpected 断言 browser CLI 叶子命令（除自描述命令）
// 恰好等于能力矩阵覆盖的 browser action 全集。
func TestBrowserCommandLeavesMatchExpected(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	got := map[string]bool{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		// cobra 内置（help / completion）无 CommandDef，跳过
		if cmdutil.GetCommandDef(leaf) == nil {
			continue
		}
		rel := browserRelativePath(leaf)
		if _, isSelfDescribe := selfDescribeLeaves[rel]; isSelfDescribe {
			continue
		}
		if _, isDiagnostic := diagnosticLeaves[rel]; isDiagnostic {
			continue
		}
		actionID := strings.ReplaceAll(rel, " ", ".")
		got[actionID] = true
	}

	want := map[string]bool{}
	for _, id := range expectedBrowserActionIDs {
		want[id] = true
	}

	for id := range want {
		if !got[id] {
			t.Errorf("能力矩阵期望的 action %q 没有对应的 browser CLI 叶子命令", id)
		}
	}
	for id := range got {
		if !want[id] {
			t.Errorf("browser CLI 多了一条叶子命令 %q，但能力矩阵没覆盖——请同步 capability-matrix.ts + expectedBrowserActionIDs", id)
		}
	}
	if len(got) != len(want) {
		gotList := make([]string, 0, len(got))
		for id := range got {
			gotList = append(gotList, id)
		}
		sort.Strings(gotList)
		t.Errorf("action 数量不符: got %d, want %d；实际叶子(去自描述)=%v", len(got), len(want), gotList)
	}
}

// TestBrowserSelfDescribeCommandsRegistered 断言两个自描述命令真实注册、可达。
func TestBrowserSelfDescribeCommandsRegistered(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	found := map[string]bool{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		if cmdutil.GetCommandDef(leaf) == nil {
			continue
		}
		found[browserRelativePath(leaf)] = true
	}
	for rel := range selfDescribeLeaves {
		if !found[rel] {
			t.Errorf("自描述命令 %q 未注册到 browser 命令树", rel)
		}
	}
	for rel := range diagnosticLeaves {
		if !found[rel] {
			t.Errorf("诊断命令 %q 未注册到 browser 命令树", rel)
		}
	}
}
