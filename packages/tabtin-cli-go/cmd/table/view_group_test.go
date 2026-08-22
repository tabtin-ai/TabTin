package table

import (
	"encoding/json"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestValidateViewCreateGroupByExpandsGroups(t *testing.T) {
	ctx := &cmdutil.RunContext{
		FlagValues: map[string]any{
			"group-by-field-id": "f56fb0ef-f572-45e9-9f2e-8aec62b8fe5d",
		},
	}
	if err := validateViewCreateGroupBy(ctx); err != nil {
		t.Fatal(err)
	}
	if _, still := ctx.FlagValues["group-by-field-id"]; still {
		t.Fatal("group-by-field-id should be removed after expansion")
	}
	raw, ok := ctx.FlagValues["groups"].(string)
	if !ok || raw == "" {
		t.Fatalf("groups missing: %#v", ctx.FlagValues)
	}
	var groups []map[string]any
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 {
		t.Fatalf("groups len=%d", len(groups))
	}
	if groups[0]["field_id"] != "f56fb0ef-f572-45e9-9f2e-8aec62b8fe5d" {
		t.Fatalf("field_id=%v", groups[0]["field_id"])
	}
	if groups[0]["direction"] != "asc" {
		t.Fatalf("direction=%v", groups[0]["direction"])
	}
}

func TestValidateViewCreateGroupByNoopWithoutFlag(t *testing.T) {
	ctx := &cmdutil.RunContext{
		FlagValues: map[string]any{
			"groups": `[{"field_id":"x","direction":"desc"}]`,
		},
	}
	if err := validateViewCreateGroupBy(ctx); err != nil {
		t.Fatal(err)
	}
	if ctx.FlagValues["groups"] != `[{"field_id":"x","direction":"desc"}]` {
		t.Fatalf("groups mutated: %#v", ctx.FlagValues["groups"])
	}
}
