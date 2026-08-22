package transport

import (
	"context"
	"encoding/json"
	"io"
	"testing"
)

// mockTransport 为测试用的最小 Transport 实现：每次 Request 都返回固定 Response。
type mockTransport struct {
	typ      string
	response *Response
	err      error
	calls    int
}

func (m *mockTransport) Type() string { return m.typ }

func (m *mockTransport) Close() error { return nil }

func (m *mockTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	// 浅拷贝避免被 middleware 改写后污染 fixture
	resp := *m.response
	if m.response.Data != nil {
		resp.Data = append(json.RawMessage(nil), m.response.Data...)
	}
	return &resp, nil
}

func (m *mockTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	return nil, ErrStreamNotSupported
}

func (m *mockTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	return nil, ErrStreamNotSupported
}

func TestEnvelopeValidator_NewEnvelopePasses(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeSocket,
		response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true,"data":{"id":"doc_1"}}`)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "GET", "/api/tabdoc/documents", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("status changed: got %d want 200", resp.Status)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Data, &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got["ok"] != true {
		t.Errorf("expected ok=true, got %v", got["ok"])
	}
}

func TestEnvelopeValidator_LegacyEnvelopeReplaced(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeDjango,
		response: &Response{Status: 200, Data: json.RawMessage(`{"success":true,"data":{"id":"doc_1"}}`)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "POST", "/api/tabdoc/documents", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("status should be preserved: got %d want 200", resp.Status)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Data, &got); err != nil {
		t.Fatalf("invalid replacement envelope: %v", err)
	}
	if got["ok"] != false {
		t.Errorf("expected ok=false, got %v", got["ok"])
	}
	errObj, ok := got["error"].(map[string]any)
	if !ok {
		t.Fatalf("missing error object: %v", got)
	}
	if errObj["code"] != "LEGACY_SHAPE" {
		t.Errorf("expected code=LEGACY_SHAPE, got %v", errObj["code"])
	}
	if errObj["hint"] == "" || errObj["hint"] == nil {
		t.Error("hint should be non-empty per cli-philosophy 铁律 6")
	}
	detail, ok := errObj["detail"].(map[string]any)
	if !ok {
		t.Fatalf("missing detail: %v", errObj)
	}
	if detail["endpoint"] != "POST /api/tabdoc/documents" {
		t.Errorf("endpoint mismatch: %v", detail["endpoint"])
	}
}

func TestEnvelopeValidator_BareDataReplaced(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeDjango,
		response: &Response{Status: 200, Data: json.RawMessage(`[{"id":"a"},{"id":"b"}]`)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "GET", "/api/things", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Data, &got); err != nil {
		t.Fatalf("invalid replacement envelope: %v", err)
	}
	errObj, ok := got["error"].(map[string]any)
	if !ok {
		t.Fatalf("missing error object: %v", got)
	}
	if errObj["code"] != "LEGACY_SHAPE" {
		t.Errorf("bare data should trigger LEGACY_SHAPE, got %v", errObj["code"])
	}
}

func TestEnvelopeValidator_EmptyBodyPasses(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeSocket,
		response: &Response{Status: 200, Data: json.RawMessage(``)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "GET", "/api/empty", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Data) != 0 {
		t.Errorf("empty body should be passed through unchanged, got %s", string(resp.Data))
	}
}

func TestEnvelopeValidator_NonJSONPasses(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeSocket,
		response: &Response{Status: 200, Data: json.RawMessage(`not-json-at-all`)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "GET", "/api/binary", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(resp.Data) != "not-json-at-all" {
		t.Errorf("non-JSON should pass through unchanged, got %s", string(resp.Data))
	}
}

func TestEnvelopeValidator_204Passes(t *testing.T) {
	inner := &mockTransport{
		typ:      TypeSocket,
		response: &Response{Status: 204, Data: json.RawMessage(``)},
	}
	tr := WithEnvelopeValidation(inner)

	resp, err := tr.Request(context.Background(), "DELETE", "/api/something", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != 204 {
		t.Errorf("status changed: got %d want 204", resp.Status)
	}
}

func TestEnvelopeValidator_ExemptPath(t *testing.T) {
	cases := []string{"/health", "/healthz", "/version", "/dev/token", "/agent/stream"}
	for _, path := range cases {
		t.Run(path, func(t *testing.T) {
			inner := &mockTransport{
				typ:      TypeSocket,
				response: &Response{Status: 200, Data: json.RawMessage(`{"token":"abc"}`)},
			}
			tr := WithEnvelopeValidation(inner)
			resp, err := tr.Request(context.Background(), "GET", path, nil, nil)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(resp.Data) != `{"token":"abc"}` {
				t.Errorf("exempt path should pass through unchanged, got %s", string(resp.Data))
			}
		})
	}
}

func TestEnvelopeValidator_StatusPreservedOnLegacy(t *testing.T) {
	// 即使后端在 4xx / 5xx 时返回旧 envelope，Status 也必须保留（让上层走错误分支）
	cases := []int{200, 400, 404, 500, 502}
	for _, status := range cases {
		inner := &mockTransport{
			typ:      TypeDjango,
			response: &Response{Status: status, Data: json.RawMessage(`{"success":false,"data":null}`)},
		}
		tr := WithEnvelopeValidation(inner)
		resp, err := tr.Request(context.Background(), "GET", "/api/anything", nil, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Status != status {
			t.Errorf("status changed from %d to %d", status, resp.Status)
		}
	}
}

func TestEnvelopeValidator_PreviewTruncated(t *testing.T) {
	// 构造一个超过 200 字符的旧 envelope
	long := `{"success":true,"data":"`
	for i := 0; i < 500; i++ {
		long += "x"
	}
	long += `"}`
	inner := &mockTransport{
		typ:      TypeDjango,
		response: &Response{Status: 200, Data: json.RawMessage(long)},
	}
	tr := WithEnvelopeValidation(inner)
	resp, _ := tr.Request(context.Background(), "GET", "/api/x", nil, nil)

	var env map[string]any
	_ = json.Unmarshal(resp.Data, &env)
	errObj := env["error"].(map[string]any)
	detail := errObj["detail"].(map[string]any)
	preview := detail["raw_response_preview"].(string)
	if len(preview) > legacyShapePreviewLimit {
		t.Errorf("preview length %d exceeds limit %d", len(preview), legacyShapePreviewLimit)
	}
}

func TestDetectEnvelopeShape(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantNew   bool
		wantLegacy bool
		wantUnknown bool
	}{
		{"empty", "", true, false, false},
		{"non-json", "garbage", true, false, false},
		{"new ok true", `{"ok":true}`, true, false, false},
		{"new ok false", `{"ok":false,"error":{"code":"X"}}`, true, false, false},
		{"legacy success", `{"success":true,"data":{}}`, false, true, false},
		{"unknown array", `[1,2,3]`, false, false, true},
		{"unknown object", `{"foo":"bar"}`, false, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isNew, isLegacy, isUnknown := detectEnvelopeShape([]byte(tt.body))
			if isNew != tt.wantNew || isLegacy != tt.wantLegacy || isUnknown != tt.wantUnknown {
				t.Errorf("got (new=%v, legacy=%v, unknown=%v), want (new=%v, legacy=%v, unknown=%v)",
					isNew, isLegacy, isUnknown, tt.wantNew, tt.wantLegacy, tt.wantUnknown)
			}
		})
	}
}
