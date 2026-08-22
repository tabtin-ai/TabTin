// table_spec_test.go — TabData CLI 规范化迁移（GitHub ）注册期 invariant。
//
// 背景：table 命令组历史上整体走已废弃的 cmdutil.RegisterCommand 注册，绕过了
// MustRegisterCommand 的注册期断言（Layer/Risk/RiskDeclared/Long≥3/Example≥3/
// 写命令必须有 DryRun）。#3129 按子组分批迁移到 MustRegisterCommand，本次收口
// 覆盖全部 112 条命令。本文件把「后续 PR 悄悄改回 RegisterCommand，或漏填某个
// 字段」这类回归提前到 `go test`，不依赖跑 ./dist/tabtin --help 才能发现。
package table

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestTableAllLeavesRiskDeclared 断言 table 命令树全部叶子命令都设了
// RiskDeclared:true + 合法 Layer——防止漏填导致 MustRegisterCommand 注册期 panic
// 只能靠实跑二进制才暴露，也钉死"全组已收口，不再有遗漏子组"这个不变式。
func TestTableAllLeavesRiskDeclared(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	leaves := walkLeafTableCommands(cmd)
	checked := 0
	for _, leaf := range leaves {
		rel := tableRelativePath(leaf)
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Errorf("命令 %q 无关联 CommandDef", rel)
			continue
		}
		checked++
		if !def.RiskDeclared {
			t.Errorf("命令 %q 缺 RiskDeclared:true", rel)
		}
		if def.Layer != "L1" && def.Layer != "L2" && def.Layer != "L3" {
			t.Errorf("命令 %q Layer=%q，必须是 L1/L2/L3", rel, def.Layer)
		}
	}
	if checked < 100 {
		t.Fatalf("检查到的叶子命令数=%d，明显少于预期（table 组应有 100+ 条命令），"+
			"命令树遍历可能有误", checked)
	}
}

// TestTableAllWritesHaveDryRun 断言 table 命令树全部写命令（Risk != RiskRead）
// 都声明了 DryRun 钩子——cli-spec 铁律「能 dry-run 才能写」的 unit test 镜像，
// 避免 Agent 传 --dry-run 撞 NOT_IMPLEMENTED。
func TestTableAllWritesHaveDryRun(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	for _, leaf := range walkLeafTableCommands(cmd) {
		rel := tableRelativePath(leaf)
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			continue
		}
		if def.Risk != cmdutil.RiskRead && def.DryRun == nil {
			t.Errorf("写命令 %q（Risk=%q）缺 DryRun 钩子", rel, def.Risk)
		}
	}
}

// TestTableAllLeavesMounted 断言全部预期命令仍挂在 cobra 树上——抓 refactor
// 误删 / 挂错父节点。清单按子组分区，新增子组请在此追加。
func TestTableAllLeavesMounted(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	expected := []string{
		// 顶层生命周期 + SQL + 搜索（含  move）
		"list", "create", "move", "info", "update", "delete", "archive", "restore", "stats",
		"query", "execute", "search",
		// trash
		"trash list", "trash restore", "trash permanent",
		// record
		"record list", "record detail", "record insert", "record update",
		"record delete", "record upsert", "record bulk-insert", "record reorder",
		"record history", "record undo", "record redo",
		// field
		"field list", "field detail", "field add", "field update", "field delete",
		"field reorder", "field check", "field preview", "field convert", "field bulk-add",
		"field explain", "field delete-references", "field conversion-references",
		// view
		"view list", "view detail", "view create", "view update", "view delete",
		"view records", "view set-default", "view reorder", "view statistics",
		"view form-share-enable", "view form-share-disable", "view form-share-rotate",
		// link
		"link create", "link update", "link set", "link add", "link remove", "link list",
		"link linkable-records", "link linkable-fields", "link populate-choices",
		// form
		"form get", "form verify", "form submit", "form submit-direct",
		"form link-records", "form collaborators",
		// sub-record
		"sub-record create", "sub-record move", "sub-record parent-field",
		"sub-record ensure-parent-field", "sub-record self-link-fields", "sub-record reorder-tree",
		// policy
		"policy list", "policy create", "policy update", "policy delete", "policy rls-toggle",
		// search-index
		"search-index status", "search-index toggle", "search-index repair", "search-index query",
		// collaborator
		"collaborator list", "collaborator invite", "collaborator update", "collaborator remove",
		// share（数据分享，非表单分享；#7778 W2c）
		"share set", "share get", "share off", "share shared-with-me",
		// attachment
		"attachment list", "attachment reuse", "attachment delete",
		// webhook
		"webhook list", "webhook create", "webhook update", "webhook delete", "webhook test",
		// version
		"version list", "version create", "version rename", "version delete",
		// history
		"history list", "history snapshot", "history restore", "history undo",
		"history redo", "history undo-stack", "history redo-stack",
		// import
		"import csv", "import json", "import excel", "import preview",
		"import snapshot", "import template",
		// export
		"export csv", "export json", "export excel", "export pdf", "export snapshot",
		// token
		"token list", "token create", "token update", "token delete",
		"token regenerate", "token detail", "token scopes",
	}
	for _, path := range expected {
		parts := strings.Split(path, " ")
		found, _, err := cmd.Find(parts)
		if err != nil || found == nil {
			t.Errorf("命令 %q 未挂到 cobra 树上: err=%v", path, err)
		}
	}
}

// TestTableCreateParentItemID · ：知识库树父节点 flag + dry-run body。
func TestTableCreateParentItemID(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	createCmd, _, err := cmd.Find([]string{"create"})
	if err != nil || createCmd == nil {
		t.Fatalf("table create 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(createCmd)
	if def == nil || def.DryRun == nil {
		t.Fatal("table create 缺 CommandDef / DryRun")
	}
	flags := map[string]bool{}
	for _, f := range def.Flags {
		flags[f.Name] = true
	}
	if !flags["parent-item-id"] {
		t.Fatalf("table create 应暴露 --parent-item-id，flags=%v", flags)
	}

	plan := def.DryRun(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"name":               "子表",
			"parent-item-id":     "ctx_parent_1",
			"use-default-fields": false,
		},
	})
	body, ok := plan.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("dry-run body 类型异常: %#v", plan.Plan[0].Body)
	}
	if body["parent_item_id"] != "ctx_parent_1" {
		t.Fatalf("dry-run 应携带 parent_item_id，got %#v", body)
	}

	planRoot := def.DryRun(&cmdutil.RunContext{
		FlagValues: map[string]any{"name": "根表"},
	})
	bodyRoot, ok := planRoot.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("root dry-run body 类型异常: %#v", planRoot.Plan[0].Body)
	}
	if _, has := bodyRoot["parent_item_id"]; has {
		t.Fatalf("根级 create 不应带 parent_item_id，got %#v", bodyRoot)
	}
}

// TestTableNoLeafUsesLegacyRegister 断言 table 命令树里没有任何命令还挂着
// cmdutil.RegisterCommand 遗留标记——GetCommandDef 只有走过 RegisterCommand（含
// MustRegisterCommand 内部调用）注册的命令才会有 CommandDef，能拿到 def 本身即
// 说明走了统一注册路径；本测试确认无叶子命令的 CommandDef 缺失（意味着手写
// cobra.Command 绕过了注册）。
func TestTableNoLeafUsesLegacyRegister(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	for _, leaf := range walkLeafTableCommands(cmd) {
		rel := tableRelativePath(leaf)
		if cmdutil.GetCommandDef(leaf) == nil {
			t.Errorf("命令 %q 没有关联 CommandDef——可能绕过了 RegisterCommand/MustRegisterCommand 注册", rel)
		}
	}
}
