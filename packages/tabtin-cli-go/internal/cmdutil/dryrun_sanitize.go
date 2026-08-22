package cmdutil

import (
	"fmt"
	"strings"
)

const (
	dryRunBodyPreviewMaxLen = 80
	dryRunErrorBodyMaxLen   = 500
)

var dryRunContentFieldKeys = map[string]struct{}{
	"content_markdown":          {},
	"content_plaintext":         {},
	"content_pm_json":           {},
	"initial_content_markdown":  {},
	"initial_content_plaintext": {},
	"initial_content_pm_json":   {},
	"markdown":                  {},
	"html":                      {},
	"contents":                  {},
	"content":                   {},
	"body":                      {},
	"text":                      {},
	"instructions":              {},
	"csv_content":               {},
	"json_content":              {},
	"file_content":              {},
	"base64":                    {},
	"description_json":          {},
	"description_markdown":      {},
	"description_plaintext":     {},
	"pm_json":                   {},
	"plaintext":                 {},
	"patch":                     {},
	"pages":                     {},
}

func sanitizeDryRunBody(body map[string]any) map[string]any {
	if body == nil {
		return nil
	}
	out := make(map[string]any, len(body))
	for k, v := range body {
		out[k] = sanitizeDryRunValue(k, v)
	}
	return out
}

func sanitizeDryRunPlan(plan *DryRunPlan) *DryRunPlan {
	if plan == nil {
		return nil
	}
	sanitized := &DryRunPlan{
		Description: plan.Description,
		Extra:       plan.Extra,
		Plan:        make([]DryRunStep, len(plan.Plan)),
	}
	for i, step := range plan.Plan {
		sanitized.Plan[i] = DryRunStep{
			Step:      step.Step,
			Method:    step.Method,
			URL:       step.URL,
			Body:      sanitizeDryRunStepBody(step.Body),
			File:      step.File,
			SizeBytes: step.SizeBytes,
		}
	}
	return sanitized
}

func sanitizeDryRunStepBody(body any) any {
	if m, ok := body.(map[string]any); ok {
		return sanitizeDryRunBody(m)
	}
	return body
}

func sanitizeDryRunValue(key string, value any) any {
	switch val := value.(type) {
	case string:
		if shouldSanitizeDryRunString(key, val) {
			return dryRunStringPlaceholder(key, len(val))
		}
		return val
	case map[string]any:
		if isDryRunContentFieldKey(key) {
			return map[string]any{
				"_omitted": fmt.Sprintf("<%s: object, %d keys>", key, len(val)),
			}
		}
		out := make(map[string]any, len(val))
		for k, v := range val {
			out[k] = sanitizeDryRunValue(k, v)
		}
		return out
	case []any:
		if isDryRunContentFieldKey(key) {
			return fmt.Sprintf("<%s: array, %d items>", key, len(val))
		}
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = sanitizeDryRunValue(fmt.Sprintf("%s[%d]", key, i), item)
		}
		return out
	default:
		return value
	}
}

func shouldSanitizeDryRunString(key, value string) bool {
	if value == "" {
		return false
	}
	if isDryRunContentFieldKey(key) {
		return true
	}
	return len(value) > dryRunBodyPreviewMaxLen
}

func isDryRunContentFieldKey(key string) bool {
	_, ok := dryRunContentFieldKeys[key]
	return ok
}

func dryRunStringPlaceholder(key string, size int) string {
	return fmt.Sprintf("<见 --%s，%d 字符；支持 @文件 / -stdin>", strings.ReplaceAll(key, "_", "-"), size)
}

func truncateResponseBodySnippet(body string) string {
	if len(body) <= dryRunErrorBodyMaxLen {
		return body
	}
	return body[:dryRunErrorBodyMaxLen] + "…(已截断)"
}
