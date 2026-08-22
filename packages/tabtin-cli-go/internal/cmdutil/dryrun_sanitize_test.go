package cmdutil

import (
	"strings"
	"testing"
)

func TestSanitizeDryRunBodyOmitsContentFields(t *testing.T) {
	body := map[string]any{
		"title":            "周报",
		"content_markdown": strings.Repeat("x", 200),
		"base_version":     3,
	}
	got := sanitizeDryRunBody(body)
	if got["title"] != "周报" {
		t.Fatalf("title = %v", got["title"])
	}
	if got["base_version"] != 3 {
		t.Fatalf("base_version = %v", got["base_version"])
	}
	markdown, ok := got["content_markdown"].(string)
	if !ok || !strings.Contains(markdown, "200 字符") {
		t.Fatalf("content_markdown = %v", got["content_markdown"])
	}
}

func TestSanitizeDryRunBodyTruncatesLongUnknownStrings(t *testing.T) {
	body := map[string]any{
		"note": strings.Repeat("y", dryRunBodyPreviewMaxLen+1),
	}
	got := sanitizeDryRunBody(body)
	note, ok := got["note"].(string)
	if !ok || !strings.Contains(note, "字符") {
		t.Fatalf("note = %v", got["note"])
	}
}

func TestSanitizeDryRunPlanSanitizesStepBodies(t *testing.T) {
	plan := &DryRunPlan{
		Description: "test",
		Plan: []DryRunStep{
			{
				Step:   1,
				Method: "POST",
				URL:    "/api/x",
				Body: map[string]any{
					"html": strings.Repeat("z", 100),
				},
			},
		},
	}
	got := sanitizeDryRunPlan(plan)
	body, ok := got.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("body type = %T", got.Plan[0].Body)
	}
	html, ok := body["html"].(string)
	if !ok || !strings.Contains(html, "100 字符") {
		t.Fatalf("html = %v", body["html"])
	}
}

func TestTruncateResponseBodySnippet(t *testing.T) {
	short := truncateResponseBodySnippet("ok")
	if short != "ok" {
		t.Fatalf("short = %q", short)
	}
	long := truncateResponseBodySnippet(strings.Repeat("a", dryRunErrorBodyMaxLen+10))
	if len(long) != dryRunErrorBodyMaxLen+len("…(已截断)") {
		t.Fatalf("long len = %d", len(long))
	}
}
