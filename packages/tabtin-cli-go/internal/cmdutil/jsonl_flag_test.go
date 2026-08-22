package cmdutil

// ：--records / --fields 等 JSON flag 兼容 JSONL——
// Agent 常直接产出 JSONL 喂 @file，之前必须手工转数组再重试。

import (
	"reflect"
	"testing"
)

func TestParseJSONLikeStringAcceptsJSONL(t *testing.T) {
	raw := `{"标题":"a","互动数":1}
{"标题":"b","互动数":2}

{"标题":"c","互动数":3}`

	parsed, ok := parseJSONLikeString(raw, true)
	if !ok {
		t.Fatal("JSONL 应被聚合为数组")
	}
	items, isSlice := parsed.([]any)
	if !isSlice || len(items) != 3 {
		t.Fatalf("parsed = %v, want 3 项数组", parsed)
	}
	first, _ := items[0].(map[string]any)
	if !reflect.DeepEqual(first["标题"], "a") {
		t.Errorf("首项 = %v", items[0])
	}
}

func TestParseJSONLikeStringRejectsPrettyPrintedSingleObject(t *testing.T) {
	// 多行 pretty-printed 的单个 JSON：整体解析成功，走原路径返回 object，
	// 不允许被 JSONL 兜底误聚合成数组（object 语义 flag 错型透传）
	raw := `{
  "name": "书名",
  "field_type": "text"
}`
	parsed, ok := parseJSONLikeString(raw, true)
	if !ok {
		t.Fatal("合法 JSON object 应解析成功")
	}
	if _, isMap := parsed.(map[string]any); !isMap {
		t.Fatalf("parsed = %T, want map（不得被聚合为数组）", parsed)
	}
}

func TestParseJSONLikeStringRejectsBrokenJSONL(t *testing.T) {
	// 有一行不是合法 JSON → 整体判失败，不做部分聚合
	raw := `{"a":1}
not-json
{"a":2}`
	if _, ok := parseJSONLikeString(raw, true); ok {
		t.Fatal("含非法行的 JSONL 不应被聚合")
	}
}

func TestParseJSONLikeStringRejectsSingleLineJSONL(t *testing.T) {
	// 单行且整体解析失败（截断 JSON）→ 不聚合，保持原报错路径
	raw := `{"a":1`
	if _, ok := parseJSONLikeString(raw, true); ok {
		t.Fatal("截断 JSON 不应被接受")
	}
}
