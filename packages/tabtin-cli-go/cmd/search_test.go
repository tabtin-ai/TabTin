package cmd

import (
	"strings"
	"testing"
)

func TestRenderSearchHumanReadable(t *testing.T) {
	got := renderSearchHumanReadable(map[string]any{
		"total":   float64(1),
		"took_ms": float64(12),
		"results": []any{
			map[string]any{
				"type":         "message",
				"title":        "命中标题",
				"snippet":      "hello <em>world</em>",
				"creator_name": "Agent A",
				"creator_type": "agent",
				"space_name":   "Demo Space",
				"created_at":   "2026-05-05T00:00:00Z",
			},
		},
	})

	for _, want := range []string{"消息 (1)", "命中标题", "hello world", "共 1 条命中"} {
		if !strings.Contains(got, want) {
			t.Fatalf("rendered output missing %q:\n%s", want, got)
		}
	}
}
