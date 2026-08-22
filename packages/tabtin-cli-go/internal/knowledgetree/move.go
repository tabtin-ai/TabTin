// Package knowledgetree：知识库树（ContextItem.parent）CLI 共用逻辑。
// ：create 用 parent_item_id；变更挂靠走 PATCH /api/context/context-items/{id} 的 parent_id。
package knowledgetree

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

const maxResolvePages = 20

// ParentPatchBody 构造 PATCH body。root=true 时显式 parent_id=null（落根）；
// 否则写入 parentItemID。两者互斥由调用方保证。
func ParentPatchBody(parentItemID string, root bool) map[string]any {
	if root {
		return map[string]any{"parent_id": nil}
	}
	return map[string]any{"parent_id": parentItemID}
}

// PatchParent 把 ContextItem 挂到新父节点（或落根）。
func PatchParent(ctx context.Context, tr transport.Transport, itemID string, parentItemID string, root bool) (*transport.Response, error) {
	if strings.TrimSpace(itemID) == "" {
		return nil, fmt.Errorf("缺少 ContextItem ID")
	}
	if root == (strings.TrimSpace(parentItemID) != "") {
		return nil, fmt.Errorf("必须且只能指定 --parent-item-id 或 --root 之一")
	}
	path := "/api/context/context-items/" + url.PathEscape(itemID)
	return tr.Request(ctx, "PATCH", path, ParentPatchBody(parentItemID, root), nil)
}

// ResolveItemIDByResource 在 Organization 的 context-items 列表里按 resource_id 找 ContextItem.id。
// itemType 如 tabdoc / tabdata。
func ResolveItemIDByResource(
	ctx context.Context,
	tr transport.Transport,
	orgID, itemType, resourceID string,
) (string, error) {
	orgID = strings.TrimSpace(orgID)
	resourceID = strings.TrimSpace(resourceID)
	itemType = strings.TrimSpace(itemType)
	if orgID == "" {
		return "", fmt.Errorf("缺少 organization_id（请传全局 --organization-id）")
	}
	if resourceID == "" {
		return "", fmt.Errorf("缺少 resource_id")
	}
	if itemType == "" {
		return "", fmt.Errorf("缺少 item_type")
	}

	for page := 1; page <= maxResolvePages; page++ {
		q := url.Values{}
		q.Set("item_type", itemType)
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("page_size", "100")
		path := fmt.Sprintf(
			"/api/context/organizations/%s/context-items?%s",
			url.PathEscape(orgID),
			q.Encode(),
		)
		resp, err := tr.Request(ctx, "GET", path, nil, nil)
		if err != nil {
			return "", err
		}
		if resp.Status >= 400 {
			return "", fmt.Errorf("列出 context-items 失败（HTTP %d）", resp.Status)
		}

		items, total, pageSize, err := parseContextItemList(resp.Data)
		if err != nil {
			return "", err
		}
		for _, it := range items {
			if strings.EqualFold(strings.TrimSpace(it.ResourceID), resourceID) {
				if it.ID == "" {
					return "", fmt.Errorf("命中资源但 ContextItem.id 为空（resource_id=%s）", resourceID)
				}
				return it.ID, nil
			}
		}
		if len(items) == 0 || page*pageSize >= total {
			break
		}
	}
	return "", fmt.Errorf("未找到 item_type=%s resource_id=%s 对应的 ContextItem（请确认资源在当前 Organization）", itemType, resourceID)
}

type contextItemRow struct {
	ID         string `json:"id"`
	ResourceID string `json:"resource_id"`
}

func parseContextItemList(raw json.RawMessage) (items []contextItemRow, total, pageSize int, err error) {
	var envelope any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, 0, 0, fmt.Errorf("解析 context-items 响应失败: %w", err)
	}
	// Electron CLI Server 常再包一层 {ok,data:{ok|success,data:{items...}}}；最多剥 3 层。
	// UnwrapDjangoEnvelope 只认 success；Electron 用 ok 时改走 data 字段剥层。
	data := asMap(envelope)
	for i := 0; i < 3; i++ {
		if data == nil {
			break
		}
		if _, hasItems := data["items"]; hasItems {
			break
		}
		if _, hasSuccess := data["success"]; hasSuccess {
			if m := asMap(output.UnwrapDjangoEnvelope(data)); m != nil {
				data = m
				continue
			}
		}
		if nested := asMap(data["data"]); nested != nil {
			data = nested
			continue
		}
		break
	}
	if data == nil {
		return nil, 0, 0, fmt.Errorf("context-items 响应缺少 data")
	}
	if _, hasItems := data["items"]; !hasItems {
		return nil, 0, 0, fmt.Errorf("context-items 响应缺少 items（信封解析失败）")
	}

	total = anyToInt(data["total"])
	pageSize = anyToInt(data["page_size"])
	if pageSize <= 0 {
		pageSize = 100
	}

	rawItems, _ := data["items"].([]any)
	items = make([]contextItemRow, 0, len(rawItems))
	for _, row := range rawItems {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		items = append(items, contextItemRow{
			ID:         fmt.Sprint(m["id"]),
			ResourceID: fmt.Sprint(m["resource_id"]),
		})
	}
	return items, total, pageSize, nil
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func anyToInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	case string:
		var i int
		_, _ = fmt.Sscanf(n, "%d", &i)
		return i
	default:
		return 0
	}
}
