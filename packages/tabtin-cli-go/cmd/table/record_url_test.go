package table

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const testRecordURL = "http://127.0.0.1:5175/table/529c0808-44c2-489f-baf2-71732bb7d76b/record/1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa"
const testRecordDeepLink = "tabtin://resource/table/529c0808-44c2-489f-baf2-71732bb7d76b?hint=tabdata&recordIds=1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa"

func TestRecordDetailAndUpdateAreAuthOnly(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	for _, path := range [][]string{{"record", "detail"}, {"record", "update"}} {
		sub, _, err := cmd.Find(path)
		if err != nil || sub == nil {
			t.Fatalf("%v command not found: %v", path, err)
		}
		def := cmdutil.GetCommandDef(sub)
		if def == nil {
			t.Fatalf("%v missing CommandDef", path)
		}
		if !def.RequiresAuth {
			t.Fatalf("%v should still require auth", path)
		}
		if def.RequiresAgent {
			t.Fatalf("%v must not require Agent — clipboard record links reuse Profile auth only", path)
		}
		if def.IncludeAgentID {
			t.Fatalf("%v must not inject agent_id", path)
		}
	}
}

func TestRecordDetailAcceptsRecordURLAsPositionalArgument(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	detailCmd, _, err := cmd.Find([]string{"record", "detail"})
	if err != nil || detailCmd == nil {
		t.Fatalf("record detail command not found: %v", err)
	}
	def := cmdutil.GetCommandDef(detailCmd)
	if def == nil || def.Validate == nil {
		t.Fatal("record detail should validate and normalize its record reference")
	}

	ctx := &cmdutil.RunContext{
		Args:       []string{testRecordURL},
		FlagValues: map[string]any{},
	}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("record URL should be accepted: %v", err)
	}
	if got := ctx.Str("record-id"); got != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
		t.Fatalf("record-id = %q", got)
	}
	if len(ctx.Args) != 0 {
		t.Fatalf("normalized URL should not leak into request args: %#v", ctx.Args)
	}
}

func TestRecordDetailAcceptsTabTinResourceDeepLink(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	detailCmd, _, err := cmd.Find([]string{"record", "detail"})
	if err != nil || detailCmd == nil {
		t.Fatalf("record detail command not found: %v", err)
	}
	def := cmdutil.GetCommandDef(detailCmd)

	ctx := &cmdutil.RunContext{
		Args:       []string{testRecordDeepLink},
		FlagValues: map[string]any{},
	}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("TabTin resource deep link should be accepted: %v", err)
	}
	if got := ctx.Str("record-id"); got != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
		t.Fatalf("record-id = %q", got)
	}
}

func TestRecordDetailAcceptsEnvironmentSpecificResourceDeepLinks(t *testing.T) {
	for _, scheme := range []string{"tabtin-preprod", "tabtin-dev"} {
		t.Run(scheme, func(t *testing.T) {
			raw := scheme + "://resource/table/529c0808-44c2-489f-baf2-71732bb7d76b?hint=tabdata&recordIds=1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa"
			ref, err := parseTabDataRecordURL(raw)
			if err != nil {
				t.Fatalf("%s resource deep link should be accepted: %v", scheme, err)
			}
			if ref.TableID != "529c0808-44c2-489f-baf2-71732bb7d76b" {
				t.Fatalf("table-id = %q", ref.TableID)
			}
			if ref.RecordID != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
				t.Fatalf("record-id = %q", ref.RecordID)
			}
		})
	}
}

func TestRecordUpdateAcceptsURLWithSet(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	updateCmd, _, err := cmd.Find([]string{"record", "update"})
	if err != nil || updateCmd == nil {
		t.Fatalf("record update command not found: %v", err)
	}
	if updateCmd.Flags().Lookup("url") == nil {
		t.Fatal("record update should expose --url")
	}
	def := cmdutil.GetCommandDef(updateCmd)
	if def == nil || def.Validate == nil {
		t.Fatal("record update should validate its record reference")
	}

	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"url": testRecordURL,
		"set": []string{"状态=完成"},
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("record URL with --set should be accepted: %v", err)
	}
	if got := ctx.Str("table-id"); got != "529c0808-44c2-489f-baf2-71732bb7d76b" {
		t.Fatalf("table-id = %q", got)
	}
	if got := ctx.Str("record-id"); got != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
		t.Fatalf("record-id = %q", got)
	}
	data, ok := ctx.FlagValues["data"].(map[string]any)
	if !ok || data["状态"] != "完成" {
		t.Fatalf("data = %#v", ctx.FlagValues["data"])
	}
	if _, exists := ctx.FlagValues["url"]; exists {
		t.Fatal("normalized URL should not be sent to the backend")
	}
}

func TestRecordUpdateAcceptsTabTinDeepLinkWithSet(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	updateCmd, _, err := cmd.Find([]string{"record", "update"})
	if err != nil || updateCmd == nil {
		t.Fatalf("record update command not found: %v", err)
	}
	def := cmdutil.GetCommandDef(updateCmd)

	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"url": testRecordDeepLink,
		"set": []string{"状态=完成"},
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("TabTin deep link with --set should be accepted: %v", err)
	}
	if got := ctx.Str("table-id"); got != "529c0808-44c2-489f-baf2-71732bb7d76b" {
		t.Fatalf("table-id = %q", got)
	}
	if got := ctx.Str("record-id"); got != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
		t.Fatalf("record-id = %q", got)
	}
	if _, exists := ctx.FlagValues["url"]; exists {
		t.Fatal("normalized deep link should not be sent to the backend")
	}
}

func TestRecordURLAllowsQueryAndTrailingSlash(t *testing.T) {
	ref, err := parseTabDataRecordURL(testRecordURL + "/?from=clipboard#record")
	if err != nil {
		t.Fatal(err)
	}
	if ref.TableID != "529c0808-44c2-489f-baf2-71732bb7d76b" || ref.RecordID != "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa" {
		t.Fatalf("ref = %#v", ref)
	}
}

func TestRecordUpdateRejectsMismatchedExplicitIDs(t *testing.T) {
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"url":       testRecordURL,
		"table-id":  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"record-id": "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa",
		"set":       []string{"状态=完成"},
	}}
	if err := validateRecordUpdateFlags(ctx); err == nil {
		t.Fatal("mismatched table-id should be rejected")
	}
}

func TestRecordUpdateKeepsExistingIDInterface(t *testing.T) {
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"table-id":  "529c0808-44c2-489f-baf2-71732bb7d76b",
		"record-id": "1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa",
		"set":       []string{"状态=完成"},
	}}
	if err := validateRecordUpdateFlags(ctx); err != nil {
		t.Fatalf("existing ID interface should remain valid: %v", err)
	}
}

func TestRecordURLRejectsNonRecordPaths(t *testing.T) {
	for _, raw := range []string{
		"not-a-url",
		"http://127.0.0.1:5175/table/529c0808-44c2-489f-baf2-71732bb7d76b",
		"http://127.0.0.1:5175/table/not-a-uuid/record/1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa",
	} {
		if _, err := parseTabDataRecordURL(raw); err == nil {
			t.Fatalf("invalid record URL should be rejected: %q", raw)
		}
	}
}

func TestTabTinDeepLinkRequiresExactlyOneRecord(t *testing.T) {
	base := "tabtin://resource/table/529c0808-44c2-489f-baf2-71732bb7d76b"
	for _, raw := range []string{
		base + "?hint=tabdata",
		base + "?recordIds=1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa&recordIds=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		base + "?recordIds=1652aeb3-5bc9-4ccb-a9ec-00fff389f0fa,aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	} {
		if _, err := parseTabDataRecordURL(raw); err == nil {
			t.Fatalf("multi-record or table-only deep link should be rejected: %q", raw)
		}
	}
}
