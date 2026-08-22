package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

const usageErrorWrappedAnnotation = "tabtin_usage_error_wrapped"

func registerFlagErrorHandler(root *cobra.Command) {
	handler := newFlagErrorHandler()
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		c.SetFlagErrorFunc(handler)
		wrapArgsUsageError(c)
		for _, child := range c.Commands() {
			walk(child)
		}
	}
	walk(root)
}

func newFlagErrorHandler() func(*cobra.Command, error) error {
	return func(cmd *cobra.Command, err error) error {
		if err == nil {
			return nil
		}
		if errors.Is(err, pflag.ErrHelp) {
			return err
		}
		return printUsageErrorAndExit(cmd, err)
	}
}

func wrapArgsUsageError(c *cobra.Command) {
	if c.Args == nil {
		return
	}
	if c.Annotations != nil && c.Annotations[usageErrorWrappedAnnotation] == "true" {
		return
	}
	originalArgs := c.Args
	c.Args = func(cmd *cobra.Command, args []string) error {
		if err := originalArgs(cmd, args); err != nil {
			return printUsageErrorAndExit(cmd, err)
		}
		return nil
	}
	if c.Annotations == nil {
		c.Annotations = map[string]string{}
	}
	c.Annotations[usageErrorWrappedAnnotation] = "true"
}

func printUsageErrorAndExit(cmd *cobra.Command, err error) error {
	hint := buildFlagErrorHint(cmd, err)
	return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
		string(errcode.ValidationError),
		err.Error(),
		hint,
		output.ExitValidation,
		output.ErrorEnvelopeOpts{Detail: buildFlagErrorDetail(cmd)},
	))
}

func handleCommandExecutionError(cmd *cobra.Command, err error) int {
	var exitErr *output.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.Code
	}
	if cmd != nil && isCobraUsageFallbackError(err) {
		wrappedErr := printUsageErrorAndExit(cmd, err)
		if errors.As(wrappedErr, &exitErr) {
			return exitErr.Code
		}
	}
	wrappedErr := output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.InternalError),
		err.Error(),
		"",
		output.ExitGeneral,
	))
	if errors.As(wrappedErr, &exitErr) {
		return exitErr.Code
	}
	return output.ExitGeneral
}

func isCobraUsageFallbackError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.HasPrefix(msg, "unknown command ") ||
		(strings.Contains(msg, "required flag(s)") && strings.Contains(msg, "not set"))
}

func buildFlagErrorDetail(cmd *cobra.Command) map[string]string {
	help := renderCommandHelp(cmd)
	if help == "" {
		return nil
	}
	return map[string]string{"help": help}
}

func renderCommandHelp(cmd *cobra.Command) string {
	var buf bytes.Buffer
	oldOut := cmd.OutOrStdout()
	oldErr := cmd.ErrOrStderr()
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	defer func() {
		cmd.SetOut(oldOut)
		cmd.SetErr(oldErr)
	}()
	if err := cmd.Help(); err != nil {
		return ""
	}
	return strings.TrimSpace(buf.String())
}

func buildFlagErrorHint(cmd *cobra.Command, err error) string {
	msg := err.Error()
	parts := []string{fmt.Sprintf("运行 `%s --help` 查看该命令用法和 flag 清单", cmd.CommandPath())}

	if badFlag, ok := parseUnknownFlagName(msg); ok {
		if contextual := contextualFlagHint(cmd, badFlag); contextual != "" {
			parts = append(parts, contextual)
		}
		if suggestions := suggestSimilarFlags(cmd, badFlag); len(suggestions) > 0 {
			parts = append(parts, fmt.Sprintf("你是否想传 %s？", strings.Join(suggestions, " 或 ")))
		}
	}

	return strings.Join(parts, "；")
}

func parseUnknownFlagName(msg string) (string, bool) {
	const prefix = "unknown flag: "
	if !strings.HasPrefix(msg, prefix) {
		return "", false
	}
	raw := strings.TrimSpace(strings.TrimPrefix(msg, prefix))
	raw = strings.TrimPrefix(raw, "--")
	raw = strings.TrimPrefix(raw, "-")
	if raw == "" {
		return "", false
	}
	return raw, true
}

func contextualFlagHint(cmd *cobra.Command, badFlag string) string {
	switch badFlag {
	case "id":
		if useLine := cmd.UseLine(); strings.Contains(useLine, "<") {
			return fmt.Sprintf("`--id` 不是本命令的 flag；ID 应作为位置参数传入（用法: %s）", cmd.Use)
		}
	case "content", "markdown":
		if cmd.CommandPath() == "tabtin doc update" {
			return "`tabtin doc update` 只改标题/状态/标签等元数据；改正文请用 `tabtin doc save-content <id> --markdown @/path/file.md --format json`（文件路径前需要 @，`--format` 是输出格式）"
		}
	case "tab-key":
		return "选 Tab 请用 `--tab-id`（`tab list` 输出里的 tabId/activeTabId 字段）"
	case "type":
		if strings.Contains(cmd.CommandPath(), "table view create") {
			return "创建视图请用 `--view-type`（如 kanban / grid），不是 `--type`"
		}
	// browser 域高频误猜映射（：Agent 连续 VALIDATION_ERROR 烧迭代）
	case "url":
		if cmd.CommandPath() == "tabtin browser nav" {
			return "打开 URL 请用 `tabtin browser open --url <url>`；`nav` 只做 back/forward/reload/stop（`--direction`）"
		}
	case "script", "code":
		if cmd.CommandPath() == "tabtin browser eval" {
			return "执行 JavaScript 请用 `--expression`，如 `tabtin browser eval --expression \"document.title\"`"
		}
	case "until":
		if cmd.CommandPath() == "tabtin browser wait" {
			return "等待条件请用 `--selector <css>` + `--timeout <ms>`；没有 `--until` flag"
		}
	case "selector":
		if cmd.CommandPath() == "tabtin browser print" {
			return "`print` 不支持 selector（整页导出）；按元素定位请用 `tabtin browser glance --selector <css>` 或 `wait --selector`"
		}
	}
	return ""
}

func suggestSimilarFlags(cmd *cobra.Command, badFlag string) []string {
	names := collectFlagNames(cmd)
	type scored struct {
		name  string
		score int
	}
	var matches []scored
	for _, name := range names {
		if score := flagNameSimilarity(badFlag, name); score > 0 {
			matches = append(matches, scored{name: name, score: score})
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].score == matches[j].score {
			return matches[i].name < matches[j].name
		}
		return matches[i].score > matches[j].score
	})

	out := make([]string, 0, 3)
	for _, m := range matches {
		if len(out) >= 3 {
			break
		}
		out = append(out, "--"+m.name)
	}
	return out
}

func collectFlagNames(cmd *cobra.Command) []string {
	seen := make(map[string]struct{})
	var names []string
	add := func(set *pflag.FlagSet) {
		if set == nil {
			return
		}
		set.VisitAll(func(f *pflag.Flag) {
			if f.Hidden {
				return
			}
			if _, ok := seen[f.Name]; ok {
				return
			}
			seen[f.Name] = struct{}{}
			names = append(names, f.Name)
		})
	}
	add(cmd.Flags())
	add(cmd.InheritedFlags())
	return names
}

func flagNameSimilarity(a, b string) int {
	if a == b {
		return 100
	}
	if strings.HasPrefix(b, a) || strings.HasPrefix(a, b) {
		return 80
	}
	if strings.Contains(b, a) || strings.Contains(a, b) {
		return 60
	}
	return levenshteinWithin(a, b, 2)
}

func levenshteinWithin(a, b string, max int) int {
	if abs(len(a)-len(b)) > max {
		return 0
	}
	da := make([]int, len(b)+1)
	db := make([]int, len(b)+1)
	for j := 0; j <= len(b); j++ {
		da[j] = j
	}
	for i := 1; i <= len(a); i++ {
		db[0] = i
		rowMin := db[0]
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			db[j] = minInt3(
				db[j-1]+1,
				da[j]+1,
				da[j-1]+cost,
			)
			if db[j] < rowMin {
				rowMin = db[j]
			}
		}
		if rowMin > max {
			return 0
		}
		da, db = db, da
	}
	if da[len(b)] > max {
		return 0
	}
	return 40 - da[len(b)]*10
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func minInt3(a, b, c int) int {
	if a <= b && a <= c {
		return a
	}
	if b <= c {
		return b
	}
	return c
}
