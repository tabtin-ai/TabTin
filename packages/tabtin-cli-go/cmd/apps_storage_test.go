package cmd

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestStorageFilesCommandsMounted(t *testing.T) {
	cmd := newCmdStorage(cmdutil.NewFactory())
	for _, path := range [][]string{
		{"files", "list"},
		{"files", "usages"},
		{"files", "batch-delete"},
	} {
		leaf, _, err := cmd.Find(path)
		if err != nil {
			t.Fatalf("find storage %v failed: %v", path, err)
		}
		if leaf == nil || leaf.RunE == nil {
			t.Fatalf("storage %v not executable", path)
		}
	}
}

func TestAdaptStorageBatchDelete(t *testing.T) {
	ctx := &cmdutil.RunContext{OrganizationID: "org-1"}
	method, path, body, err := adaptStorageBatchDelete(ctx, "POST", "/oss/storage/files/batch-delete", map[string]any{
		"organization_id": "org-1",
		"file_ids":        []string{"f1", "f2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" {
		t.Fatalf("method = %s", method)
	}
	if path != "/api/services/oss/storage/files/batch-delete?organization_id=org-1" {
		t.Fatalf("path = %s", path)
	}
	ids, ok := body["file_ids"].([]string)
	if !ok || len(ids) != 2 {
		t.Fatalf("body = %#v", body)
	}
}
