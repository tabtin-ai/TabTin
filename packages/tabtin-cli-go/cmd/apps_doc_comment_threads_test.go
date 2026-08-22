package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

func TestDocCommentFindUniqueText(t *testing.T) {
	start, end, err := docCommentFindUniqueText("前面结论后面", "结论")
	if err != nil {
		t.Fatalf("唯一匹配应成功: %v", err)
	}
	if start != 6 || end != 12 { // UTF-8: "前面" = 6 bytes
		// 用 rune 更稳：重新用 Index 校验
		want := strings.Index("前面结论后面", "结论")
		if start != want || end != want+len("结论") {
			t.Fatalf("offsets want %d:%d got %d:%d", want, want+len("结论"), start, end)
		}
	}

	_, _, err = docCommentFindUniqueText("结论与结论", "结论")
	if err == nil || !strings.Contains(err.Error(), "出现") {
		t.Fatalf("歧义应失败，got %v", err)
	}

	_, _, err = docCommentFindUniqueText("没有这段", "缺席")
	if err == nil || !strings.Contains(err.Error(), "未找到") {
		t.Fatalf("零匹配应失败，got %v", err)
	}

	_, _, err = docCommentFindUniqueText("x", "")
	if err == nil {
		t.Fatal("空 needle 应失败")
	}
}

func TestDocCommentValidateAnchorFlagsConflicts(t *testing.T) {
	// --document 成功路径
	err := docCommentValidateAnchorFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{"document": true},
	}, false)
	if err != nil {
		t.Fatalf("--document 应通过: %v", err)
	}

	// 跨块缺 end
	err = docCommentValidateAnchorFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"start-block-id": "blk_a",
		},
	}, false)
	if err == nil {
		t.Fatal("缺 end-block-id 应失败")
	}

	// 跨块缺 offset
	err = docCommentValidateAnchorFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"start-block-id": "blk_a",
			"end-block-id":   "blk_b",
		},
	}, false)
	if err == nil {
		t.Fatal("缺 offset 应失败")
	}

	// 显式偏移成功
	err = docCommentValidateAnchorFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"start-block-id": "blk_a",
			"end-block-id":   "blk_b",
			"start-offset":   0,
			"end-offset":     3,
		},
	}, false)
	if err != nil {
		t.Fatalf("显式跨块应通过: %v", err)
	}

	// reanchor 不允许无锚点
	err = docCommentValidateAnchorFlags(&cmdutil.RunContext{FlagValues: map[string]any{}}, true)
	if err == nil {
		t.Fatal("reanchor 无锚点应失败")
	}
}

func TestDocCommentValidateContentFlags(t *testing.T) {
	err := docCommentValidateContentFlags(&cmdutil.RunContext{FlagValues: map[string]any{}}, "add")
	if err == nil {
		t.Fatal("无 body/image 应失败")
	}

	err = docCommentValidateContentFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{"body": "hi"},
	}, "add")
	if err != nil {
		t.Fatalf("有 body 应通过: %v", err)
	}

	images := make([]string, docCommentMaxImages+1)
	for i := range images {
		images[i] = fmt.Sprintf("img%d.png", i)
	}
	err = docCommentValidateContentFlags(&cmdutil.RunContext{
		FlagValues: map[string]any{"image": images},
	}, "add")
	if err == nil {
		t.Fatal("超过 9 张应失败")
	}
}

func TestDocCommentDryRunAnchorPreview(t *testing.T) {
	scope, anchor, _ := docCommentDryRunAnchorPreview(&cmdutil.RunContext{
		FlagValues: map[string]any{"document": true},
	})
	if scope != "document" || len(anchor) != 0 {
		t.Fatalf("document preview 不符: %s %#v", scope, anchor)
	}

	scope, anchor, selected := docCommentDryRunAnchorPreview(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"block-id": "blk_a",
			"text":     "结论",
		},
	})
	if scope != "text_range" || selected != "结论" {
		t.Fatalf("block+text preview 不符: %s %q %#v", scope, selected, anchor)
	}
	if anchor["block_ids"].([]string)[0] != "blk_a" {
		t.Fatalf("block_ids 不符: %#v", anchor)
	}
}

func TestDocCommentCommandsMountedAndFlags(t *testing.T) {
	cmd := newTestDocCmd(t)
	cases := []struct {
		path  []string
		flags []string
	}{
		{[]string{"comment", "list"}, []string{"threads"}},
		{[]string{"comment", "add"}, []string{"document", "block-id", "text", "image", "start-block-id", "end-block-id", "start-offset", "end-offset"}},
		{[]string{"comment", "reply"}, []string{"body", "image"}},
		{[]string{"comment", "resolve"}, nil},
		{[]string{"comment", "reopen"}, nil},
		{[]string{"comment", "reanchor"}, []string{"block-id", "text", "start-block-id"}},
		{[]string{"comment", "create"}, []string{"body"}},
		{[]string{"comment", "rm"}, nil},
	}
	for _, tc := range cases {
		found, _, err := cmd.Find(tc.path)
		if err != nil || found == nil {
			t.Fatalf("未挂载 %v: %v", tc.path, err)
		}
		def := cmdutil.GetCommandDef(found)
		if def == nil {
			t.Fatalf("%v 缺少 CommandDef", tc.path)
		}
		for _, name := range tc.flags {
			if found.Flags().Lookup(name) == nil {
				t.Errorf("%v 缺少 --%s", tc.path, name)
			}
		}
	}
}

func TestDocCommentAddDryRunPlan(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"comment", "add"})
	if err != nil || found == nil {
		t.Fatalf("comment add 未挂载: %v", err)
	}
	def := cmdutil.GetCommandDef(found)
	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"doc_x"},
		FlagValues: map[string]any{
			"document": true,
			"body":     "看图",
			"image":    []string{"/tmp/a.png"},
		},
	})
	if plan == nil || len(plan.Plan) < 2 {
		t.Fatalf("add dry-run 应含上传与创建步骤: %#v", plan)
	}
	last := plan.Plan[len(plan.Plan)-1]
	if last.Method != "POST" || !strings.Contains(last.URL, "/comment-threads") {
		t.Fatalf("最后一步应为 POST comment-threads: %#v", last)
	}
}

func TestDocCommentResolveFixedStatus(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"comment", "resolve"})
	if err != nil {
		t.Fatal(err)
	}
	def := cmdutil.GetCommandDef(found)
	if def.FixedFields["status"] != "resolved" {
		t.Fatalf("resolve FixedFields: %#v", def.FixedFields)
	}
	found, _, err = cmd.Find([]string{"comment", "reopen"})
	if err != nil {
		t.Fatal(err)
	}
	def = cmdutil.GetCommandDef(found)
	if def.FixedFields["status"] != "open" {
		t.Fatalf("reopen FixedFields: %#v", def.FixedFields)
	}
}

// mockCommentTransport 按 path 返回预设响应，记录调用顺序。
type mockCommentTransport struct {
	typ   string
	calls []string
	// path 前缀 → 响应
	handlers map[string]func(method, path string, body map[string]any) (*transport.Response, error)
}

func (m *mockCommentTransport) Type() string   { return m.typ }
func (m *mockCommentTransport) Close() error   { return nil }
func (m *mockCommentTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *transport.RequestOptions) (*transport.Response, error) {
	m.calls = append(m.calls, method+" "+path)
	for prefix, h := range m.handlers {
		if strings.Contains(path, prefix) {
			return h(method, path, body)
		}
	}
	return &transport.Response{Status: 404, Data: json.RawMessage(`{"success":false,"message":"not found"}`)}, nil
}

func TestDocCommentUploadOneImageSuccessAndPutFailure(t *testing.T) {
	tmp := t.TempDir()
	imgPath := filepath.Join(tmp, "shot.png")
	if err := os.WriteFile(imgPath, []byte("fakepng"), 0o644); err != nil {
		t.Fatal(err)
	}

	putSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("want PUT, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer putSrv.Close()

	tr := &mockCommentTransport{
		typ: transport.TypeHTTP,
		handlers: map[string]func(string, string, map[string]any) (*transport.Response, error){
			"presign-upload": func(method, path string, body map[string]any) (*transport.Response, error) {
				data, _ := json.Marshal(map[string]any{
					"success": true,
					"data": map[string]any{
						"upload_url":   putSrv.URL,
						"upload_token": "tok_1",
						"headers":      map[string]any{"Content-Type": "image/png"},
					},
				})
				return &transport.Response{Status: 200, Data: data}, nil
			},
			"confirm-upload": func(method, path string, body map[string]any) (*transport.Response, error) {
				if body["upload_token"] != "tok_1" {
					t.Errorf("confirm token: %#v", body)
				}
				data, _ := json.Marshal(map[string]any{
					"success": true,
					"data": map[string]any{
						"attachment": map[string]any{"file_id": "file_abc"},
					},
				})
				return &transport.Response{Status: 200, Data: data}, nil
			},
		},
	}

	ctx := &cmdutil.RunContext{ReqContext: context.Background(), FlagValues: map[string]any{}}
	id, err := docCommentUploadOneImage(ctx, tr, "doc_1", imgPath)
	if err != nil {
		t.Fatalf("上传成功路径失败: %v", err)
	}
	if id != "file_abc" {
		t.Fatalf("file_id=%q", id)
	}

	// PUT 失败：注入 uploader，UploadOneImage 应返回错误（PrintErrorAndExit → ExitError）
	orig := docCommentPutFile
	defer func() { docCommentPutFile = orig }()
	docCommentPutFile = func(ctx context.Context, localPath, uploadURL, contentType string, headers map[string]string) error {
		return fmt.Errorf("simulated put failure")
	}
	_, err = docCommentUploadOneImage(ctx, tr, "doc_1", imgPath)
	if err == nil {
		t.Fatal("PUT 失败应返回 error")
	}
}

func TestDocCommentGuessImageMIME(t *testing.T) {
	if got := docCommentGuessImageMIME("a.PNG"); got != "image/png" {
		t.Fatalf("png: %s", got)
	}
	if got := docCommentGuessImageMIME("a.jpeg"); got != "image/jpeg" {
		t.Fatalf("jpeg: %s", got)
	}
}

func TestDocCommentParseMentionUserIDs(t *testing.T) {
	ids, err := docCommentParseMentionUserIDs(`["u1","u2"]`)
	if err != nil || len(ids) != 2 || ids[0] != "u1" {
		t.Fatalf("parse: %v %#v", err, ids)
	}
	_, err = docCommentParseMentionUserIDs("not-json")
	if err == nil {
		t.Fatal("非法 JSON 应失败")
	}
}
