package knowledgetree

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/transport"
)

func TestParentPatchBody(t *testing.T) {
	root := ParentPatchBody("", true)
	if _, ok := root["parent_id"]; !ok {
		t.Fatal("root body 必须含 parent_id key")
	}
	if root["parent_id"] != nil {
		t.Fatalf("root 应为 null，got %#v", root["parent_id"])
	}

	nested := ParentPatchBody("ctx_1", false)
	if nested["parent_id"] != "ctx_1" {
		t.Fatalf("nested body=%#v", nested)
	}
}

type fakeTransport struct {
	requests []fakeReq
	listResp json.RawMessage
	patchOK  bool
}

type fakeReq struct {
	method string
	path   string
	body   map[string]any
}

func (f *fakeTransport) Request(_ context.Context, method, path string, body map[string]any, _ *transport.RequestOptions) (*transport.Response, error) {
	f.requests = append(f.requests, fakeReq{method: method, path: path, body: body})
	if strings.Contains(path, "/context-items?") {
		return &transport.Response{Status: 200, Data: f.listResp}, nil
	}
	if method == "PATCH" {
		if !f.patchOK {
			return &transport.Response{Status: 400, Data: json.RawMessage(`{"success":false}`)}, nil
		}
		return &transport.Response{Status: 200, Data: json.RawMessage(`{"success":true,"data":{"id":"item-1","parent_id":"ctx_p"}}`)}, nil
	}
	return &transport.Response{Status: 404, Data: json.RawMessage(`{}`)}, nil
}
func (f *fakeTransport) Type() string { return "fake" }
func (f *fakeTransport) Close() error { return nil }

func TestResolveAndPatchParent(t *testing.T) {
	// 模拟 Electron CLI Server 双层信封
	list := map[string]any{
		"ok": true,
		"data": map[string]any{
			"ok": true,
			"data": map[string]any{
				"items": []any{
					map[string]any{"id": "ctx-doc-1", "resource_id": "doc-aaa"},
					map[string]any{"id": "ctx-tbl-1", "resource_id": "tbl-bbb"},
				},
				"total":     2,
				"page":      1,
				"page_size": 100,
			},
		},
	}
	raw, _ := json.Marshal(list)
	tr := &fakeTransport{listResp: raw, patchOK: true}

	id, err := ResolveItemIDByResource(context.Background(), tr, "org-1", "tabdoc", "doc-aaa")
	if err != nil || id != "ctx-doc-1" {
		t.Fatalf("resolve doc: id=%q err=%v", id, err)
	}

	resp, err := PatchParent(context.Background(), tr, id, "ctx_parent", false)
	if err != nil || resp.Status != 200 {
		t.Fatalf("patch: status=%v err=%v", resp, err)
	}
	last := tr.requests[len(tr.requests)-1]
	if last.method != "PATCH" || !strings.Contains(last.path, "/api/context/context-items/ctx-doc-1") {
		t.Fatalf("last req=%#v", last)
	}
	if last.body["parent_id"] != "ctx_parent" {
		t.Fatalf("body=%#v", last.body)
	}

	_, err = PatchParent(context.Background(), tr, id, "", true)
	if err != nil {
		t.Fatal(err)
	}
	last = tr.requests[len(tr.requests)-1]
	if last.body["parent_id"] != nil {
		t.Fatalf("root body=%#v", last.body)
	}
}

func TestPatchParentRequiresExactlyOneTarget(t *testing.T) {
	tr := &fakeTransport{patchOK: true}
	if _, err := PatchParent(context.Background(), tr, "x", "", false); err == nil {
		t.Fatal("expected error when neither parent nor root")
	}
	if _, err := PatchParent(context.Background(), tr, "x", "p", true); err == nil {
		t.Fatal("expected error when both parent and root")
	}
}
