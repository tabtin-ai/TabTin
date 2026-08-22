package cmd

import (
	"strings"
	"testing"
)

// TestBuildHTMLBlockMarkdown 锁 :::htmlblock{...} 三方契约的 Go 侧构造：
// 属性顺序 fileId, src, title, height；\\ 与 \" 转义；title 换行折空格；
// height ≤0 回退 480。与 doc-editor pmJsonToMarkdown / Django markdown_exchange 对齐。
func TestBuildHTMLBlockMarkdown(t *testing.T) {
	got := buildHTMLBlockMarkdown("f-1", "https://oss.example.com/a.html", "架构图", 600)
	want := ":::htmlblock{fileId=\"f-1\" src=\"https://oss.example.com/a.html\" title=\"架构图\" height=\"600\"}\n:::"
	if got != want {
		t.Errorf("markdown 契约不匹配:\n got: %q\nwant: %q", got, want)
	}

	// 转义：title 含引号与反斜杠
	got = buildHTMLBlockMarkdown("f", "https://x.com/a.html", `他说"你好" C:\dir`, 480)
	if !strings.Contains(got, `title="他说\"你好\" C:\\dir"`) {
		t.Errorf("title 转义不符: %q", got)
	}

	// title 换行折空格
	got = buildHTMLBlockMarkdown("f", "https://x.com/a.html", "第一行\n第二行", 480)
	if !strings.Contains(got, `title="第一行 第二行"`) {
		t.Errorf("title 换行应折成空格: %q", got)
	}

	// 缺省兜底：空 title → 未命名 HTML；height ≤0 → 480
	got = buildHTMLBlockMarkdown("f", "https://x.com/a.html", "", 0)
	if !strings.Contains(got, `title="未命名 HTML"`) || !strings.Contains(got, `height="480"`) {
		t.Errorf("缺省兜底不符: %q", got)
	}

	// ：新私有块持久化 src 为空串，只靠 fileId
	got = buildHTMLBlockMarkdown("f-private", "", "私有图", 480)
	want = ":::htmlblock{fileId=\"f-private\" src=\"\" title=\"私有图\" height=\"480\"}\n:::"
	if got != want {
		t.Errorf("空 src 私有契约不匹配:\n got: %q\nwant: %q", got, want)
	}
}

// TestParseHTMLBlockTitleHeight 锁 update-html 沿用旧值的解析回路：
// buildHTMLBlockMarkdown 的输出必须能被 parseHTMLBlockTitleHeight 还原（构造↔解析往返）。
func TestParseHTMLBlockTitleHeight(t *testing.T) {
	md := buildHTMLBlockMarkdown("f-1", "https://oss.example.com/a.html", `带"引号"标题`, 720)
	title, height := parseHTMLBlockTitleHeight(md)
	if title != `带"引号"标题` {
		t.Errorf("title 往返失真: %q", title)
	}
	if height != 720 {
		t.Errorf("height 往返失真: %d", height)
	}

	// 非 htmlblock markdown → 全部回退默认
	title, height = parseHTMLBlockTitleHeight("## 普通标题\n正文")
	if title != docHTMLDefaultTitle || height != docHTMLDefaultHeight {
		t.Errorf("非 HTML 块应回退默认: title=%q height=%d", title, height)
	}

	// 缺 title/height 属性 → 回退默认
	title, height = parseHTMLBlockTitleHeight(":::htmlblock{fileId=\"f\" src=\"https://x.com/a.html\"}\n:::")
	if title != docHTMLDefaultTitle || height != docHTMLDefaultHeight {
		t.Errorf("缺属性应回退默认: title=%q height=%d", title, height)
	}
}

// TestDocHTMLUploadBodyContextType 锁 ：有真实 docID 时 /oss/upload 请求体必须带
// context_type='document'（配合 context_id），让文件纳入 TabDoc 归档/删除的 FileUsage
// 清理路径；无 docID（dry-run 占位）时不带 context_type，服务端回退默认 'present'。
func TestDocHTMLUploadBodyContextType(t *testing.T) {
	body := docHTMLUploadBody("doc_x", "/tmp/a.html")
	if body["context_id"] != "doc_x" {
		t.Errorf("有 docID 应带 context_id=doc_x, got %v", body["context_id"])
	}
	if body["context_type"] != "document" {
		t.Errorf("有 docID 应带 context_type=document, got %v", body["context_type"])
	}
	if body["folder"] != docHTMLUploadFolder || body["module"] != docHTMLUploadModule || body["mime_type"] != docHTMLMimeType {
		t.Errorf("上传归类字段不符: %#v", body)
	}
	if body["is_public"] != false {
		t.Errorf("#7767 应显式 is_public=false, got %#v", body["is_public"])
	}

	// dry-run 占位 docID（<document-id>）与空 docID：不带 context_id / context_type，
	// 保持通用上传默认（服务端回退 present）。
	for _, docID := range []string{"", "<document-id>"} {
		b := docHTMLUploadBody(docID, "/tmp/a.html")
		if _, ok := b["context_id"]; ok {
			t.Errorf("docID=%q 不应带 context_id: %#v", docID, b)
		}
		if _, ok := b["context_type"]; ok {
			t.Errorf("docID=%q 不应带 context_type: %#v", docID, b)
		}
	}
}
