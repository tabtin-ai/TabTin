package table

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type tabDataRecordURL struct {
	TableID  string
	RecordID string
}

func isTabTinRecordScheme(scheme string) bool {
	switch scheme {
	case "tabtin", "tabtin-preprod", "tabtin-dev":
		return true
	default:
		return false
	}
}

func parseTabDataRecordURL(raw string) (tabDataRecordURL, error) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil {
		return tabDataRecordURL{}, fmt.Errorf("记录链接无效，应为 TabTin 记录页面 URL 或 tabtin:// 资源链接")
	}
	if isTabTinRecordScheme(parsed.Scheme) {
		return parseTabTinRecordDeepLink(parsed)
	}
	if parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return tabDataRecordURL{}, fmt.Errorf("记录链接无效，应为 TabTin 记录页面 URL 或 tabtin:// 资源链接")
	}
	return parseHTTPRecordURL(parsed)
}

func parseHTTPRecordURL(parsed *url.URL) (tabDataRecordURL, error) {
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) != 4 || segments[0] != "table" || segments[2] != "record" {
		return tabDataRecordURL{}, fmt.Errorf("记录链接路径无效，应为 /table/<table-id>/record/<record-id>")
	}
	if !uuidPattern.MatchString(segments[1]) {
		return tabDataRecordURL{}, fmt.Errorf("记录链接中的 table-id 无效: %q", segments[1])
	}
	if !uuidPattern.MatchString(segments[3]) {
		return tabDataRecordURL{}, fmt.Errorf("记录链接中的 record-id 无效: %q", segments[3])
	}

	return tabDataRecordURL{TableID: segments[1], RecordID: segments[3]}, nil
}

func parseTabTinRecordDeepLink(parsed *url.URL) (tabDataRecordURL, error) {
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if parsed.Host != "resource" || len(segments) != 2 || segments[0] != "table" {
		return tabDataRecordURL{}, fmt.Errorf("TabTin 记录链接应为 tabtin://resource/table/<table-id>?recordIds=<record-id>")
	}
	if !uuidPattern.MatchString(segments[1]) {
		return tabDataRecordURL{}, fmt.Errorf("记录链接中的 table-id 无效: %q", segments[1])
	}

	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return tabDataRecordURL{}, fmt.Errorf("TabTin 记录链接查询参数无效")
	}
	recordIDs := query["recordIds"]
	if len(recordIDs) != 1 || strings.Contains(recordIDs[0], ",") || !uuidPattern.MatchString(recordIDs[0]) {
		return tabDataRecordURL{}, fmt.Errorf("TabTin 记录链接必须通过 recordIds 指定恰好一条记录")
	}

	return tabDataRecordURL{TableID: segments[1], RecordID: recordIDs[0]}, nil
}

func normalizeRecordDetailRef(ctx *cmdutil.RunContext) error {
	recordID := strings.TrimSpace(ctx.Str("record-id"))
	recordURL := ""
	if len(ctx.Args) > 0 {
		recordURL = strings.TrimSpace(ctx.Args[0])
	}

	if recordID != "" && recordURL != "" {
		return fmt.Errorf("记录链接位置参数与 --record-id 不能同时使用")
	}
	if recordURL == "" {
		if recordID == "" {
			return fmt.Errorf("需要提供记录链接或 --record-id")
		}
		return nil
	}

	ref, err := parseTabDataRecordURL(recordURL)
	if err != nil {
		return err
	}
	ctx.FlagValues["record-id"] = ref.RecordID
	ctx.Args = nil
	return nil
}

func normalizeRecordUpdateURL(ctx *cmdutil.RunContext) error {
	raw := strings.TrimSpace(ctx.Str("url"))
	if raw == "" {
		return nil
	}
	if !isBlankFlag(ctx.FlagValues["records"]) {
		return fmt.Errorf("--url 仅支持单条更新，不能与 --records 同时使用")
	}

	ref, err := parseTabDataRecordURL(raw)
	if err != nil {
		return err
	}
	if tableID := strings.TrimSpace(ctx.Str("table-id")); tableID != "" && tableID != ref.TableID {
		return fmt.Errorf("--table-id 与记录链接中的 table-id 不一致")
	}
	if recordID := strings.TrimSpace(ctx.Str("record-id")); recordID != "" && recordID != ref.RecordID {
		return fmt.Errorf("--record-id 与记录链接中的 record-id 不一致")
	}

	ctx.FlagValues["table-id"] = ref.TableID
	ctx.FlagValues["record-id"] = ref.RecordID
	delete(ctx.FlagValues, "url")
	return nil
}
