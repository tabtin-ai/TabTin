package output

import (
	"strings"
	"testing"
)

// ：--jq 失败时报错必须带解包后顶层的实际形状，Agent 一次改对
func TestDescribeJQShape(t *testing.T) {
	cases := []struct {
		name string
		data any
		want string
	}{
		{"array", []any{1, 2, 3}, "array（3 项）"},
		{"object", map[string]any{"records": []any{}, "total": 0}, "keys 含: records, total"},
		{"null", nil, "null"},
		{"string", "hello", "string 标量"},
		{"number", 42.0, "number 标量"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := describeJQShape(tc.data)
			if !strings.Contains(got, tc.want) {
				t.Errorf("describeJQShape(%v) = %q, want contains %q", tc.data, got, tc.want)
			}
		})
	}
}

func TestApplyJQ_Simple(t *testing.T) {
	data := []any{
		map[string]any{"id": "1", "name": "alpha"},
		map[string]any{"id": "2", "name": "beta"},
	}

	result, err := ApplyJQ(data, ".[0].id")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "1" {
		t.Errorf("result = %v, want '1'", result)
	}
}

func TestApplyJQ_Length(t *testing.T) {
	data := []any{1, 2, 3}
	result, err := ApplyJQ(data, "length")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != 3 {
		t.Errorf("result = %v, want 3", result)
	}
}

func TestApplyJQ_Select(t *testing.T) {
	data := []any{
		map[string]any{"name": "a", "active": true},
		map[string]any{"name": "b", "active": false},
		map[string]any{"name": "c", "active": true},
	}

	result, err := ApplyJQ(data, `[.[] | select(.active == true) | .name]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	arr, ok := result.([]any)
	if !ok {
		t.Fatalf("result should be array, got %T", result)
	}
	if len(arr) != 2 {
		t.Errorf("expected 2 active items, got %d", len(arr))
	}
}

func TestApplyJQ_InvalidExpr(t *testing.T) {
	data := map[string]any{"key": "val"}
	_, err := ApplyJQ(data, ".[invalid")
	if err == nil {
		t.Error("expected error for invalid jq expression")
	}
}

func TestApplyJQ_Map(t *testing.T) {
	data := map[string]any{"name": "test", "count": float64(42)}
	result, err := ApplyJQ(data, ".name")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "test" {
		t.Errorf("result = %v, want 'test'", result)
	}
}
