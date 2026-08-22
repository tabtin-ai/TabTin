package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestBuildFlagErrorHintUnknownFlag(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	doc := &cobra.Command{Use: "doc"}
	read := &cobra.Command{Use: "read <document-id>"}
	root.AddCommand(doc)
	doc.AddCommand(read)

	hint := buildFlagErrorHint(read, errUnknownFlag("--id"))
	if !strings.Contains(hint, "tabtin doc read --help") {
		t.Fatalf("hint = %q, want help path", hint)
	}
	if !strings.Contains(hint, "位置参数") {
		t.Fatalf("hint = %q, want positional guidance for --id", hint)
	}
}

func TestBuildFlagErrorHintTabKey(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	browser := &cobra.Command{Use: "browser"}
	snapshot := &cobra.Command{Use: "snapshot"}
	root.AddCommand(browser)
	browser.AddCommand(snapshot)

	hint := buildFlagErrorHint(snapshot, errUnknownFlag("--tab-key"))
	if !strings.Contains(hint, "--tab-id") {
		t.Fatalf("hint = %q, want --tab-id suggestion", hint)
	}
}

func TestBuildFlagErrorHintDocUpdateContent(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	doc := &cobra.Command{Use: "doc"}
	update := &cobra.Command{Use: "update [document-id]"}
	root.AddCommand(doc)
	doc.AddCommand(update)

	for _, badFlag := range []string{"--content", "--markdown"} {
		t.Run(badFlag, func(t *testing.T) {
			hint := buildFlagErrorHint(update, errUnknownFlag(badFlag))
			for _, want := range []string{
				"tabtin doc update --help",
				"只改标题/状态/标签等元数据",
				"tabtin doc save-content <id> --markdown @/path/file.md --format json",
				"文件路径前需要 @",
				"`--format` 是输出格式",
			} {
				if !strings.Contains(hint, want) {
					t.Fatalf("hint = %q, want %q", hint, want)
				}
			}
		})
	}
}

func TestBuildFlagErrorHintBrowserMisguesses(t *testing.T) {
	// ：browser 域高频误猜 flag，hint 必须直接给出正确用法
	root := &cobra.Command{Use: "tabtin"}
	browser := &cobra.Command{Use: "browser"}
	root.AddCommand(browser)
	subcommands := map[string]*cobra.Command{}
	for _, name := range []string{"nav", "eval", "wait", "print"} {
		c := &cobra.Command{Use: name}
		browser.AddCommand(c)
		subcommands[name] = c
	}

	cases := []struct {
		cmd     string
		badFlag string
		want    string
	}{
		{"nav", "--url", "tabtin browser open --url"},
		{"eval", "--script", "--expression"},
		{"eval", "--code", "--expression"},
		{"wait", "--until", "--selector"},
		{"print", "--selector", "glance --selector"},
	}
	for _, tc := range cases {
		t.Run(tc.cmd+" "+tc.badFlag, func(t *testing.T) {
			hint := buildFlagErrorHint(subcommands[tc.cmd], errUnknownFlag(tc.badFlag))
			if !strings.Contains(hint, tc.want) {
				t.Fatalf("hint = %q, want %q", hint, tc.want)
			}
		})
	}
}

func TestParseUnknownFlagName(t *testing.T) {
	got, ok := parseUnknownFlagName("unknown flag: --document-id")
	if !ok || got != "document-id" {
		t.Fatalf("parse = (%q, %v), want document-id true", got, ok)
	}
}

func TestFlagErrorHandlerEmitsEnvelope(t *testing.T) {
	root := &cobra.Command{
		Use:           "tabtin",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	cmd := &cobra.Command{
		Use:     "demo",
		Short:   "演示命令",
		Example: "  tabtin demo --name Alice",
		RunE:    func(cmd *cobra.Command, args []string) error { return nil },
	}
	cmd.Flags().String("name", "", "姓名")
	root.AddCommand(cmd)
	registerFlagErrorHandler(root)

	stderr := captureStderr(t, func() {
		root.SetArgs([]string{"demo", "--bad-flag", "x"})
		_ = root.Execute()
	})

	if !strings.Contains(stderr, `"ok": false`) {
		t.Fatalf("stderr = %q, want JSON error envelope", stderr)
	}
	if !strings.Contains(stderr, "VALIDATION_ERROR") {
		t.Fatalf("stderr = %q, want VALIDATION_ERROR code", stderr)
	}
	if !strings.Contains(stderr, "tabtin demo --help") {
		t.Fatalf("stderr = %q, want help hint", stderr)
	}

	env := parseValidationEnvelope(t, stderr)
	for _, want := range []string{
		"Usage:",
		"tabtin demo [flags]",
		"Flags:",
		"--name string",
		"tabtin demo --name Alice",
	} {
		if !strings.Contains(env.Error.Detail.Help, want) {
			t.Fatalf("help detail = %q, want %q", env.Error.Detail.Help, want)
		}
	}
}

func TestArgsUsageErrorHandlerEmitsHelpDetail(t *testing.T) {
	root := &cobra.Command{
		Use:           "tabtin",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	cmd := &cobra.Command{
		Use:  "read <document-id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error { return nil },
	}
	root.AddCommand(cmd)
	registerFlagErrorHandler(root)

	stderr := captureStderr(t, func() {
		root.SetArgs([]string{"read"})
		_ = root.Execute()
	})

	env := parseValidationEnvelope(t, stderr)
	if !strings.Contains(env.Error.Message, "accepts 1 arg") {
		t.Fatalf("message = %q, want cobra args error", env.Error.Message)
	}
	if !strings.Contains(env.Error.Detail.Help, "tabtin read <document-id> [flags]") {
		t.Fatalf("help detail = %q, want read command help", env.Error.Detail.Help)
	}
}

func TestRegisterFlagErrorHandlerCanCoverLateCommands(t *testing.T) {
	root := &cobra.Command{
		Use:           "tabtin",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	registerFlagErrorHandler(root)

	cmd := &cobra.Command{
		Use:  "extension-cmd",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error { return nil },
	}
	cmd.Flags().Bool("known", false, "known flag")
	root.AddCommand(cmd)
	registerFlagErrorHandler(root)

	stderr := captureStderr(t, func() {
		root.SetArgs([]string{"extension-cmd", "--bad-flag"})
		_ = root.Execute()
	})

	env := parseValidationEnvelope(t, stderr)
	if !strings.Contains(env.Error.Hint, "tabtin extension-cmd --help") {
		t.Fatalf("hint = %q, want late command help path", env.Error.Hint)
	}
	if !strings.Contains(env.Error.Detail.Help, "tabtin extension-cmd [flags]") {
		t.Fatalf("help detail = %q, want late command help", env.Error.Detail.Help)
	}
}

func TestRootFallbackEmitsHelpForRequiredFlagError(t *testing.T) {
	root := &cobra.Command{
		Use:           "tabtin",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	cmd := &cobra.Command{
		Use:  "publish",
		RunE: func(cmd *cobra.Command, args []string) error { return nil },
	}
	cmd.Flags().String("bundle", "", "bundle path")
	_ = cmd.MarkFlagRequired("bundle")
	root.AddCommand(cmd)
	registerFlagErrorHandler(root)

	stderr := captureStderr(t, func() {
		root.SetArgs([]string{"publish"})
		executedCmd, err := root.ExecuteContextC(context.Background())
		if err != nil {
			if executedCmd == nil {
				executedCmd = root
			}
			_ = handleCommandExecutionError(executedCmd, err)
		}
	})

	env := parseValidationEnvelope(t, stderr)
	if !strings.Contains(env.Error.Message, "required flag") {
		t.Fatalf("message = %q, want required flag error", env.Error.Message)
	}
	if !strings.Contains(env.Error.Detail.Help, "tabtin publish [flags]") {
		t.Fatalf("help detail = %q, want publish command help", env.Error.Detail.Help)
	}
}

func TestRootFallbackDoesNotTreatBusinessErrorAsUsageError(t *testing.T) {
	root := &cobra.Command{
		Use:           "tabtin",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	cmd := &cobra.Command{
		Use:  "sync",
		RunE: func(cmd *cobra.Command, args []string) error { return errors.New("backend unavailable") },
	}
	root.AddCommand(cmd)
	registerFlagErrorHandler(root)

	stderr := captureStderr(t, func() {
		root.SetArgs([]string{"sync"})
		executedCmd, err := root.ExecuteContextC(context.Background())
		if err != nil {
			if executedCmd == nil {
				executedCmd = root
			}
			_ = handleCommandExecutionError(executedCmd, err)
		}
	})

	env := parseErrorEnvelope(t, stderr)
	if env.Error.Code != "INTERNAL_ERROR" {
		t.Fatalf("code = %q, want INTERNAL_ERROR", env.Error.Code)
	}
	if env.Error.Detail.Help != "" {
		t.Fatalf("business error should not include usage help, got %q", env.Error.Detail.Help)
	}
}

type validationEnvelope struct {
	OK    bool `json:"ok"`
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Hint    string `json:"hint"`
		Detail  struct {
			Help string `json:"help"`
		} `json:"detail"`
	} `json:"error"`
}

func parseValidationEnvelope(t *testing.T, stderr string) validationEnvelope {
	t.Helper()
	var env validationEnvelope
	if err := json.Unmarshal([]byte(strings.TrimSpace(stderr)), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v\nstderr=%q", err, stderr)
	}
	if env.OK || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("envelope = %+v, want ok=false VALIDATION_ERROR", env)
	}
	return env
}

func parseErrorEnvelope(t *testing.T, stderr string) validationEnvelope {
	t.Helper()
	var env validationEnvelope
	if err := json.Unmarshal([]byte(strings.TrimSpace(stderr)), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v\nstderr=%q", err, stderr)
	}
	if env.OK {
		t.Fatalf("envelope = %+v, want ok=false", env)
	}
	return env
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	fn()
	_ = w.Close()
	os.Stderr = old
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatal(err)
	}
	_ = r.Close()
	return buf.String()
}

func errUnknownFlag(name string) error {
	return &flagErrorStub{msg: "unknown flag: " + name}
}

type flagErrorStub struct{ msg string }

func (e *flagErrorStub) Error() string { return e.msg }
