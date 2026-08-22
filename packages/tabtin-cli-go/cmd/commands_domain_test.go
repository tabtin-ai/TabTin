package cmd

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestFilterCommandSchemasByDomain(t *testing.T) {
	schemas := []cmdutil.CommandSchema{
		{Name: "doc list"},
		{Name: "doc create"},
		{Name: "table record list"},
		{Name: "browser open"},
		{Name: "doc"},
	}
	got := filterCommandSchemasByDomain(schemas, "doc")
	if len(got) != 3 {
		t.Fatalf("doc filter len=%d want 3: %+v", len(got), got)
	}
	got = filterCommandSchemasByDomain(schemas, "table")
	if len(got) != 1 || got[0].Name != "table record list" {
		t.Fatalf("table filter: %+v", got)
	}
	got = filterCommandSchemasByDomain(schemas, "")
	if len(got) != len(schemas) {
		t.Fatalf("empty domain should keep all")
	}
}
