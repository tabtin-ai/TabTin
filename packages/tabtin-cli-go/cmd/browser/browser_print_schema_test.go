package browser

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestBrowserPrintRegistersSchemaFlag(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	printCmd, _, err := cmd.Find([]string{"print"})
	if err != nil {
		t.Fatalf("find print command: %v", err)
	}
	if printCmd == nil {
		t.Fatal("print command not found")
	}
	if printCmd.Flags().Lookup("schema") == nil {
		t.Fatal("print command should register --schema")
	}

	def := cmdutil.GetCommandDef(printCmd)
	if def == nil {
		t.Fatal("print command should have CommandDef")
	}
	found := false
	for _, flag := range def.Flags {
		if flag.Name == "schema" {
			found = true
			if flag.Type != cmdutil.FlagString {
				t.Fatalf("--schema flag type = %v, want string", flag.Type)
			}
		}
	}
	if !found {
		t.Fatal("print CommandDef should include schema flag")
	}
}

func TestBrowserPrintSchemaDryRunBodyUsesSchemaKey(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	cmd.PersistentFlags().Bool("dry-run", false, "")
	cmd.PersistentFlags().Bool("yes", false, "")
	cmd.PersistentFlags().String("batch", "", "")
	cmd.PersistentFlags().String("format", "json", "")

	schema := `{"type":"object","properties":{"title":{"type":"string"}}}`
	cmd.SetArgs([]string{"print", "--as", "json", "--url", "https://example.com", "--schema", schema, "--save", "/tmp/test-print.json", "--dry-run", "--format", "json"})

	stdout := captureStdout(t, func() {
		if err := cmd.Execute(); err != nil {
			t.Fatalf("dry-run execute failed: %v", err)
		}
	})

	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			Plan []struct {
				Body map[string]any `json:"body"`
			} `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("dry-run stdout should be JSON, got %q: %v", stdout, err)
	}
	if !envelope.OK || len(envelope.Data.Plan) != 1 {
		t.Fatalf("unexpected dry-run envelope: %+v", envelope)
	}

	body := envelope.Data.Plan[0].Body
	if _, ok := body["schema"]; !ok {
		t.Fatalf("dry-run body should include schema key, got %v", body)
	}
	if _, ok := body["schema_json"]; ok {
		t.Fatalf("dry-run body should not rename schema to schema_json: %v", body)
	}
	schemaBody, ok := body["schema"].(map[string]any)
	if !ok {
		t.Fatalf("schema body should be parsed JSON object, got %T: %v", body["schema"], body["schema"])
	}
	if schemaBody["type"] != "object" {
		t.Fatalf("schema.type = %v, want object", schemaBody["type"])
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe stdout: %v", err)
	}
	os.Stdout = w
	defer func() {
		os.Stdout = orig
	}()

	fn()

	if err := w.Close(); err != nil {
		t.Fatalf("close stdout writer: %v", err)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	return buf.String()
}
