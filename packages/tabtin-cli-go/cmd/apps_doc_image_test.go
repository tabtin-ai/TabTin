package cmd

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestBuildImageMarkdown 锁 ![alt](url) 契约的 Go 侧构造：alt 走
// escapeMarkdownInline 转义（元字符 + 换行折空格），src 原样输出，
// alt 为空时回退默认替代文本。
func TestBuildImageMarkdown(t *testing.T) {
	got := buildImageMarkdown("架构图", "https://oss.example.com/a.png")
	want := "![架构图](https://oss.example.com/a.png)"
	if got != want {
		t.Errorf("markdown 契约不匹配:\n got: %q\nwant: %q", got, want)
	}

	// 元字符转义：alt 含 ] [ * 等会破坏 ![...] 语法的字符
	got = buildImageMarkdown("a]b[c*d", "https://x.com/a.png")
	if !strings.Contains(got, `a\]b\[c\*d`) {
		t.Errorf("alt 元字符转义不符: %q", got)
	}

	// 换行折空格：alt 是单行属性
	got = buildImageMarkdown("第一行\n第二行", "https://x.com/a.png")
	if !strings.Contains(got, "第一行 第二行") {
		t.Errorf("alt 换行应折成空格: %q", got)
	}

	// 缺省兜底：空 alt → 默认替代文本
	got = buildImageMarkdown("", "https://x.com/a.png")
	if !strings.Contains(got, docImageDefaultAlt) {
		t.Errorf("缺省兜底不符: %q", got)
	}
}

// TestDocImagePlaceholderMarkdown 锁 dry-run 预览：url 是占位符，alt 走同一套转义。
func TestDocImagePlaceholderMarkdown(t *testing.T) {
	got := docImagePlaceholderMarkdown("图 1")
	if !strings.Contains(got, "图 1") || !strings.Contains(got, "<上传后回填>") {
		t.Errorf("dry-run 占位不符: %q", got)
	}
}

func TestDocImageBlockBodyPlacement(t *testing.T) {
	start := docImageBlockBody("![图](https://x/img.png)", "", true)
	if start["at_start"] != true {
		t.Fatalf("--at-start 必须透传 at_start=true: %#v", start)
	}
	if _, ok := start["after_block_id"]; ok {
		t.Fatalf("顶部插入不应同时传 after_block_id: %#v", start)
	}

	after := docImageBlockBody("![图](https://x/img.png)", "blk_a", false)
	if after["after_block_id"] != "blk_a" {
		t.Fatalf("--after 必须透传 after_block_id: %#v", after)
	}
	if _, ok := after["at_start"]; ok {
		t.Fatalf("普通定位不应发送 at_start=false: %#v", after)
	}
}

func TestDocImageRecoveryCommandKeepsTopPlacement(t *testing.T) {
	got := docImageInsertRecoveryCmd("doc_x", "![图](https://x/img.png)", "file_x", "", true)
	if !strings.Contains(got, " --at-start") {
		t.Fatalf("顶部插入失败后的恢复命令必须保留 --at-start: %q", got)
	}
	if !strings.Contains(got, " --image-file-id 'file_x'") {
		t.Fatalf("恢复命令必须保留私有图片 file_id: %q", got)
	}
}

func TestDocInsertImageDryRunLocksPrivateTopInsertionContract(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"insert-image"})
	if err != nil || found == nil {
		t.Fatalf("doc insert-image 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(found)
	if def == nil || def.DryRun == nil {
		t.Fatal("doc insert-image 缺少 CommandDef 或 dry-run")
	}

	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"doc_x"},
		FlagValues: map[string]any{
			"file":     "/tmp/cover.png",
			"at-start": true,
		},
	})
	if plan == nil || len(plan.Plan) != 2 {
		t.Fatalf("insert-image 应包含上传和插块两步: %#v", plan)
	}
	uploadBody, ok := plan.Plan[0].Body.(map[string]any)
	if !ok || uploadBody["is_public"] != false {
		t.Fatalf("图片上传必须显式私有: %#v", plan.Plan[0].Body)
	}
	blockBody, ok := plan.Plan[1].Body.(map[string]any)
	if !ok || blockBody["at_start"] != true {
		t.Fatalf("顶部插入必须透传 at_start=true: %#v", plan.Plan[1].Body)
	}
	if blockBody["image_file_id"] == nil {
		t.Fatalf("插入块必须绑定上传后的稳定 file_id: %#v", plan.Plan[1].Body)
	}
}

// TestDocImageUploadBodyContextType 锁  同款口径：有真实 docID 时
// /oss/upload 请求体必须带 context_type='document'（配合 context_id），
// 让文件纳入 TabDoc 归档/删除的 FileUsage 清理路径；无 docID（dry-run 占位）
// 时不带 context_type，服务端回退默认 'present'。与 insert-html 的关键区别：
// 不固定 mime_type，交给服务端按扩展名自动识别（图片扩展名多样）。
func TestDocImageUploadBodyContextType(t *testing.T) {
	body := docImageUploadBody("doc_x", "/tmp/a.png")
	if body["context_id"] != "doc_x" {
		t.Errorf("有 docID 应带 context_id=doc_x, got %v", body["context_id"])
	}
	if body["context_type"] != "document" {
		t.Errorf("有 docID 应带 context_type=document, got %v", body["context_type"])
	}
	if body["folder"] != docImageUploadFolder || body["module"] != docImageUploadModule {
		t.Errorf("上传归类字段不符: %#v", body)
	}
	if body["is_public"] != false {
		t.Errorf("TabDoc 图片对象必须保持私有，got %#v", body["is_public"])
	}
	if _, ok := body["mime_type"]; ok {
		t.Errorf("insert-image 不应固定 mime_type（应由服务端按扩展名猜测）: %#v", body)
	}

	// dry-run 占位 docID（<document-id>）与空 docID：不带 context_id / context_type，
	// 保持通用上传默认（服务端回退 present）。
	for _, docID := range []string{"", "<document-id>"} {
		b := docImageUploadBody(docID, "/tmp/a.png")
		if _, ok := b["context_id"]; ok {
			t.Errorf("docID=%q 不应带 context_id: %#v", docID, b)
		}
		if _, ok := b["context_type"]; ok {
			t.Errorf("docID=%q 不应带 context_type: %#v", docID, b)
		}
	}
}

// TestDocImageAltFromFile 锁缺省 alt 取值：文件名去扩展名；空路径回退默认。
func TestDocImageAltFromFile(t *testing.T) {
	cases := map[string]string{
		"/tmp/architecture.png": "architecture",
		"./chart.v2.svg":        "chart.v2",
		"":                      docImageDefaultAlt,
		"/tmp/.hidden":          docImageDefaultAlt,
	}
	for in, want := range cases {
		if got := docImageAltFromFile(in); got != want {
			t.Errorf("docImageAltFromFile(%q) = %q, want %q", in, got, want)
		}
	}
}
