package table

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestAdaptTableList(t *testing.T) {
	method, path, body, err := AdaptTableList(nil, "POST", "/table/list", map[string]any{
		"organization_id": "org_1",
		"page":            2,
		"search":          "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "GET" {
		t.Fatalf("method=%s", method)
	}
	if body != nil {
		t.Fatalf("body should be nil for GET, got %#v", body)
	}
	if !strings.HasPrefix(path, "/api/tabdata/organizations/org_1/tables?") {
		t.Fatalf("path=%s", path)
	}
	if !strings.Contains(path, "page=2") || !strings.Contains(path, "search=hello") {
		t.Fatalf("query missing: %s", path)
	}
}

func TestAdaptTableCreate(t *testing.T) {
	method, path, body, err := adaptTableCreate(nil, "POST", "/table/create", map[string]any{
		"organization_id":    "org_1",
		"name":               "T",
		"use_default_fields": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/api/tabdata/organizations/org_1/tables" {
		t.Fatalf("method=%s path=%s", method, path)
	}
	if body["name"] != "T" {
		t.Fatalf("body=%#v", body)
	}
	if _, has := body["space_id"]; has {
		t.Fatalf("create body must not include space_id: %#v", body)
	}
	if _, has := body["parent_item_id"]; has {
		t.Fatalf("根级 create 不应带 parent_item_id: %#v", body)
	}
}

func TestAdaptTableCreateParentItemID(t *testing.T) {
	_, _, body, err := adaptTableCreate(nil, "POST", "/table/create", map[string]any{
		"organization_id": "org_1",
		"name":            "子表",
		"parent_item_id":  "ctx_parent_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["parent_item_id"] != "ctx_parent_1" {
		t.Fatalf("应透传 parent_item_id，got %#v", body)
	}
}

func TestAdaptRecordInsert(t *testing.T) {
	method, path, body, err := adaptRecordInsert(&cmdutil.RunContext{}, "POST", "/table/insert", map[string]any{
		"table_id": "tbl_1",
		"data":     `{"name":"a"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/api/tabdata/records" {
		t.Fatalf("method=%s path=%s", method, path)
	}
	data, ok := body["data"].(map[string]any)
	if !ok || data["name"] != "a" {
		t.Fatalf("body=%#v", body)
	}

	// @file / pipeline 已解成 map 时不能走 fmt %v
	_, _, body2, err := adaptRecordInsert(&cmdutil.RunContext{}, "POST", "/table/insert", map[string]any{
		"table_id": "tbl_1",
		"data":     map[string]any{"标题": "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}
	data2, ok := body2["data"].(map[string]any)
	if !ok || data2["标题"] != "hello" {
		t.Fatalf("body2=%#v", body2)
	}
}

func TestAdaptTableListMissingOrg(t *testing.T) {
	_, _, _, err := AdaptTableList(nil, "POST", "/table/list", map[string]any{
		"space_id": "spc_1",
	})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestAdaptFieldAddRejectsTypesNotAvailableInUI(t *testing.T) {
	_, _, _, err := adaptFieldAdd(nil, "POST", "/table/add-field", map[string]any{
		"table_id":   "tbl_1",
		"name":       "创建时间",
		"field_type": "created_time",
	})
	if err == nil {
		t.Fatal("expected UI-unavailable field type to be rejected")
	}

	method, path, body, err := adaptFieldAdd(nil, "POST", "/table/add-field", map[string]any{
		"table_id":   "tbl_1",
		"name":       "评分",
		"field_type": "rating",
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/api/tabdata/fields" || body["field_type"] != "rating" {
		t.Fatalf("unexpected adapted field request: method=%s path=%s body=%#v", method, path, body)
	}
}
