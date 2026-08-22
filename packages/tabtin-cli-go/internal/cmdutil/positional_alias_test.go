package cmdutil

import (
	"testing"

	"github.com/spf13/cobra"
)

func TestCoalesceDocumentIDFromHiddenIDFlag(t *testing.T) {
	cmd := &cobra.Command{Use: "read <document-id>"}
	cmd.Flags().String("id", "", "hidden alias")
	if err := cmd.Flags().Set("id", "doc_abc"); err != nil {
		t.Fatal(err)
	}

	ctx := &RunContext{
		Args:       nil,
		FlagValues: map[string]any{"id": "doc_abc"},
	}
	def := CommandDef{ArgsMapping: []string{"document_id"}}

	coalescePositionalAliases(cmd, ctx, def)

	if len(ctx.Args) != 1 || ctx.Args[0] != "doc_abc" {
		t.Fatalf("args = %#v, want [doc_abc]", ctx.Args)
	}
	if _, ok := ctx.FlagValues["id"]; ok {
		t.Fatal("id should be removed from FlagValues after coalesce")
	}
}

func TestCoalesceDocumentIDDoesNotOverridePositional(t *testing.T) {
	cmd := &cobra.Command{Use: "read <document-id>"}
	cmd.Flags().String("id", "", "hidden alias")
	if err := cmd.Flags().Set("id", "from-flag"); err != nil {
		t.Fatal(err)
	}

	ctx := &RunContext{
		Args:       []string{"from-positional"},
		FlagValues: map[string]any{"id": "from-flag"},
	}
	def := CommandDef{ArgsMapping: []string{"document_id"}}

	coalescePositionalAliases(cmd, ctx, def)

	if ctx.Args[0] != "from-positional" {
		t.Fatalf("args[0] = %q, want from-positional", ctx.Args[0])
	}
}

func TestPositionalAliasFlagsForDocumentID(t *testing.T) {
	flags := positionalAliasFlags(CommandDef{ArgsMapping: []string{"document_id"}})
	if len(flags) != 2 {
		t.Fatalf("flags len = %d, want 2", len(flags))
	}
	if flags[0].Name != "id" || !flags[0].Hidden {
		t.Fatalf("first flag = %+v, want hidden id", flags[0])
	}
}
