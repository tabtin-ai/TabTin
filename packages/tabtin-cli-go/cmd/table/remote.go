package table

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func bodyString(body map[string]any, key string) string {
	if body == nil {
		return ""
	}
	v, ok := body[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}

func requireBodyString(body map[string]any, key, hint string) (string, error) {
	v := bodyString(body, key)
	if v == "" {
		if hint == "" {
			hint = fmt.Sprintf("缺少 %s", key)
		}
		return "", fmt.Errorf("%s", hint)
	}
	return v, nil
}

func parseJSONObject(raw string) (map[string]any, error) {
	if raw == "" {
		return nil, fmt.Errorf("JSON 为空")
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w", err)
	}
	return out, nil
}

func appendQuery(path string, q url.Values) string {
	if len(q) == 0 {
		return path
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + q.Encode()
}

func setQueryIfPresent(q url.Values, body map[string]any, key string) {
	if v := bodyString(body, key); v != "" {
		q.Set(key, v)
	}
}

func setQueryIntIfPresent(q url.Values, body map[string]any, key string) {
	if body == nil {
		return
	}
	v, ok := body[key]
	if !ok || v == nil {
		return
	}
	switch t := v.(type) {
	case int:
		q.Set(key, strconv.Itoa(t))
	case int64:
		q.Set(key, strconv.FormatInt(t, 10))
	case float64:
		q.Set(key, strconv.FormatInt(int64(t), 10))
	case string:
		if t != "" {
			q.Set(key, t)
		}
	default:
		q.Set(key, fmt.Sprintf("%v", t))
	}
}

// AdaptTableList: POST /table/list → GET /api/tabdata/organizations/{org}/tables（ org-only）
func AdaptTableList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireBodyString(body, "organization_id", "缺少 organization_id。请先设置组织或 TABTIN_ORGANIZATION_ID")
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	setQueryIntIfPresent(q, body, "page")
	setQueryIntIfPresent(q, body, "page_size")
	setQueryIfPresent(q, body, "search")
	if archived := bodyString(body, "archived"); archived != "" {
		q.Set("is_archived", archived)
	}
	remote := fmt.Sprintf("/api/tabdata/organizations/%s/tables", url.PathEscape(orgID))
	return "GET", appendQuery(remote, q), nil, nil
}

// adaptTableCreate: POST /table/create → POST /api/tabdata/organizations/{org}/tables（ org-only）
func adaptTableCreate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID, err := requireBodyString(body, "organization_id", "缺少 organization_id。请先设置组织或 TABTIN_ORGANIZATION_ID")
	if err != nil {
		return "", "", nil, err
	}
	remoteBody := map[string]any{
		"name": bodyString(body, "name"),
	}
	if v := bodyString(body, "description"); v != "" {
		remoteBody["description"] = v
	}
	if v := bodyString(body, "icon"); v != "" {
		remoteBody["icon"] = v
	}
	if v, ok := body["use_default_fields"]; ok {
		remoteBody["use_default_fields"] = v
	}
	//  / ：知识库树父节点（ContextItem.parent）；与 Document.parent 无关
	if v := bodyString(body, "parent_item_id"); v != "" {
		remoteBody["parent_item_id"] = v
	}
	return "POST", fmt.Sprintf("/api/tabdata/organizations/%s/tables", url.PathEscape(orgID)), remoteBody, nil
}

// adaptTableInfo: POST /table/info → GET /api/tabdata/tables/{id}
func adaptTableInfo(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	return "GET", "/api/tabdata/tables/" + url.PathEscape(tableID), nil, nil
}

// adaptRecordList: POST /table/records → GET /api/tabdata/tables/{id}/records
func adaptRecordList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	setQueryIntIfPresent(q, body, "page")
	setQueryIntIfPresent(q, body, "page_size")
	setQueryIfPresent(q, body, "search")
	setQueryIfPresent(q, body, "sort_by")
	setQueryIfPresent(q, body, "sort_order")
	setQueryIfPresent(q, body, "fields")
	setQueryIfPresent(q, body, "field_key_type")
	remote := "/api/tabdata/tables/" + url.PathEscape(tableID) + "/records"
	return "GET", appendQuery(remote, q), nil, nil
}

// adaptRecordDetail: POST /table/record-detail → GET /api/tabdata/records/{id}
func adaptRecordDetail(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	recordID, err := requireBodyString(body, "record_id", "缺少 record_id")
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	setQueryIfPresent(q, body, "field_key_type")
	return "GET", appendQuery("/api/tabdata/records/"+url.PathEscape(recordID), q), nil, nil
}

func coerceRecordData(body map[string]any) (map[string]any, error) {
	if body == nil {
		return nil, fmt.Errorf("缺少 record 数据（--data）")
	}
	// pipeline / @file 可能已把 JSON 解成 map，勿再用 fmt %v 当字符串解析。
	switch v := body["data"].(type) {
	case map[string]any:
		return v, nil
	case string:
		if strings.TrimSpace(v) == "" {
			return nil, fmt.Errorf("缺少 record 数据（--data）")
		}
		return parseJSONObject(v)
	case nil:
		return nil, fmt.Errorf("缺少 record 数据（--data）")
	default:
		return nil, fmt.Errorf("record 数据格式无效（需要 JSON 对象）")
	}
}

// adaptRecordInsert: POST /table/insert → POST /api/tabdata/records
func adaptRecordInsert(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	record, err := coerceRecordData(body)
	if err != nil {
		return "", "", nil, err
	}
	return "POST", "/api/tabdata/records", map[string]any{
		"table_id": tableID,
		"data":     record,
	}, nil
}

// adaptRecordUpdate: POST /table/update → PUT /api/tabdata/records/{id}
func adaptRecordUpdate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	if recordID := bodyString(body, "record_id"); recordID != "" {
		data, err := coerceRecordData(body)
		if err != nil {
			return "", "", nil, err
		}
		putBody := map[string]any{"data": data}
		if fkt := bodyString(body, "field_key_type"); fkt != "" {
			putBody["field_key_type"] = fkt
		}
		return "PUT", "/api/tabdata/records/" + url.PathEscape(recordID), putBody, nil
	}
	return "", "", nil, fmt.Errorf("远程模式暂仅支持单条更新（--record-id）；批量请使用 Desktop/Daemon")
}

// adaptRecordDelete: POST /table/delete → DELETE /api/tabdata/records/{id}
func adaptRecordDelete(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	if recordID := bodyString(body, "record_id"); recordID != "" {
		return "DELETE", "/api/tabdata/records/" + url.PathEscape(recordID), nil, nil
	}
	return "", "", nil, fmt.Errorf("远程模式暂仅支持单条删除（--record-id）；批量请使用 Desktop/Daemon")
}

// adaptFieldList: POST /table/fields → GET /api/tabdata/tables/{id}/fields
func adaptFieldList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	return "GET", "/api/tabdata/tables/" + url.PathEscape(tableID) + "/fields", nil, nil
}

// adaptFieldAdd: POST /table/add-field → POST /api/tabdata/fields
func adaptFieldAdd(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	fieldType := bodyString(body, "field_type")
	if !isUICreatableFieldType(fieldType) {
		return "", "", nil, fmt.Errorf("字段类型 %q 尚未在 TabData UI 开放，CLI 仅支持创建 UI 已展示的字段类型", fieldType)
	}
	remoteBody := map[string]any{
		"table_id":   tableID,
		"name":       bodyString(body, "name"),
		"field_type": fieldType,
	}
	if v := bodyString(body, "description"); v != "" {
		remoteBody["description"] = v
	}
	if raw := bodyString(body, "options"); raw != "" {
		opts, err := parseJSONObject(raw)
		if err != nil {
			return "", "", nil, fmt.Errorf("options: %w", err)
		}
		remoteBody["options"] = opts
	} else if opts, ok := body["options"].(map[string]any); ok {
		remoteBody["options"] = opts
	}
	return "POST", "/api/tabdata/fields", remoteBody, nil
}

func isUICreatableFieldType(fieldType string) bool {
	switch fieldType {
	case "text", "long_text",
		"number", "percent", "currency", "rating",
		"select", "multi_select", "checkbox",
		"date",
		"url", "email", "phone",
		"user",
		"attachment",
		"link":
		return true
	default:
		return false
	}
}

// adaptFieldDelete: POST /table/delete-field → DELETE /api/tabdata/fields/{id}
func adaptFieldDelete(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	fieldID, err := requireBodyString(body, "field_id", "缺少 field_id")
	if err != nil {
		return "", "", nil, err
	}
	return "DELETE", "/api/tabdata/fields/" + url.PathEscape(fieldID), nil, nil
}

// adaptLinkCreate: POST /table/link-create → POST /api/tabdata/fields
func adaptLinkCreate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	name, err := requireBodyString(body, "name", "缺少 name")
	if err != nil {
		return "", "", nil, err
	}
	foreign, err := requireBodyString(body, "foreign_table_id", "缺少 foreign_table_id")
	if err != nil {
		return "", "", nil, err
	}
	relationship := bodyString(body, "relationship")
	if relationship == "" {
		relationship = "ManyOne"
	}
	options := map[string]any{
		"foreignTableId": foreign,
		"relationship":   relationship,
		"isOneWay":       false,
	}
	if v, ok := body["one_way"]; ok {
		options["isOneWay"] = v
	} else if v, ok := body["is_one_way"]; ok {
		options["isOneWay"] = v
	}
	if v := bodyString(body, "lookup_field_id"); v != "" {
		options["lookupFieldId"] = v
	}
	if v := bodyString(body, "filter_by_view_id"); v != "" {
		options["filterByViewId"] = v
	}
	remoteBody := map[string]any{
		"table_id":   tableID,
		"name":       name,
		"field_type": "link",
		"options":    options,
	}
	if v := bodyString(body, "description"); v != "" {
		remoteBody["description"] = v
	}
	return "POST", "/api/tabdata/fields", remoteBody, nil
}

// adaptLinkUpdate: Django 直连下需先拉字段再合并 options——多步，暂要求 Desktop/Daemon。
func adaptLinkUpdate(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	return "", "", nil, fmt.Errorf("link update 需合并现有 options，远程 API 直连暂不支持；请使用 Desktop/Daemon，或 tabtin table field update --options '{...}'")
}

// adaptLinkSet: POST /table/link-set → PUT /api/tabdata/records/{id}
func adaptLinkSet(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	recordID, err := requireBodyString(body, "record_id", "缺少 record_id")
	if err != nil {
		return "", "", nil, err
	}
	fieldID, err := requireBodyString(body, "field_id", "缺少 field_id")
	if err != nil {
		return "", "", nil, err
	}
	if _, hasTargets := body["targets"]; !hasTargets {
		if _, hasCSV := body["target_ids"]; !hasCSV {
			return "", "", nil, fmt.Errorf("link set 必须显式传 --targets / --target-ids（清空请传 --targets '[]' 或 link remove --all）")
		}
	}
	ids, err := coerceLinkTargetIDs(body)
	if err != nil {
		return "", "", nil, err
	}
	writeVal := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		writeVal = append(writeVal, map[string]any{"id": id})
	}
	return "PUT", "/api/tabdata/records/" + url.PathEscape(recordID), map[string]any{
		"data":           map[string]any{fieldID: writeVal},
		"field_key_type": "id",
	}, nil
}

func adaptLinkAddRemoveDjangoHint(op string) cmdutil.AdaptRequestFunc {
	return func(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
		return "", "", nil, fmt.Errorf("link %s 需要读-改-写合并，远程 API 直连暂不支持；请使用 Desktop/Daemon，或先 link list 再 link set --targets 整格覆盖", op)
	}
}

// adaptLinkList: 直连返回整条 record（field_key_type=id）；Agent 可再取 field。
// cli-server 路径会裁剪为 target_ids 友好结构。
func adaptLinkList(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	recordID, err := requireBodyString(body, "record_id", "缺少 record_id")
	if err != nil {
		return "", "", nil, err
	}
	return "GET", "/api/tabdata/records/" + url.PathEscape(recordID) + "?field_key_type=id", nil, nil
}

func adaptLinkableRecords(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	fieldID, err := requireBodyString(body, "field_id", "缺少 field_id")
	if err != nil {
		return "", "", nil, err
	}
	q := url.Values{}
	setQueryIfPresent(q, body, "search")
	setQueryIfPresent(q, body, "search_field_id")
	setQueryIfPresent(q, body, "exclude_record_id")
	setQueryIntIfPresent(q, body, "page")
	setQueryIntIfPresent(q, body, "page_size")
	if v := bodyString(body, "selected_record_ids"); v != "" {
		q.Set("selected_record_ids", v)
	}
	if v, ok := body["only_selected"]; ok {
		switch t := v.(type) {
		case bool:
			if t {
				q.Set("only_selected", "true")
			}
		case string:
			if t == "true" || t == "1" {
				q.Set("only_selected", "true")
			}
		}
	}
	remote := fmt.Sprintf("/api/tabdata/tables/%s/fields/%s/linkable-records",
		url.PathEscape(tableID), url.PathEscape(fieldID))
	return "GET", appendQuery(remote, q), nil, nil
}

func adaptLinkableFields(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	tableID, err := requireBodyString(body, "table_id", "缺少 table_id")
	if err != nil {
		return "", "", nil, err
	}
	fieldID, err := requireBodyString(body, "field_id", "缺少 field_id")
	if err != nil {
		return "", "", nil, err
	}
	remote := fmt.Sprintf("/api/tabdata/tables/%s/fields/%s/linkable-fields",
		url.PathEscape(tableID), url.PathEscape(fieldID))
	return "GET", remote, nil, nil
}

func coerceLinkTargetIDs(body map[string]any) ([]string, error) {
	raw := body["targets"]
	if raw == nil || raw == "" {
		raw = body["target_ids"]
	}
	if raw == nil || raw == "" {
		return []string{}, nil
	}
	switch v := raw.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			switch t := item.(type) {
			case string:
				if strings.TrimSpace(t) != "" {
					out = append(out, strings.TrimSpace(t))
				}
			case map[string]any:
				if id, ok := t["id"].(string); ok && strings.TrimSpace(id) != "" {
					out = append(out, strings.TrimSpace(id))
				} else {
					return nil, fmt.Errorf("targets 元素必须是 UUID 或 {id}")
				}
			default:
				return nil, fmt.Errorf("targets 元素必须是 UUID 或 {id}")
			}
		}
		return out, nil
	case []string:
		return v, nil
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return []string{}, nil
		}
		if strings.HasPrefix(s, "[") {
			var arr []any
			if err := json.Unmarshal([]byte(s), &arr); err != nil {
				return nil, fmt.Errorf("targets JSON 解析失败: %w", err)
			}
			return coerceLinkTargetIDs(map[string]any{"targets": arr})
		}
		parts := strings.FieldsFunc(s, func(r rune) bool {
			return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n'
		})
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p != "" {
				out = append(out, p)
			}
		}
		return out, nil
	default:
		return nil, fmt.Errorf("targets 格式无效")
	}
}
