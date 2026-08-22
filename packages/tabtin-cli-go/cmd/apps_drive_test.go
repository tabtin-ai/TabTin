package cmd

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newTestDriveCmd(t *testing.T) *cmdutil.Factory {
	t.Helper()
	return cmdutil.NewFactory()
}

func TestDriveTopLevelHelpSurfacesCollectionCreate(t *testing.T) {
	// ：一级 help / Example 须直接暴露空文件夹命令，避免两轮 --help 探索
	cmd := newCmdDrive(newTestDriveCmd(t))
	help := cmd.Long + "\n" + cmd.Example
	if !strings.Contains(help, `drive collection create --name`) {
		t.Fatalf("drive top-level help should mention collection create, got:\n%s", help)
	}
}

func TestDriveCommandsMounted(t *testing.T) {
	cmd := newCmdDrive(newTestDriveCmd(t))

	for _, path := range [][]string{
		{"upload"},
		{"upload-folder"},
		{"attach"},
		{"archive-from-chat"},
		{"download-url"},
		{"list"},
		{"collection", "list"},
		{"collection", "create"},
		{"collection", "update"},
		{"collection", "delete"},
		{"collection", "move-items"},
		{"shared-with-me"},
		{"trash-list"},
		{"collaborator", "list"},
		{"collaborator", "invite"},
		{"collaborator", "update"},
		{"collaborator", "revoke"},
	} {
		leaf, _, err := cmd.Find(path)
		if err != nil {
			t.Fatalf("find drive %v failed: %v", path, err)
		}
		if leaf == nil || leaf.Name() != path[len(path)-1] {
			t.Fatalf("expected to mount `drive %s`, got %v", path[len(path)-1], leaf)
		}
		if leaf.RunE == nil {
			t.Fatalf("`drive %s` has no RunE — would do nothing", path[len(path)-1])
		}
	}
}

func TestDriveCommandFlags(t *testing.T) {
	cmd := newCmdDrive(newTestDriveCmd(t))

	upload, _, err := cmd.Find([]string{"upload"})
	if err != nil {
		t.Fatalf("find upload failed: %v", err)
	}
	for _, name := range []string{"file-path", "collection-id", "title", "mime-type"} {
		if upload.Flags().Lookup(name) == nil {
			t.Fatalf("`drive upload` missing --%s", name)
		}
	}

	uploadFolder, _, err := cmd.Find([]string{"upload-folder"})
	if err != nil {
		t.Fatalf("find upload-folder failed: %v", err)
	}
	for _, name := range []string{"directory", "parent-collection-id"} {
		if uploadFolder.Flags().Lookup(name) == nil {
			t.Fatalf("`drive upload-folder` missing --%s", name)
		}
	}

	attach, _, err := cmd.Find([]string{"attach"})
	if err != nil {
		t.Fatalf("find attach failed: %v", err)
	}
	if attach.Flags().Lookup("file-record-id") == nil {
		t.Fatal("`drive attach` missing --file-record-id")
	}
	if attach.Flags().Lookup("title") == nil {
		t.Fatal("`drive attach` missing --title")
	}

	downloadURL, _, err := cmd.Find([]string{"download-url"})
	if err != nil {
		t.Fatalf("find download-url failed: %v", err)
	}
	if downloadURL.Flags().Lookup("item-id") == nil {
		t.Fatal("`drive download-url` missing --item-id")
	}

	list, _, err := cmd.Find([]string{"list"})
	if err != nil {
		t.Fatalf("find list failed: %v", err)
	}
	if list.Flags().Lookup("collection-id") == nil {
		t.Fatal("`drive list` missing --collection-id")
	}
}

func TestAdaptDriveUsesOrganizationPaths(t *testing.T) {
	ctx := &cmdutil.RunContext{OrganizationID: "org-1"}
	body := map[string]any{
		"organization_id": "org-1",
		"file_record_id":  "file-1",
		"item_id":         "item-1",
		"page":            "2",
		"page_size":       "20",
	}

	method, path, remoteBody, err := adaptDriveAttach(ctx, "POST", "/drive/attach", body)
	if err != nil {
		t.Fatalf("adaptDriveAttach: %v", err)
	}
	if method != "POST" || path != "/api/context/organizations/org-1/files/upload" {
		t.Fatalf("attach → %s %s", method, path)
	}
	if remoteBody["file_record_id"] != "file-1" {
		t.Fatalf("attach body = %#v", remoteBody)
	}

	method, path, _, err = adaptDriveDownloadURL(ctx, "POST", "/drive/download-url", body)
	if err != nil {
		t.Fatalf("adaptDriveDownloadURL: %v", err)
	}
	if method != "GET" || path != "/api/context/organizations/org-1/files/item-1/download-url" {
		t.Fatalf("download-url → %s %s", method, path)
	}

	method, path, _, err = adaptDriveList(ctx, "POST", "/drive/list", body)
	if err != nil {
		t.Fatalf("adaptDriveList: %v", err)
	}
	if method != "GET" {
		t.Fatalf("list method = %s", method)
	}
	if path != "/api/context/organizations/org-1/context-items?item_type=tabfiles&page=2&page_size=20" {
		t.Fatalf("list path = %s", path)
	}

	bodyWithFolder := map[string]any{
		"organization_id": "org-1",
		"collection_id":   "folder-1",
		"page":            "1",
		"page_size":       "10",
	}
	method, path, _, err = adaptDriveList(ctx, "POST", "/drive/list", bodyWithFolder)
	if err != nil {
		t.Fatalf("adaptDriveList collection: %v", err)
	}
	if path != "/api/context/organizations/org-1/context-items?collection_id=folder-1&item_type=tabfiles&page=1&page_size=10" {
		t.Fatalf("list+collection path = %s", path)
	}

	method, path, remoteBody, err = adaptDriveCollectionCreate(ctx, "POST", "/drive/collection/create", map[string]any{
		"organization_id": "org-1",
		"name":            "周报",
		"parent_id":       "parent-1",
	})
	if err != nil {
		t.Fatalf("adaptDriveCollectionCreate: %v", err)
	}
	if method != "POST" || path != "/api/context/organizations/org-1/collections" {
		t.Fatalf("collection create → %s %s", method, path)
	}
	if remoteBody["name"] != "周报" || remoteBody["parent_id"] != "parent-1" {
		t.Fatalf("collection create body = %#v", remoteBody)
	}

	method, path, _, err = adaptDriveTrashList(ctx, "POST", "/drive/trash-list", map[string]any{
		"organization_id": "org-1",
		"page":            "1",
		"page_size":       "20",
	})
	if err != nil {
		t.Fatalf("adaptDriveTrashList: %v", err)
	}
	if method != "GET" || path != "/api/context/organizations/org-1/trash?item_type=tabfiles&page=1&page_size=20" {
		t.Fatalf("trash-list → %s %s", method, path)
	}

	method, path, _, err = adaptDriveCollaboratorList(ctx, "POST", "/drive/collaborator/list", map[string]any{
		"file_record_id": "file-1",
	})
	if err != nil {
		t.Fatalf("adaptDriveCollaboratorList: %v", err)
	}
	if method != "GET" || path != "/api/context/files/file-1/collaborators" {
		t.Fatalf("collaborator list → %s %s", method, path)
	}

	method, path, remoteBody, err = adaptDriveCollaboratorInvite(ctx, "POST", "/drive/collaborator/invite", map[string]any{
		"file_record_id": "file-1",
		"user_ids":       []string{"user-1"},
		"permission":     "editor",
	})
	if err != nil {
		t.Fatalf("adaptDriveCollaboratorInvite: %v", err)
	}
	if method != "POST" || path != "/api/context/files/file-1/collaborators" || remoteBody["permission"] != "viewer" {
		t.Fatalf("collaborator invite should normalize to viewer: %s %s %#v", method, path, remoteBody)
	}

	method, path, remoteBody, err = adaptDriveCollaboratorUpdate(ctx, "POST", "/drive/collaborator/update", map[string]any{
		"file_record_id": "file-1",
		"user_id":        "user-1",
		"permission":     "admin",
	})
	if err != nil {
		t.Fatalf("adaptDriveCollaboratorUpdate: %v", err)
	}
	if method != "PATCH" || remoteBody["permission"] != "viewer" {
		t.Fatalf("collaborator update should normalize to viewer: %s %s %#v", method, path, remoteBody)
	}

	method, path, _, err = adaptDriveTrash(ctx, "POST", "/drive/trash", body)
	if err != nil {
		t.Fatalf("adaptDriveTrash: %v", err)
	}
	if method != "POST" || path != "/api/context/organizations/org-1/files/file-1/trash" {
		t.Fatalf("trash → %s %s", method, path)
	}

	method, path, _, err = adaptDriveRestore(ctx, "POST", "/drive/restore", body)
	if err != nil {
		t.Fatalf("adaptDriveRestore: %v", err)
	}
	if method != "POST" || path != "/api/context/organizations/org-1/files/file-1/restore" {
		t.Fatalf("restore → %s %s", method, path)
	}

	method, path, _, err = adaptDrivePermanentDelete(ctx, "POST", "/drive/permanent-delete", body)
	if err != nil {
		t.Fatalf("adaptDrivePermanentDelete: %v", err)
	}
	if method != "DELETE" || path != "/api/context/organizations/org-1/files/file-1/permanent" {
		t.Fatalf("permanent-delete → %s %s", method, path)
	}

	_, _, _, err = adaptDriveAttach(&cmdutil.RunContext{}, "POST", "/drive/attach", map[string]any{
		"file_record_id": "file-1",
	})
	if err == nil {
		t.Fatal("expected missing organization_id error")
	}
}

func TestDriveUploadRuntimeLocal(t *testing.T) {
	regs := cmdutil.GetRegisteredCommands()
	var uploadDef *cmdutil.CommandSchema
	var folderDef *cmdutil.CommandSchema
	for i := range regs {
		if regs[i].Name == "drive upload" {
			uploadDef = &regs[i]
		}
		if regs[i].Name == "drive upload-folder" {
			folderDef = &regs[i]
		}
	}
	if uploadDef == nil {
		// GetRegisteredCommands 可能需要先挂载；用 Factory 重新挂
		_ = newCmdDrive(newTestDriveCmd(t))
		regs = cmdutil.GetRegisteredCommands()
		for i := range regs {
			if regs[i].Name == "drive upload" {
				uploadDef = &regs[i]
			}
			if regs[i].Name == "drive upload-folder" {
				folderDef = &regs[i]
			}
		}
	}
	if uploadDef == nil {
		t.Fatal("drive upload not in registered commands")
	}
	if uploadDef.Runtime != string(cmdutil.RuntimeLocal) {
		t.Fatalf("drive upload runtime = %q, want local", uploadDef.Runtime)
	}
	if folderDef == nil {
		t.Fatal("drive upload-folder not in registered commands")
	}
	if folderDef.Runtime != string(cmdutil.RuntimeLocal) {
		t.Fatalf("drive upload-folder runtime = %q, want local", folderDef.Runtime)
	}
}
