// share_test.go — `table share` 命令注册期 invariant +  critical fix 回归测试。
//
//  spec review 抓到的 critical bug：`table share off --share-type organization`
// 在真实环境里被静默当成关闭 data 分享——根因是 CLI 声明式管线（pipeline.go）只对
// GET 做 body→query 转换，DELETE 的 --share-type 走 JSON body 发送，而 Django Ninja
// 对 close_data_share 裸 str 形参默认按 query 绑定，两边错位。修复落在后端
// apps/tabtin_django/apps/tabdata/api_share.py 的 _share_type_from_request
// （镜像  已验证过的 doc share off 方案：优先读 body，查不到再退回 query），
// CLI 侧不需要改管线；本文件的测试覆盖：
//  1. off 的真实请求体（buildRequestBody 的等价路径——本命令用 DryRun 手工构造，
//     与 pipeline 走的 flag→body 编码规则一致）在传 --share-type 时确实带上了
//     share_type 字段，证明"CLI 发出去的东西是后端 fallback 能读到的"。
//  2. 父级 help 不再错误宣称 off 是"软删"。
//  3. set 的 --acknowledge-public-exposure 会发给后端（非 CliOnly），且本地
//     Validate 门禁仍在（镜像 apps_doc_test.go）。
package table

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestTableShareParentHelpDescribesPhysicalDelete 断言父级 help 不再误导 off 是软删，
// 且明确说明"物理删除 / 可重开靠 set"（spec review Important 项）。
func TestTableShareParentHelpDescribesPhysicalDelete(t *testing.T) {
	newTestTableCmd(t)
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	shareCmd, _, err := cmd.Find([]string{"share"})
	if err != nil || shareCmd == nil {
		t.Fatalf("table share 命令不存在: err=%v", err)
	}
	if strings.Contains(shareCmd.Long, "软删") {
		t.Fatalf("table share 父级 help 不应再说 off 是软删（close_data_share 是真删），got: %s", shareCmd.Long)
	}
	if !strings.Contains(shareCmd.Long, "物理删除") {
		t.Fatalf("table share 父级 help 应说明 off 是物理删除分享记录，got: %s", shareCmd.Long)
	}
}

// TestTableShareSetRequiresPublicExposureAckFlag 镜像 apps_doc_test.go 的
// TestDocShareSetRequiresPublicExposureAckFlag：断言 --acknowledge-public-exposure
// 存在且为 FlagBool，且 Long 说明了它的门禁语义。
func TestTableShareSetRequiresPublicExposureAckFlag(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	setCmd, _, err := cmd.Find([]string{"share", "set"})
	if err != nil || setCmd == nil {
		t.Fatalf("table share set 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(setCmd)
	if def == nil {
		t.Fatal("table share set 无 CommandDef")
	}
	found := false
	for _, fl := range def.Flags {
		if fl.Name == "acknowledge-public-exposure" {
			found = true
			if fl.Type != cmdutil.FlagBool {
				t.Fatalf("acknowledge-public-exposure 应为 FlagBool，got %v", fl.Type)
			}
			if fl.CliOnly {
				t.Fatalf("acknowledge-public-exposure 不应再是 CliOnly（后端已强制 acknowledge_public_exposure）")
			}
		}
	}
	if !found {
		t.Fatal("table share set 缺少 --acknowledge-public-exposure")
	}
	if !strings.Contains(def.Long, "PUBLIC_EXPOSURE_ACK_REQUIRED") {
		t.Fatalf("table share set Long 应说明 409 PUBLIC_EXPOSURE_ACK_REQUIRED，got: %s", def.Long)
	}
}

// TestTableShareSetValidateEnforcesAckForDataShareType 直接调用 Validate 钩子，
// 验证 share-type=data 缺 ack 时本地拒绝、带 ack 时放行、organization 不受影响。
func TestTableShareSetValidateEnforcesAckForDataShareType(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	setCmd, _, err := cmd.Find([]string{"share", "set"})
	if err != nil || setCmd == nil {
		t.Fatalf("table share set 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(setCmd)
	if def == nil || def.Validate == nil {
		t.Fatal("table share set 缺少 Validate 钩子")
	}

	cases := []struct {
		name      string
		flagVals  map[string]any
		wantError bool
	}{
		{"data 缺 ack 应拒绝", map[string]any{"share-type": "data"}, true},
		{"data 带 ack 应放行", map[string]any{"share-type": "data", "acknowledge-public-exposure": true}, false},
		{"organization 不需要 ack", map[string]any{"share-type": "organization"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := &cmdutil.RunContext{FlagValues: tc.flagVals}
			err := def.Validate(ctx)
			if tc.wantError && err == nil {
				t.Fatalf("期望报错，实际 nil")
			}
			if !tc.wantError && err != nil {
				t.Fatalf("期望放行，实际报错: %v", err)
			}
		})
	}
}

// TestTableShareOffDeleteBodyCarriesShareType 是  critical bug 的回归测试：
// 断言 off 命令实际会把 --share-type 放进 DELETE 请求体（DryRun 手工构造的 body
// 与真实执行路径走的 flag→body 编码规则一致，见 share.go off 的 DryRun 钩子）。
//
// 这条测试只能证明"CLI 发出去的 body 里有 share_type"——它不能替代后端修复的验证：
// 真正的 bug 是 Django Ninja 端把 close_data_share 的裸 str 形参按 query 绑定，
// 而不是 CLI 没发。后端修复（_share_type_from_request 优先读 body）+ 对应
// Django 回归测试见 apps/tabtin_django/apps/tabdata/api_share.py 与
// apps/tabtin_django/apps/tabdata/tests/test_share_service_e2e.py 的
// CloseDataShareBodyShareTypeTests。
func TestTableShareOffDeleteBodyCarriesShareType(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	offCmd, _, err := cmd.Find([]string{"share", "off"})
	if err != nil || offCmd == nil {
		t.Fatalf("table share off 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(offCmd)
	if def == nil {
		t.Fatal("table share off 无 CommandDef")
	}
	if def.Method != "DELETE" {
		t.Fatalf("table share off 应为 DELETE，got %s", def.Method)
	}
	if def.DryRun == nil {
		t.Fatal("table share off 缺少 DryRun 钩子")
	}

	ctx := &cmdutil.RunContext{
		Args:       []string{"tbl_xxx"},
		FlagValues: map[string]any{"share-type": "organization"},
	}
	plan := def.DryRun(ctx)
	if plan == nil || len(plan.Plan) == 0 {
		t.Fatal("off DryRun 应返回至少一步计划")
	}
	step := plan.Plan[0]
	if step.Method != "DELETE" {
		t.Fatalf("off DryRun 第一步应为 DELETE，got %s", step.Method)
	}
	body, ok := step.Body.(map[string]any)
	if !ok {
		t.Fatalf("off DryRun body 应为 map[string]any，got %T", step.Body)
	}
	if got := body["share_type"]; got != "organization" {
		t.Fatalf("off DryRun body 应带 share_type=organization（DELETE 请求体，非 query），got %v", got)
	}
}
