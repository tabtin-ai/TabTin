package transport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// TestReadResponseBodyBinaryContentType ·
//
// Django 直连（DjangoTransport）读响应体时，docx/pdf/xlsx 等二进制内容不能
// 直接 string(raw) 再 json.Marshal——Go 的 UTF-8 编码器会把非法字节序列替换成
// U+FFFD（ef bf bd），弄坏 ZIP/Office/PDF 文件。readResponseBody 必须按
// Content-Type 判定，产出与 cli-server-core/src/django-proxy-body.ts 同形状的
// {__binary, content_type, base64} 信封，pipeline.go 才能正确解码写盘。
func TestReadResponseBodyBinaryContentType(t *testing.T) {
	// PK\x03\x04 是 docx/xlsx 的 ZIP 魔数前缀；混入非法 UTF-8 字节验证不会被替换。
	raw := []byte{0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01}

	got, err := readResponseBody(bytes.NewReader(raw), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	if err != nil {
		t.Fatalf("readResponseBody: %v", err)
	}

	var envelope struct {
		Binary      bool   `json:"__binary"`
		ContentType string `json:"content_type"`
		Base64      string `json:"base64"`
	}
	if err := json.Unmarshal(got, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if !envelope.Binary {
		t.Fatalf("期望 __binary=true，got envelope=%s", got)
	}
	if envelope.ContentType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		t.Errorf("content_type 未原样保留，got=%q", envelope.ContentType)
	}
	decoded, decErr := base64.StdEncoding.DecodeString(envelope.Base64)
	if decErr != nil {
		t.Fatalf("base64 解码失败: %v", decErr)
	}
	if !bytes.Equal(decoded, raw) {
		t.Fatalf("解码后字节与原始不一致（可能被当 UTF-8 弄坏）：got=%x want=%x", decoded, raw)
	}
}

// TestReadResponseBodyBinaryWithoutContentType 覆盖 Content-Type 缺失但内容非法 UTF-8 的兜底分支。
func TestReadResponseBodyBinaryWithoutContentType(t *testing.T) {
	raw := []byte{0x25, 0x50, 0x44, 0x46, 0xff, 0xd8} // %PDF + 非法字节
	got, err := readResponseBody(bytes.NewReader(raw), "")
	if err != nil {
		t.Fatalf("readResponseBody: %v", err)
	}
	if !strings.Contains(string(got), `"__binary":true`) {
		t.Fatalf("Content-Type 缺失且非法 UTF-8 时应回退 __binary 信封，got=%s", got)
	}
	if !strings.Contains(string(got), `"content_type":"application/octet-stream"`) {
		t.Fatalf("兜底 content_type 应为 application/octet-stream，got=%s", got)
	}
}

// TestReadResponseBodyPassthroughCSV csv/tsv 走 __passthrough 而不是 __binary。
func TestReadResponseBodyPassthroughCSV(t *testing.T) {
	raw := []byte("name,age\n张三,10\n")
	got, err := readResponseBody(bytes.NewReader(raw), "text/csv; charset=utf-8")
	if err != nil {
		t.Fatalf("readResponseBody: %v", err)
	}
	var envelope struct {
		Passthrough bool   `json:"__passthrough"`
		Raw         string `json:"raw"`
	}
	if err := json.Unmarshal(got, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if !envelope.Passthrough {
		t.Fatalf("csv 应走 __passthrough，got=%s", got)
	}
	if envelope.Raw != string(raw) {
		t.Fatalf("passthrough raw 应原样保留文本，got=%q want=%q", envelope.Raw, string(raw))
	}
}

// TestReadResponseBodyTextFallback 文本内容（如 markdown 导出）走原有 JSON / {raw} 回退，不受本次改动影响。
func TestReadResponseBodyTextFallback(t *testing.T) {
	raw := []byte("# 标题\n\n正文")
	got, err := readResponseBody(bytes.NewReader(raw), "text/markdown; charset=utf-8")
	if err != nil {
		t.Fatalf("readResponseBody: %v", err)
	}
	var envelope struct {
		Raw string `json:"raw"`
	}
	if err := json.Unmarshal(got, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if envelope.Raw != string(raw) {
		t.Fatalf("文本内容应走 {raw} 回退，got=%q want=%q", envelope.Raw, string(raw))
	}
}

// TestReadResponseBodyValidJSONPassesThrough JSON 响应（cli-server 常见）应原样返回，不额外包装。
func TestReadResponseBodyValidJSONPassesThrough(t *testing.T) {
	raw := []byte(`{"ok":true,"data":{"foo":"bar"}}`)
	got, err := readResponseBody(bytes.NewReader(raw), "application/json")
	if err != nil {
		t.Fatalf("readResponseBody: %v", err)
	}
	if string(got) != string(raw) {
		t.Fatalf("合法 JSON 应原样透传，got=%s want=%s", got, raw)
	}
}

// TestReadResponseBodyPayloadTooLarge 超过 10MB 上限应返回 errPayloadTooLarge。
func TestReadResponseBodyPayloadTooLarge(t *testing.T) {
	raw := bytes.Repeat([]byte("a"), maxResponseBody+1)
	_, err := readResponseBody(bytes.NewReader(raw), "text/plain")
	if err == nil {
		t.Fatal("超过 10MB 应返回错误")
	}
}
