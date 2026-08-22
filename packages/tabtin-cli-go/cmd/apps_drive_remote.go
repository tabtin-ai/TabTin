package cmd

import (
	"fmt"
	"net/url"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func driveBodyString(body map[string]any, key string) string {
	if body == nil {
		return ""
	}
	v, ok := body[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

// ：云盘挂 Organization；AdaptRequest 用 organization_id，不再硬要求 space_id。
func requireDriveOrganizationID(ctx *cmdutil.RunContext, body map[string]any) (string, error) {
	orgID := driveBodyString(body, "organization_id")
	if orgID == "" && ctx != nil {
		orgID = ctx.OrganizationID
	}
	if orgID == "" {
		return "", fmt.Errorf("缺少 organization_id。请先 tabtin org use <id> 或设置 TABTIN_ORGANIZATION_ID")
	}
	return orgID, nil
}

func adaptDriveAttach(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	fileID := driveBodyString(body, "file_record_id")
	if fileID == "" {
		return "", "", nil, fmt.Errorf("缺少 file_record_id")
	}
	remoteBody := map[string]any{"file_record_id": fileID}
	if v := driveBodyString(body, "collection_id"); v != "" {
		remoteBody["collection_id"] = v
	}
	if v := driveBodyString(body, "title"); v != "" {
		remoteBody["title"] = v
	}
	return "POST", "/api/context/organizations/" + url.PathEscape(orgID) + "/files/upload", remoteBody, nil
}

func adaptDriveDownloadURL(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	itemID := driveBodyString(body, "item_id")
	if itemID == "" {
		return "", "", nil, fmt.Errorf("缺少 item_id")
	}
	return "GET", fmt.Sprintf("/api/context/organizations/%s/files/%s/download-url", url.PathEscape(orgID), url.PathEscape(itemID)), nil, nil
}

func adaptDriveList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	q.Set("item_type", "tabfiles")
	if v := driveBodyString(body, "page"); v != "" {
		q.Set("page", v)
	}
	if v := driveBodyString(body, "page_size"); v != "" {
		q.Set("page_size", v)
	}
	if v := driveBodyString(body, "collection_id"); v != "" {
		q.Set("collection_id", v)
	}
	remote := "/api/context/organizations/" + url.PathEscape(orgID) + "/context-items?" + q.Encode()
	return "GET", remote, nil, nil
}

func adaptDriveCollectionList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	return "GET", "/api/context/organizations/" + url.PathEscape(orgID) + "/collections", nil, nil
}

func adaptDriveCollectionCreate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	name := driveBodyString(body, "name")
	if name == "" {
		return "", "", nil, fmt.Errorf("缺少 name")
	}
	remoteBody := map[string]any{"name": name}
	if v := driveBodyString(body, "parent_id"); v != "" {
		remoteBody["parent_id"] = v
	}
	if v := driveBodyString(body, "icon"); v != "" {
		remoteBody["icon"] = v
	}
	return "POST", "/api/context/organizations/" + url.PathEscape(orgID) + "/collections", remoteBody, nil
}

func adaptDriveCollectionUpdate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	cid := driveBodyString(body, "collection_id")
	if cid == "" {
		return "", "", nil, fmt.Errorf("缺少 collection_id")
	}
	remoteBody := map[string]any{}
	if v := driveBodyString(body, "name"); v != "" {
		remoteBody["name"] = v
	}
	if v, ok := body["parent_id"]; ok {
		remoteBody["parent_id"] = v
	}
	if v := driveBodyString(body, "icon"); v != "" {
		remoteBody["icon"] = v
	}
	if len(remoteBody) == 0 {
		return "", "", nil, fmt.Errorf("至少提供 --name / --parent-id / --icon 之一")
	}
	return "PATCH", "/api/context/collections/" + url.PathEscape(cid), remoteBody, nil
}

func adaptDriveCollectionDelete(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	cid := driveBodyString(body, "collection_id")
	if cid == "" {
		return "", "", nil, fmt.Errorf("缺少 collection_id")
	}
	return "DELETE", "/api/context/collections/" + url.PathEscape(cid), nil, nil
}

func adaptDriveCollectionMoveItems(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	itemIDs, ok := body["item_ids"].([]any)
	if !ok || len(itemIDs) == 0 {
		if strs, ok := body["item_ids"].([]string); ok && len(strs) > 0 {
			converted := make([]any, len(strs))
			for i, s := range strs {
				converted[i] = s
			}
			itemIDs = converted
		}
	}
	if len(itemIDs) == 0 {
		return "", "", nil, fmt.Errorf("缺少 item_ids")
	}
	remoteBody := map[string]any{"item_ids": itemIDs}
	cid := driveBodyString(body, "collection_id")
	if cid == "" || cid == "root" || cid == "null" {
		remoteBody["collection_id"] = nil
	} else {
		remoteBody["collection_id"] = cid
	}
	return "POST", "/api/context/organizations/" + url.PathEscape(orgID) + "/collections/move-items", remoteBody, nil
}

func adaptDriveSharedWithMe(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	q := url.Values{}
	if orgID := driveBodyString(body, "organization_id"); orgID != "" {
		q.Set("organization_id", orgID)
	} else if ctx != nil && ctx.OrganizationID != "" {
		q.Set("organization_id", ctx.OrganizationID)
	}
	remote := "/api/context/files/shared-with-me"
	if enc := q.Encode(); enc != "" {
		remote += "?" + enc
	}
	return "GET", remote, nil, nil
}

func adaptDriveTrashList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	q.Set("item_type", "tabfiles")
	if v := driveBodyString(body, "page"); v != "" {
		q.Set("page", v)
	}
	if v := driveBodyString(body, "page_size"); v != "" {
		q.Set("page_size", v)
	}
	remote := "/api/context/organizations/" + url.PathEscape(orgID) + "/trash?" + q.Encode()
	return "GET", remote, nil, nil
}

func adaptDriveCollaboratorList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	fid, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	return "GET", "/api/context/files/" + url.PathEscape(fid) + "/collaborators", nil, nil
}

func adaptDriveCollaboratorInvite(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	fid, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	remoteBody := map[string]any{}
	if v, ok := body["user_ids"]; ok {
		remoteBody["user_ids"] = v
	}
	remoteBody["permission"] = "viewer"
	return "POST", "/api/context/files/" + url.PathEscape(fid) + "/collaborators", remoteBody, nil
}

func adaptDriveCollaboratorUpdate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	fid, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	uid := driveBodyString(body, "user_id")
	if uid == "" {
		return "", "", nil, fmt.Errorf("缺少 user_id")
	}
	return "PATCH", fmt.Sprintf("/api/context/files/%s/collaborators/%s", url.PathEscape(fid), url.PathEscape(uid)), map[string]any{"permission": "viewer"}, nil
}

func adaptDriveCollaboratorRevoke(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	fid, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	uid := driveBodyString(body, "user_id")
	if uid == "" {
		return "", "", nil, fmt.Errorf("缺少 user_id")
	}
	return "DELETE", fmt.Sprintf("/api/context/files/%s/collaborators/%s", url.PathEscape(fid), url.PathEscape(uid)), nil, nil
}

func requireDriveFileRecordID(body map[string]any) (string, error) {
	fileID := driveBodyString(body, "file_record_id")
	if fileID == "" {
		return "", fmt.Errorf("缺少 file_record_id（OSS FileRecord ID，不是 ContextItem id）")
	}
	return fileID, nil
}

func adaptDriveTrash(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	fileID, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	return "POST", fmt.Sprintf("/api/context/organizations/%s/files/%s/trash", url.PathEscape(orgID), url.PathEscape(fileID)), nil, nil
}

func adaptDriveRestore(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	fileID, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	// org 宿主路径是 /restore（workspace/space 别名才是 restore-from-trash）
	return "POST", fmt.Sprintf("/api/context/organizations/%s/files/%s/restore", url.PathEscape(orgID), url.PathEscape(fileID)), nil, nil
}

func adaptDrivePermanentDelete(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireDriveOrganizationID(ctx, body)
	if err != nil {
		return "", "", nil, err
	}
	fileID, err := requireDriveFileRecordID(body)
	if err != nil {
		return "", "", nil, err
	}
	return "DELETE", fmt.Sprintf("/api/context/organizations/%s/files/%s/permanent", url.PathEscape(orgID), url.PathEscape(fileID)), nil, nil
}
