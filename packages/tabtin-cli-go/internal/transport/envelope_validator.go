package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// envelopeExemptPathPatterns 列出无需 envelope 校验的 path 子串。
// 命中（子串包含匹配）的请求，即使响应不是新 envelope 形态也不会被替换成 LEGACY_SHAPE。
//
// 加入原则：
//   - 平台自身的诊断 / 引导端点（/dev/token、/health、/healthz、/version）—— 这些是
//     transport 自己内部的引导调用，不走业务 pipeline，强行套 envelope 反而会卡死自检
//   - SSE 等长连接走 Stream / PostStream，本就不进入 Request 校验链；这里列 /agent/stream
//     更多是给后续读代码的人一个"哪些 path 在协议外"的速查
var envelopeExemptPathPatterns = []string{
	"/dev/token",
	"/health",
	"/healthz",
	"/version",
	"/agent/stream",
}

func isEnvelopeExempt(path string) bool {
	for _, p := range envelopeExemptPathPatterns {
		if strings.Contains(path, p) {
			return true
		}
	}
	return false
}

// rawEnvelope 仅用于探测响应形态，不真正反序列化业务字段。
type rawEnvelope struct {
	Ok      *bool       `json:"ok"`
	Success *bool       `json:"success"`
	Data    interface{} `json:"data"`
	Error   interface{} `json:"error"`
}

// detectEnvelopeShape 探测 body 是新 envelope / 旧 envelope / 未知形态。
// 返回三个布尔，恰有一个为 true：
//   - isNew：合法新 envelope（含 ok 字段；或非 JSON / 空响应 → 透传，不校验）
//   - isLegacy：含 success 字段的旧 envelope，必须报错
//   - isUnknown：是合法 JSON 但既无 ok 也无 success（裸数组、原始字符串、{detail:...} 等），必须报错
func detectEnvelopeShape(body []byte) (isNew, isLegacy, isUnknown bool) {
	if len(body) == 0 {
		return true, false, false
	}
	// 非 JSON（二进制 / 自由文本 / SSE chunk）：不强制 envelope，透传
	if !json.Valid(body) {
		return true, false, false
	}
	// 是合法 JSON 但不是对象（数组、字符串、数字、true/false/null）→ 一律 unknown
	var env rawEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return false, false, true
	}
	if env.Ok != nil {
		return true, false, false
	}
	if env.Success != nil {
		return false, true, false
	}
	return false, false, true
}

// WithEnvelopeValidation 包装 transport，对每次 Request 的响应校验是否为新 envelope。
// 旧 envelope（含 success 字段）或无法识别形态时，把 Response.Data 替换为 LEGACY_SHAPE 错误信封。
//
// 设计约束（见 docs/agent/cli-spec/cli-protocol.md §8.1 §8.2 §8.5）：
//   - **不做兼容转换**——LEGACY_SHAPE 是结构化错误，倒逼上游升级
//   - Response.Status **保持原值**（不要硬改成 5xx），pipeline 上层按 Status 4xx/5xx 分支处理
//   - 替换后的 Response.Data 必须是合法 JSON envelope
//   - 仅校验 Request；Stream / PostStream 透传（长连接形态不适用 envelope 契约）
func WithEnvelopeValidation(inner Transport) Transport {
	if inner == nil {
		return inner
	}
	return &envelopeValidatorTransport{inner: inner}
}

type envelopeValidatorTransport struct {
	inner Transport
}

func (t *envelopeValidatorTransport) Type() string { return t.inner.Type() }

func (t *envelopeValidatorTransport) AuthSource() AuthSource {
	return AuthSourceOf(t.inner)
}

func (t *envelopeValidatorTransport) Close() error { return t.inner.Close() }

func (t *envelopeValidatorTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	if st, ok := t.inner.(StreamTransport); ok {
		return st.Stream(ctx, path, opts)
	}
	return nil, ErrStreamNotSupported
}

func (t *envelopeValidatorTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	if pst, ok := t.inner.(PostStreamTransport); ok {
		return pst.PostStream(ctx, path, body, opts)
	}
	return nil, ErrStreamNotSupported
}

func (t *envelopeValidatorTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	resp, err := t.inner.Request(ctx, method, path, body, opts)
	if err != nil || resp == nil {
		return resp, err
	}
	if isEnvelopeExempt(path) {
		return resp, nil
	}
	// 204 No Content 约定无 body
	if resp.Status == 204 {
		return resp, nil
	}
	isNew, isLegacy, isUnknown := detectEnvelopeShape(resp.Data)
	if isNew {
		return resp, nil
	}
	resp.Data = buildLegacyShapeEnvelope(method, path, resp.Data, isLegacy, isUnknown)
	return resp, nil
}

const legacyShapePreviewLimit = 200

func buildLegacyShapeEnvelope(method, path string, raw []byte, isLegacy, isUnknown bool) json.RawMessage {
	endpoint := fmt.Sprintf("%s %s", method, path)

	var message, hint string
	switch {
	case isLegacy:
		message = "上游返回旧 envelope（含 success 字段）"
		hint = "请在 Django 后端将该端点升级到新 envelope：{ok, actor, data, meta}"
	case isUnknown:
		message = "上游返回了无法识别的 envelope 形态"
		hint = "请检查后端是否按 CLI 协议返回 envelope（必须含 ok 字段）"
	default:
		// 防御性兜底：detectEnvelopeShape 应该三选一
		message = "上游 envelope 校验未通过"
		hint = "请检查后端是否按 CLI 协议返回 envelope"
	}

	preview := string(raw)
	if len(preview) > legacyShapePreviewLimit {
		preview = preview[:legacyShapePreviewLimit]
	}

	payload := map[string]any{
		"ok": false,
		"actor": map[string]any{
			"type": "service",
			"id":   "svc_cli",
		},
		"error": map[string]any{
			"code":    "LEGACY_SHAPE",
			"message": message,
			"hint":    hint,
			"detail": map[string]any{
				"endpoint":             endpoint,
				"raw_response_preview": preview,
			},
		},
		"meta": map[string]any{
			"endpoint":  endpoint,
			"exit_code": 10,
		},
	}
	out, _ := json.Marshal(payload)
	return out
}
