// Wave 3 / W3 — `tabtin pkg` 子命令族(L7).
//
// 6 个子命令对齐 Python CLI(`apps/tabtin_django/apps/services/agent_engine/cli/tabtin_cli/pkg.py`):
//
//	tabtin pkg publish <dir>                                # 发布目录为包
//	tabtin pkg install <ns>/<name>[@version]                # 安装包到本地
//	tabtin pkg list <ns>/<name>                             # 列出版本
//	tabtin pkg yank <ns>/<name>@<seq> --reason "..."        # 下架版本
//	tabtin pkg fork <src-ns>/<name> --to <tgt-ns>/<name>    # fork 包
//	tabtin pkg revert <ns>/<name> <seq>                     # revert 到 seq
//
// 全部 HTTP 端点统一前缀: `/api/services/package-registry/`。
//
// 设计要点:
//   - 复用 `cmdutil.Factory` / `transport` / `output` —— 与 doc/code/tracker 一致。
//   - publish 涉及多文件 SHA256 + OSS 直传(presigned PUT)+ init/finalize 多步:
//     OSS 直传不走 transport (presigned URL 是公网 URL,JWT 不参与) —— 直接用
//     net/http PUT,与 Python client 中 oss.upload_file_from_path 等价。
//   - install 同理,download_url 是 presigned GET,直接 net/http GET,带 SHA256 校验。
//   - 不引入新依赖 —— 全部用 stdlib(crypto/sha256 / encoding/hex / net/http / os / path/filepath)。
package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// pkgRouteBase 统一的 PR HTTP 路径前缀 —— urls_deferred.py:212 挂载点 + Ninja /api 前缀。
const pkgRouteBase = "/api/services/package-registry"

// pkgRefRe 匹配 `<namespace>/<name>[@<seq>]` —— 与 Python pkg.py:_parse_pkg_ref 同。
// namespace / name: 必须以小写字母或数字开头,后跟小写字母/数字/`.`/`_`/`-`。
var pkgRefRe = regexp.MustCompile(`^([a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9._-]*)(?:@(\d+))?$`)

// pkgIgnoredDirs / pkgIgnoredFiles / pkgIgnoredSuffixes / pkgSensitive*
// 与 client.py 模块顶部常量保持一致。Go 用 map[string]struct{} 充当 set。
var pkgIgnoredDirs = stringSet(
	"__pycache__", ".git", "node_modules", ".tox", ".mypy_cache",
	".pytest_cache", ".eggs", "dist", "build",
)

var pkgIgnoredFiles = stringSet(
	".DS_Store", "Thumbs.db", ".gitkeep",
)

var pkgIgnoredSuffixes = stringSet(
	".pyc", ".pyo", ".egg-info", ".so", ".dylib",
)

var pkgSensitivePatterns = stringSet(
	".env", ".env.local", ".env.production", ".env.development",
	"credentials.json", ".npmrc", ".yarnrc",
)

var pkgSensitiveExtensions = stringSet(
	".pem", ".key", ".p12", ".pfx", ".jks",
	".secret", ".secrets",
)

func stringSet(items ...string) map[string]struct{} {
	s := make(map[string]struct{}, len(items))
	for _, it := range items {
		s[it] = struct{}{}
	}
	return s
}

// pkgRef 解析后的包引用 —— version 为 nil 表示未指定。
type pkgRef struct {
	Namespace string
	Name      string
	Version   *int // nil 表示未指定 @seq
}

// parsePkgRef 解析 `<ns>/<name>[@<seq>]`。同 Python _parse_pkg_ref。
func parsePkgRef(ref string) (*pkgRef, error) {
	m := pkgRefRe.FindStringSubmatch(ref)
	if m == nil {
		return nil, fmt.Errorf("无效的包引用格式: %q,期望 <namespace>/<name>[@<version>]。"+
			"namespace 和 name 只能包含小写字母、数字、点、下划线和连字符", ref)
	}
	out := &pkgRef{Namespace: m[1], Name: m[2]}
	if m[3] != "" {
		v, _ := strconv.Atoi(m[3])
		out.Version = &v
	}
	return out, nil
}

// parseForkRef 解析 `<ns>/<name>` —— 不允许 @version。同 Python _parse_fork_ref。
func parseForkRef(ref string) (*pkgRef, error) {
	r, err := parsePkgRef(ref)
	if err != nil {
		return nil, err
	}
	if r.Version != nil {
		return nil, fmt.Errorf("无效的包引用格式: %q,期望 <namespace>/<name>(不带版本号)", ref)
	}
	return r, nil
}

// newCmdPkg 注册 `tabtin pkg` 命令族。在 root.go 中由 rootCmd.AddCommand(newCmdPkg(f)) 调用。
func newCmdPkg(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pkg",
		Short: "Package Registry 包管理(publish/install/list/yank/fork/revert)",
		Long: `Package Registry CLI — 管理包的发布、安装、版本和 fork。

示例:
  tabtin pkg publish ./my-skill --organization-id <wid>
  tabtin pkg install demo/hello@3
  tabtin pkg list demo/hello
  tabtin pkg yank demo/hello@2 --reason "broken"
  tabtin pkg fork demo/hello --to my-ns/hello --organization-id <wid>
  tabtin pkg revert demo/hello 3`,
	}

	cmd.AddCommand(newCmdPkgPublish(f))
	cmd.AddCommand(newCmdPkgInstall(f))
	cmd.AddCommand(newCmdPkgList(f))
	cmd.AddCommand(newCmdPkgYank(f))
	cmd.AddCommand(newCmdPkgFork(f))
	cmd.AddCommand(newCmdPkgRevert(f))

	// 统一注册到 `tabtin commands` schema —— 与 tracker 同模式(参考 root.go:148)。
	for _, child := range cmd.Commands() {
		cmdutil.RegisterCommandSchema(child, pkgChildSchema(child.Name()))
	}

	return cmd
}

// pkgChildSchema 为 6 个子命令各自暴露一份 CommandSchema 给 `tabtin commands`。
func pkgChildSchema(name string) cmdutil.CommandDef {
	switch name {
	case "publish":
		return cmdutil.CommandDef{
			Use:          "publish <directory>",
			Short:        "发布目录为包",
			Example:      "tabtin pkg publish ./my-skill --organization-id <wid>",
			Route:        cmdutil.RouteCliServer,
			Method:       "POST",
			Path:         pkgRouteBase + "/packages",
			Risk:         cmdutil.RiskWrite,
			HasFormat:    true,
			RequiresAuth: true,
			ArgsMapping:  []string{"directory"},
			Flags: []cmdutil.FlagDef{
				{Name: "namespace", Type: cmdutil.FlagString, Desc: "命名空间(默认从目录推断)"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "包名(默认从目录推断)"},
				{Name: "organization-id", Type: cmdutil.FlagString, Desc: "归属 Organization ID"},
				{Name: "version-label", Type: cmdutil.FlagString, Desc: "自定义版本标签(如 1.0.0)"},
			},
		}
	case "install":
		return cmdutil.CommandDef{
			Use:     "install <ns>/<name>[@seq]",
			Short:   "安装包到本地",
			Example: "tabtin pkg install demo/hello@3",
			Route:   cmdutil.RouteCliServer,
			Method:  "GET",
			Path:    pkgRouteBase + "/packages/{package_id}/versions/{seq}/files",
			// ：把包文件写入本地 ~/.tabtin/packages，属文件系统写。
			Risk:         cmdutil.RiskWrite,
			RiskDeclared: true,
			HasFormat:    true,
			RequiresAuth: true,
			Idempotent:   true,
			ArgsMapping:  []string{"package_ref"},
			Flags: []cmdutil.FlagDef{
				{Name: "target-dir", Type: cmdutil.FlagString,
					Desc: "安装目标目录(默认 ~/.tabtin/packages/<ns>/<name>/)"},
			},
		}
	case "list":
		return cmdutil.CommandDef{
			Use:          "list <ns>/<name>",
			Short:        "列出包的所有版本",
			Example:      "tabtin pkg list demo/hello",
			Route:        cmdutil.RouteCliServer,
			Method:       "GET",
			Path:         pkgRouteBase + "/packages/{package_id}/versions",
			HasFormat:    true,
			RequiresAuth: true,
			Idempotent:   true,
			ArgsMapping:  []string{"package_ref"},
		}
	case "yank":
		return cmdutil.CommandDef{
			Use:          "yank <ns>/<name>@<seq>",
			Short:        "下架指定版本",
			Example:      `tabtin pkg yank demo/hello@2 --reason "broken"`,
			Route:        cmdutil.RouteCliServer,
			Method:       "POST",
			Path:         pkgRouteBase + "/packages/{package_id}/versions/{seq}/yank",
			Risk:         cmdutil.RiskHigh,
			HasFormat:    true,
			RequiresAuth: true,
			ArgsMapping:  []string{"package_ref"},
			Flags: []cmdutil.FlagDef{
				{Name: "reason", Type: cmdutil.FlagString, Required: true, Desc: "下架原因"},
			},
		}
	case "fork":
		return cmdutil.CommandDef{
			Use:          "fork <src-ns>/<name> --to <tgt-ns>/<name>",
			Short:        "Fork 一个包到新命名空间",
			Example:      "tabtin pkg fork demo/hello --to my-ns/hello",
			Route:        cmdutil.RouteCliServer,
			Method:       "POST",
			Path:         pkgRouteBase + "/packages/{package_id}/fork",
			Risk:         cmdutil.RiskWrite,
			HasFormat:    true,
			RequiresAuth: true,
			ArgsMapping:  []string{"source_ref"},
			Flags: []cmdutil.FlagDef{
				{Name: "to", Type: cmdutil.FlagString, Required: true,
					Desc: "<target-namespace>/<target-name>"},
				{Name: "organization-id", Type: cmdutil.FlagString, Desc: "目标 Organization ID"},
				{Name: "at-version", Type: cmdutil.FlagInt, Desc: "只 fork 到指定版本(默认全部)"},
			},
		}
	case "revert":
		return cmdutil.CommandDef{
			Use:          "revert <ns>/<name> <seq>",
			Short:        "回滚到指定旧版本(创建新版本指向旧内容)",
			Example:      "tabtin pkg revert demo/hello 3",
			Route:        cmdutil.RouteCliServer,
			Method:       "POST",
			Path:         pkgRouteBase + "/packages/{package_id}/versions/{seq}/revert",
			Risk:         cmdutil.RiskHigh,
			HasFormat:    true,
			RequiresAuth: true,
			ArgsMapping:  []string{"package_ref", "seq"},
		}
	}
	return cmdutil.CommandDef{Use: name, Short: name}
}

// ─── Helpers: HTTP / JSON 解析 ──────────────────────────────────────

// pkgPostJSON / pkgGetJSON / pkgRequestParsed 是 PR HTTP 调用的辅助。
// 与 doc.go 中的模式一致(经过 transport)。
func pkgRequestParsed(ctx context.Context, tr transport.Transport, method, path string, body any) (map[string]any, int, error) {
	var rawBody map[string]any
	if body != nil {
		raw, _ := json.Marshal(body)
		_ = json.Unmarshal(raw, &rawBody)
	}
	resp, err := tr.Request(ctx, method, path, rawBody, nil)
	if err != nil {
		return nil, 0, err
	}
	if resp.Status >= 400 {
		var errData map[string]any
		_ = json.Unmarshal(resp.Data, &errData)
		msg := pkgErrorMessage(errData, resp.Status)
		return errData, resp.Status, fmt.Errorf("%s", msg)
	}
	var parsed map[string]any
	if err := json.Unmarshal(resp.Data, &parsed); err != nil {
		return nil, resp.Status, fmt.Errorf("解析响应失败: %v", err)
	}
	return parsed, resp.Status, nil
}

// pkgErrorMessage 从后端 envelope 中提取友好错误消息。
func pkgErrorMessage(errData map[string]any, status int) string {
	if errData != nil {
		if msg, ok := errData["message"].(string); ok && msg != "" {
			if code, ok := errData["code"].(string); ok && code != "" {
				return fmt.Sprintf("[%s] %s", code, msg)
			}
			return msg
		}
		if detail, ok := errData["detail"].(string); ok && detail != "" {
			return detail
		}
	}
	return fmt.Sprintf("请求失败 (status %d)", status)
}

// pkgMapStatusToCodeAndExit maps an HTTP status to an appropriate errcode
// and exit code pair, preserving domain precision in pkg error handling.
func pkgMapStatusToCodeAndExit(status int) (errcode.ErrorCode, int) {
	switch {
	case status == 401:
		return errcode.Unauthorized, output.ExitAuth
	case status == 403:
		return errcode.PermissionDenied, output.ExitPermission
	case status == 404:
		return errcode.NotFound, output.ExitNotFound
	case status == 409:
		return errcode.Conflict, output.ExitGeneral
	case status == 422 || status == 400:
		return errcode.ValidationError, output.ExitValidation
	case status == 429:
		return errcode.RateLimitExceeded, output.ExitTimeout
	case status == 502:
		return errcode.NetworkError, output.ExitServiceUnavail
	case status == 503:
		return errcode.Unavailable, output.ExitServiceUnavail
	case status == 504:
		return errcode.Timeout, output.ExitTimeout
	case status >= 500:
		return errcode.InternalError, output.ExitInternal
	default:
		return errcode.InternalError, output.ExitGeneral
	}
}

// pkgInnerData 从 success_response envelope 提取 .data 内层。
func pkgInnerData(parsed map[string]any) map[string]any {
	if parsed == nil {
		return nil
	}
	if d, ok := parsed["data"].(map[string]any); ok {
		return d
	}
	return parsed
}

// pkgLookup 调 GET /packages/lookup?namespace=X&name=Y,返回 package_id。
func pkgLookup(ctx context.Context, tr transport.Transport, namespace, name string) (string, map[string]any, error) {
	q := url.Values{"namespace": {namespace}, "name": {name}}
	path := pkgRouteBase + "/packages/lookup?" + q.Encode()
	parsed, status, err := pkgRequestParsed(ctx, tr, "GET", path, nil)
	if err != nil {
		if status == 404 {
			return "", nil, fmt.Errorf("LOOKUP_FAILED: 包 %s/%s 未找到", namespace, name)
		}
		return "", nil, err
	}
	inner := pkgInnerData(parsed)
	pid, _ := inner["package_id"].(string)
	if pid == "" {
		return "", inner, fmt.Errorf("响应缺少 package_id 字段")
	}
	return pid, inner, nil
}

// pkgListVersions 调 GET /packages/{id}/versions,返回 items 数组。
func pkgListVersions(ctx context.Context, tr transport.Transport, packageID string) ([]map[string]any, error) {
	path := pkgRouteBase + "/packages/" + packageID + "/versions"
	parsed, _, err := pkgRequestParsed(ctx, tr, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	inner := pkgInnerData(parsed)
	items, _ := inner["items"].([]any)
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// pkgResolveLatestAvailable 找最新非 yanked 的 version_seq。等价 client.py 同名方法。
func pkgResolveLatestAvailable(items []map[string]any, excludeSeq *int) (int, error) {
	// items 已按 -version_seq desc 排序(services.list_versions),仍保险 sort 一次。
	sort.Slice(items, func(i, j int) bool {
		return numFrom(items[i]["version_seq"]) > numFrom(items[j]["version_seq"])
	})
	for _, v := range items {
		seq := numFrom(v["version_seq"])
		if excludeSeq != nil && seq == *excludeSeq {
			continue
		}
		yanked, _ := v["is_yanked"].(bool)
		if yanked {
			continue
		}
		return seq, nil
	}
	return 0, fmt.Errorf("没有可用的(非下架)版本")
}

func numFrom(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case int64:
		return int(x)
	}
	return 0
}

// ─── publish ────────────────────────────────────────────────────────

func newCmdPkgPublish(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "publish <directory>",
		Short: "发布目录为包",
		Long: `把目录打包并发布为新版本。

流程: 扫描目录 → 计算每文件 SHA256 → POST /packages(创建/复用) →
POST /packages/{id}/versions/init(获取 presigned URL) →
PUT 上传缺失文件到 OSS → POST /packages/{id}/versions/{vid}/finalize。

示例:
  tabtin pkg publish ./my-skill --organization-id <wid>
  tabtin pkg publish ./skills/data-sync --namespace demo --name data-sync`,
		Args: cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgPublish(cmd, f, args[0])
		}),
	}
	cmd.Flags().String("namespace", "", "命名空间(默认从目录推断)")
	cmd.Flags().String("name", "", "包名(默认从目录推断)")
	cmd.Flags().String("organization-id", "", "归属 Organization ID(默认 profile / 环境变量)")
	cmd.Flags().String("version-label", "", "自定义版本标签(如 1.0.0)")
	return cmd
}

// pkgFile 扫描目录得到的单个文件元数据 —— 与 client.py:_scan_directory 等价。
type pkgFile struct {
	Path        string
	AbsPath     string
	SHA256      string
	Size        int64
	ContentType string
}

func runPkgPublish(cmd *cobra.Command, f *cmdutil.Factory, directory string) error {
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), fmt.Sprintf("目录不存在: %s", directory), "", output.ExitGeneral,
		))
	}

	ns, _ := cmd.Flags().GetString("namespace")
	name, _ := cmd.Flags().GetString("name")
	organizationID, _ := cmd.Flags().GetString("organization-id")
	versionLabel, _ := cmd.Flags().GetString("version-label")

	if ns == "" || name == "" {
		inferredNS, inferredName := pkgInferFromDir(directory)
		if ns == "" {
			ns = inferredNS
		}
		if name == "" {
			name = inferredName
		}
	}
	if !pkgRefRe.MatchString(ns + "/" + name) {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("推断/指定的 namespace=%q name=%q 不合法,请用 --namespace --name 显式指定", ns, name),
			"", output.ExitGeneral,
		))
	}

	if organizationID == "" {
		organizationID = firstNonEmpty(getEnv("TABTIN_ORGANIZATION_ID"), pkgProfileOrganization(f))
	}
	if organizationID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"需要 --organization-id 或设置 TABTIN_ORGANIZATION_ID / 当前 profile organization",
			"", output.ExitGeneral,
		))
	}

	// 1. 扫描目录
	files, err := pkgScanDir(directory)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
		))
	}
	if len(files) == 0 {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), fmt.Sprintf("目录为空或没有可发布的文件: %s", directory),
			"", output.ExitGeneral,
		))
	}

	tr, err := requireCliServerTransport(f, "pkg publish")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	// 2. lookup 或 create Package
	packageID, _, lookupErr := pkgLookup(reqCtx, tr, ns, name)
	if lookupErr != nil {
		// LOOKUP_FAILED → 创建新包
		body := map[string]any{
			"namespace":       ns,
			"name":            name,
			"organization_id": organizationID,
			"metadata":        pkgReadManifest(directory),
		}
		parsed, _, createErr := pkgRequestParsed(reqCtx, tr, "POST",
			pkgRouteBase+"/packages", body)
		if createErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), createErr.Error(), "", output.ExitGeneral,
			))
		}
		inner := pkgInnerData(parsed)
		packageID, _ = inner["package_id"].(string)
		if packageID == "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), "服务器未返回 package_id", "", output.ExitGeneral,
			))
		}
	}

	// 3. init_version —— 拿 upload_tasks(reuse / upload + presigned URL)
	initFiles := make([]map[string]any, 0, len(files))
	for _, fl := range files {
		initFiles = append(initFiles, map[string]any{
			"path":         fl.Path,
			"sha256":       fl.SHA256,
			"size":         fl.Size,
			"content_type": fl.ContentType,
		})
	}
	initBody := map[string]any{
		"files":    initFiles,
		"manifest": pkgReadManifest(directory),
	}
	if versionLabel != "" {
		initBody["version_label"] = versionLabel
	}
	parsed, _, initErr := pkgRequestParsed(reqCtx, tr, "POST",
		pkgRouteBase+"/packages/"+packageID+"/versions/init", initBody)
	if initErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), initErr.Error(), "", output.ExitGeneral,
		))
	}
	inner := pkgInnerData(parsed)
	versionID, _ := inner["version_id"].(string)
	uploadTasks, _ := inner["upload_tasks"].([]any)

	// 4. PUT 上传 action=upload 的文件到 presigned URL
	pathToAbs := make(map[string]string, len(files))
	pathToCT := make(map[string]string, len(files))
	for _, fl := range files {
		pathToAbs[fl.Path] = fl.AbsPath
		pathToCT[fl.Path] = fl.ContentType
	}
	for _, t := range uploadTasks {
		task, _ := t.(map[string]any)
		if task == nil {
			continue
		}
		action, _ := task["action"].(string)
		if action != "upload" {
			continue
		}
		path, _ := task["path"].(string)
		presigned, _ := task["presigned_url"].(string)
		abs, ok := pathToAbs[path]
		if !ok {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				fmt.Sprintf("init 返回的 path=%q 不在本地扫描列表中", path),
				"", output.ExitGeneral,
			))
		}
		if err := pkgPutFile(reqCtx, abs, presigned, pathToCT[path]); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				fmt.Sprintf("上传 %s 失败: %v", path, err),
				"", output.ExitGeneral,
			))
		}
	}

	// 5. finalize_version —— 计算 bundle_sha256(client/服务端必须一致)
	bundle := pkgComputeBundleSHA256(files)
	finalParsed, _, finalErr := pkgRequestParsed(reqCtx, tr, "POST",
		pkgRouteBase+"/packages/"+packageID+"/versions/"+versionID+"/finalize",
		map[string]any{"bundle_sha256": bundle})
	if finalErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), finalErr.Error(), "", output.ExitGeneral,
		))
	}
	finalInner := pkgInnerData(finalParsed)

	// 6. 输出
	result := map[string]any{
		"namespace":     ns,
		"name":          name,
		"package_id":    packageID,
		"version_seq":   numFrom(finalInner["version_seq"]),
		"version_label": finalInner["version_label"],
		"bundle_sha256": finalInner["bundle_sha256"],
		"file_count":    numFrom(finalInner["file_count"]),
		"total_size":    numFrom(finalInner["total_size"]),
	}
	output.PrintResult(output.SuccessEnvelope(result), f.Format)
	return nil
}

// pkgInferFromDir 从目录推断 namespace/name —— 等价 client.py:_infer_from_directory。
func pkgInferFromDir(dir string) (ns, name string) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	parts := strings.Split(filepath.ToSlash(abs), "/")
	for i, part := range parts {
		if part == "skills" && i >= 2 && i+1 < len(parts) {
			return strings.ToLower(parts[i-1]), strings.ToLower(parts[i+1])
		}
	}
	if len(parts) >= 2 {
		return strings.ToLower(parts[len(parts)-2]), strings.ToLower(parts[len(parts)-1])
	}
	return "default", strings.ToLower(filepath.Base(abs))
}

// pkgReadManifest 读取目录中的 manifest.json / SKILL.md 元数据。
func pkgReadManifest(dir string) map[string]any {
	mj := filepath.Join(dir, "manifest.json")
	if data, err := os.ReadFile(mj); err == nil {
		var m map[string]any
		if json.Unmarshal(data, &m) == nil {
			return m
		}
	}
	sk := filepath.Join(dir, "SKILL.md")
	if _, err := os.Stat(sk); err == nil {
		return map[string]any{"type": "skill", "source": "SKILL.md"}
	}
	return map[string]any{}
}

// pkgScanDir 扫描目录,跳过被忽略 / 敏感文件,计算每个文件 SHA256。
func pkgScanDir(dir string) ([]pkgFile, error) {
	base, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	var out []pkgFile
	err = filepath.WalkDir(base, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name := d.Name()
		if d.IsDir() {
			if path == base {
				return nil
			}
			if _, skip := pkgIgnoredDirs[name]; skip {
				return filepath.SkipDir
			}
			return nil
		}
		if pkgShouldIgnore(name) {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		sha, sz, err := pkgHashFile(path)
		if err != nil {
			return err
		}
		out = append(out, pkgFile{
			Path: rel, AbsPath: path,
			SHA256: sha, Size: sz,
			ContentType: pkgGuessContentType(name),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// pkgShouldIgnore 决定是否跳过文件 —— 与 client.py:_should_ignore 等价。
func pkgShouldIgnore(name string) bool {
	if _, ok := pkgIgnoredFiles[name]; ok {
		return true
	}
	if _, ok := pkgSensitivePatterns[name]; ok {
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	if _, ok := pkgIgnoredSuffixes[ext]; ok {
		return true
	}
	if _, ok := pkgSensitiveExtensions[ext]; ok {
		return true
	}
	if strings.HasPrefix(name, ".env") {
		return true
	}
	return false
}

// pkgHashFile 计算文件 SHA256 (hex) 与大小。
func pkgHashFile(path string) (string, int64, error) {
	fl, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer fl.Close()
	h := sha256.New()
	n, err := io.Copy(h, fl)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// W4-修3: content_type single source of truth — 后端 utils.CONTENT_TYPE_MAP 是真相,
// Go CLI 通过 GET /utils/content-types 端点 lazy fetch 一次缓存,fetch 失败时 fallback
// 到内置兜底。新扩展只改后端,无需两端各自抄写。

// pkgBuiltinContentTypeMap 是 Go 端内置兜底,与 utils.CONTENT_TYPE_MAP 应保持基本一致;
// 仅在后端端点不可达时使用(避免硬故障)。
var pkgBuiltinContentTypeMap = map[string]string{
	".md":   "text/markdown",
	".json": "application/json",
	".yaml": "text/yaml",
	".yml":  "text/yaml",
	".txt":  "text/plain",
	".py":   "text/x-python",
	".js":   "application/javascript",
	".mjs":  "application/javascript",
	".ts":   "application/typescript",
	".html": "text/html",
	".css":  "text/css",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".svg":  "image/svg+xml",
	".pdf":  "application/pdf",
	".zip":  "application/zip",
}

const pkgBuiltinContentTypeDefault = "application/octet-stream"

// pkgContentTypeCache 内存缓存(进程级)。nil 表示尚未尝试 fetch,empty map 表示 fetched。
type pkgContentTypeCacheT struct {
	mu      sync.Mutex
	loaded  bool
	mapping map[string]string
	def     string
}

var pkgContentTypeCache pkgContentTypeCacheT

// pkgFetchContentTypeMapURL 默认 fetch URL (本地 dev 通过 transport 走 cli-server)。
// 测试用 httptest.Server 时通过 pkgContentTypeFetchOverride 注入。
var pkgContentTypeFetchOverride func(ctx context.Context) (map[string]string, string, error)

// pkgGuessContentType 推断文件 content-type。优先用后端 SSoT,fetch 失败 fallback 到内置兜底。
func pkgGuessContentType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	pkgContentTypeCache.mu.Lock()
	defer pkgContentTypeCache.mu.Unlock()
	if !pkgContentTypeCache.loaded {
		// lazy fetch 一次
		pkgContentTypeCache.loaded = true
		if pkgContentTypeFetchOverride != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			m, def, err := pkgContentTypeFetchOverride(ctx)
			if err == nil && len(m) > 0 {
				pkgContentTypeCache.mapping = m
				pkgContentTypeCache.def = def
			}
		}
		// 无 override 或 fetch 失败 → fallback 到内置
		if pkgContentTypeCache.mapping == nil {
			pkgContentTypeCache.mapping = pkgBuiltinContentTypeMap
			pkgContentTypeCache.def = pkgBuiltinContentTypeDefault
		}
	}
	if v, ok := pkgContentTypeCache.mapping[ext]; ok {
		return v
	}
	if pkgContentTypeCache.def != "" {
		return pkgContentTypeCache.def
	}
	return pkgBuiltinContentTypeDefault
}

// pkgResetContentTypeCache 仅供测试调用 — 清空进程级缓存。
func pkgResetContentTypeCache() {
	pkgContentTypeCache.mu.Lock()
	pkgContentTypeCache.loaded = false
	pkgContentTypeCache.mapping = nil
	pkgContentTypeCache.def = ""
	pkgContentTypeCache.mu.Unlock()
}

// pkgSetContentTypeFetchOverride 仅供测试 — 注入自定义 fetcher。
// 生产代码不调用此函数;真实 fetch 由 cli-server 启动时通过 transport
// 拉一次填到全局 pkgContentTypeCache。
func pkgSetContentTypeFetchOverride(
	f func(ctx context.Context) (map[string]string, string, error),
) {
	pkgContentTypeFetchOverride = f
}

// pkgFetchContentTypesViaURL 默认 fetcher: 从给定 baseURL GET /utils/content-types,
// 解析 success_response envelope,返回 (map, default, error)。
func pkgFetchContentTypesViaURL(ctx context.Context, baseURL string) (map[string]string, string, error) {
	endpoint := strings.TrimRight(baseURL, "/") + pkgRouteBase + "/utils/content-types"
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "tabtin-pkg/0.1")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var parsed struct {
		Success bool `json:"success"`
		Data    struct {
			Map     map[string]string `json:"map"`
			Default string            `json:"default"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, "", fmt.Errorf("decode response: %w", err)
	}
	if !parsed.Success || len(parsed.Data.Map) == 0 {
		return nil, "", fmt.Errorf("invalid response shape")
	}
	return parsed.Data.Map, parsed.Data.Default, nil
}

// pkgComputeBundleSHA256 实现 services.compute_bundle_sha256 同 Merkle 算法。
// 排序 (path, sha256) by path,逐项 sha256.update("path:sha256") 拼成最终 digest。
func pkgComputeBundleSHA256(files []pkgFile) string {
	cp := make([]pkgFile, len(files))
	copy(cp, files)
	sort.Slice(cp, func(i, j int) bool {
		return cp[i].Path < cp[j].Path
	})
	h := sha256.New()
	for _, fl := range cp {
		h.Write([]byte(fl.Path + ":" + fl.SHA256))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// pkgPutFile 通过 presigned URL PUT 上传文件 —— 不带 JWT(presigned URL 自带签名)。
func pkgPutFile(ctx context.Context, localPath, presignedURL, contentType string) error {
	fl, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer fl.Close()
	info, err := fl.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "PUT", presignedURL, fl)
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = info.Size()

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("PUT %s: HTTP %d: %s", localPath, resp.StatusCode, string(body))
	}
	return nil
}

// pkgProfileOrganization 从 factory 里取 profile 默认 organization。
func pkgProfileOrganization(f *cmdutil.Factory) string {
	cfg, err := f.Config()
	if err != nil {
		return ""
	}
	return cfg.CurrentProfileConfig().DefaultOrganization
}

// ─── install ─────────────────────────────────────────────────────

func newCmdPkgInstall(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "install <ns>/<name>[@seq]",
		Short: "安装包到本地",
		Long: `从 Package Registry 下载包并解压到本地目录。

未指定 @seq 时安装最新非 yanked 版本。安装目标默认为 ~/.tabtin/packages/<ns>/<name>/。

示例:
  tabtin pkg install demo/hello
  tabtin pkg install demo/hello@3
  tabtin pkg install demo/hello@3 --target-dir ./packages/hello`,
		Args: cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgInstall(cmd, f, args[0])
		}),
	}
	cmd.Flags().String("target-dir", "", "安装目标目录(默认 ~/.tabtin/packages/<ns>/<name>/)")
	return cmd
}

func runPkgInstall(cmd *cobra.Command, f *cmdutil.Factory, ref string) error {
	r, err := parsePkgRef(ref)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
		))
	}

	tr, err := requireCliServerTransport(f, "pkg install")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	packageID, _, err := pkgLookup(reqCtx, tr, r.Namespace, r.Name)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound), err.Error(), "", output.ExitNotFound,
		))
	}

	var seq int
	if r.Version != nil {
		seq = *r.Version
	} else {
		items, listErr := pkgListVersions(reqCtx, tr, packageID)
		if listErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), listErr.Error(), "", output.ExitGeneral,
			))
		}
		latest, resolveErr := pkgResolveLatestAvailable(items, nil)
		if resolveErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound),
				fmt.Sprintf("包 %s/%s %s", r.Namespace, r.Name, resolveErr.Error()),
				"", output.ExitNotFound,
			))
		}
		seq = latest
	}

	// GET /packages/{id}/versions/{seq}/files
	filesPath := fmt.Sprintf("%s/packages/%s/versions/%d/files", pkgRouteBase, packageID, seq)
	parsed, status, fErr := pkgRequestParsed(reqCtx, tr, "GET", filesPath, nil)
	if fErr != nil {
		// 处理 410(yanked):指定版本时直接报错;未指定时回退到最新非 yanked。
		if status == 410 {
			if r.Version != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.NotFound),
					fmt.Sprintf("版本 %s/%s@%d 已被下架。用 `tabtin pkg list %s/%s` 查看可用版本",
						r.Namespace, r.Name, seq, r.Namespace, r.Name),
					"", output.ExitGeneral,
				))
			}
			// 不应到达 —— 上面已经过滤 yanked。但保险:重选一次。
			items, _ := pkgListVersions(reqCtx, tr, packageID)
			if alt, altErr := pkgResolveLatestAvailable(items, &seq); altErr == nil {
				seq = alt
				filesPath = fmt.Sprintf("%s/packages/%s/versions/%d/files", pkgRouteBase, packageID, seq)
				parsed, _, fErr = pkgRequestParsed(reqCtx, tr, "GET", filesPath, nil)
			}
			if fErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.NotFound), fErr.Error(), "", output.ExitGeneral,
				))
			}
		} else {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), fErr.Error(), "", output.ExitGeneral,
			))
		}
	}
	inner := pkgInnerData(parsed)
	rawFiles, _ := inner["files"].([]any)

	// 解析目标目录
	targetDir, _ := cmd.Flags().GetString("target-dir")
	if targetDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = os.TempDir()
		}
		targetDir = filepath.Join(home, ".tabtin", "packages", r.Namespace, r.Name)
	}
	absDest, err := filepath.Abs(targetDir)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), fmt.Sprintf("目标目录解析失败: %v", err), "", output.ExitGeneral,
		))
	}
	tmpDir := absDest + ".tmp_install"
	_ = os.RemoveAll(tmpDir)
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
		))
	}

	// 下载所有文件 + SHA 校验
	type downloaded struct {
		Path      string
		LocalPath string
		SHA256    string
	}
	var doneFiles []downloaded
	for _, rf := range rawFiles {
		ff, _ := rf.(map[string]any)
		if ff == nil {
			continue
		}
		path, _ := ff["path"].(string)
		dlURL, _ := ff["download_url"].(string)
		expectedSHA, _ := ff["sha256"].(string)
		dst, validateErr := pkgValidateInside(path, tmpDir)
		if validateErr != nil {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), validateErr.Error(), "", output.ExitGeneral,
			))
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
			))
		}
		if err := pkgGetFile(reqCtx, dlURL, dst); err != nil {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError),
				fmt.Sprintf("下载 %s 失败: %v", path, err),
				"", output.ExitGeneral,
			))
		}
		actualSHA, _, hashErr := pkgHashFile(dst)
		if hashErr != nil {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), hashErr.Error(), "", output.ExitGeneral,
			))
		}
		if actualSHA != expectedSHA {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("SHA256 校验失败 %s: expected=%s... actual=%s...",
					path, expectedSHA[:min(16, len(expectedSHA))], actualSHA[:min(16, len(actualSHA))]),
				"", output.ExitGeneral,
			))
		}
		doneFiles = append(doneFiles, downloaded{
			Path: path, LocalPath: dst, SHA256: actualSHA,
		})
	}

	// 原子替换:删除老目标 → rename
	if _, err := os.Stat(absDest); err == nil {
		if err := os.RemoveAll(absDest); err != nil {
			_ = os.RemoveAll(tmpDir)
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
			))
		}
	}
	if err := os.MkdirAll(filepath.Dir(absDest), 0o755); err != nil {
		_ = os.RemoveAll(tmpDir)
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
		))
	}
	if err := os.Rename(tmpDir, absDest); err != nil {
		_ = os.RemoveAll(tmpDir)
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
		))
	}

	resolvedSeq := numFrom(inner["version_seq"])
	versionLabel, _ := inner["version_label"].(string)
	resultFiles := make([]map[string]any, 0, len(doneFiles))
	for _, d := range doneFiles {
		resultFiles = append(resultFiles, map[string]any{
			"path":       d.Path,
			"local_path": d.LocalPath,
			"sha256":     d.SHA256,
		})
	}
	result := map[string]any{
		"namespace":     r.Namespace,
		"name":          r.Name,
		"version_seq":   resolvedSeq,
		"version_label": versionLabel,
		"target_dir":    targetDir,
		"files":         resultFiles,
	}

	output.PrintResult(output.SuccessEnvelope(result), f.Format)
	return nil
}

// pkgValidateInside 防御路径穿越:rel 不能是绝对路径或包含 ..。
func pkgValidateInside(rel, root string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", fmt.Errorf("拒绝不安全的文件路径: %q", rel)
	}
	cleaned := filepath.Clean(rel)
	if strings.HasPrefix(cleaned, "..") || strings.Contains(cleaned, "/../") || cleaned == ".." {
		return "", fmt.Errorf("拒绝不安全的文件路径: %q", rel)
	}
	abs, err := filepath.Abs(filepath.Join(root, cleaned))
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(abs, rootAbs+string(os.PathSeparator)) && abs != rootAbs {
		return "", fmt.Errorf("路径穿越检测: %q → %s", rel, abs)
	}
	return abs, nil
}

// pkgGetFileMaxRetries / pkgGetFileBaseBackoff: W4-修2 重试参数(对齐 Python
// client.py:_download_file maxRetries=3, backoff 1s/2s/4s)。
const (
	pkgGetFileMaxRetries   = 3
	pkgGetFileBaseBackoffS = 1 // 1s, 2s, 4s
)

// pkgGetFileNonRetryableErr: 4xx 业务错误立即 abort,不重试。
type pkgGetFileNonRetryableErr struct {
	StatusCode int
	Body       string
}

func (e *pkgGetFileNonRetryableErr) Error() string {
	return fmt.Sprintf("HTTP %d (non-retryable): %s", e.StatusCode, e.Body)
}

// pkgGetFile 从 presigned URL 下载到本地 —— 不带 JWT,与 PUT 同理。
//
// W4-修2: 加 retry/backoff,对齐 Python client.py:_download_file:
//   - 5xx / 网络错误:最多重试 3 次,backoff 1s, 2s, 4s
//   - 4xx 业务错误:立即 abort(presigned 过期 / 签名错误等不会重试改善)
func pkgGetFile(ctx context.Context, dlURL, dest string) error {
	var lastErr error
	for attempt := 0; attempt < pkgGetFileMaxRetries; attempt++ {
		err := pkgGetFileOnce(ctx, dlURL, dest)
		if err == nil {
			return nil
		}
		// 4xx 立即 abort(不可重试)
		var nonRetryable *pkgGetFileNonRetryableErr
		if errors.As(err, &nonRetryable) {
			return err
		}
		lastErr = err
		// 还有重试次数:backoff 后再来
		if attempt < pkgGetFileMaxRetries-1 {
			waitSec := 1 << attempt // 1, 2, 4
			fmt.Fprintf(
				os.Stderr,
				"[tabtin pkg] download retry %d/%d for %.80s (%s), wait %ds\n",
				attempt+1, pkgGetFileMaxRetries, dlURL, err, waitSec,
			)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(waitSec) * time.Second):
			}
		}
	}
	return lastErr
}

// pkgGetFileOnce 单次下载尝试。区分可重试 (5xx / 网络) 与不可重试 (4xx) 错误。
func pkgGetFileOnce(ctx context.Context, dlURL, dest string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", dlURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "tabtin-pkg/0.1")
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		// 网络错误 / 连接失败 — 可重试
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		// 5xx 服务端错误 — 可重试
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	if resp.StatusCode >= 400 {
		// 4xx 业务错误 — 不可重试
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &pkgGetFileNonRetryableErr{
			StatusCode: resp.StatusCode,
			Body:       string(body),
		}
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

// ─── list ───────────────────────────────────────────────────────

func newCmdPkgList(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <ns>/<name>",
		Short: "列出包的所有版本",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgList(cmd, f, args[0])
		}),
	}
	return cmd
}

func runPkgList(cmd *cobra.Command, f *cmdutil.Factory, ref string) error {
	r, err := parseForkRef(ref)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
		))
	}
	tr, err := requireCliServerTransport(f, "pkg list")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}
	packageID, _, lookupErr := pkgLookup(reqCtx, tr, r.Namespace, r.Name)
	if lookupErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound), lookupErr.Error(), "", output.ExitNotFound,
		))
	}
	items, listErr := pkgListVersions(reqCtx, tr, packageID)
	if listErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), listErr.Error(), "", output.ExitGeneral,
		))
	}
	output.PrintResult(output.SuccessEnvelope(map[string]any{
		"namespace": r.Namespace, "name": r.Name, "versions": items,
	}), f.Format)
	return nil
}

// ─── yank ───────────────────────────────────────────────────────

func newCmdPkgYank(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "yank <ns>/<name>@<seq>",
		Short: "下架指定版本",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgYank(cmd, f, args[0])
		}),
	}
	cmd.Flags().String("reason", "", "下架原因(必填)")
	_ = cmd.MarkFlagRequired("reason")
	return cmd
}

func runPkgYank(cmd *cobra.Command, f *cmdutil.Factory, ref string) error {
	r, err := parsePkgRef(ref)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
		))
	}
	if r.Version == nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"必须指定版本号,格式: <ns>/<name>@<seq>",
			"", output.ExitGeneral,
		))
	}
	reason, _ := cmd.Flags().GetString("reason")
	if strings.TrimSpace(reason) == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "--reason 不能为空", "", output.ExitGeneral,
		))
	}

	tr, err := requireCliServerTransport(f, "pkg yank")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}
	packageID, _, lookupErr := pkgLookup(reqCtx, tr, r.Namespace, r.Name)
	if lookupErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound), lookupErr.Error(), "", output.ExitNotFound,
		))
	}
	path := fmt.Sprintf("%s/packages/%s/versions/%d/yank", pkgRouteBase, packageID, *r.Version)
	parsed, status, yErr := pkgRequestParsed(reqCtx, tr, "POST", path, map[string]any{
		"reason": reason,
	})
	if yErr != nil {
		code, exit := pkgMapStatusToCodeAndExit(status)
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(code), yErr.Error(), "", exit,
		))
	}
	inner := pkgInnerData(parsed)
	out := map[string]any{
		"namespace":   r.Namespace,
		"name":        r.Name,
		"version_seq": *r.Version,
		"reason":      reason,
	}
	for k, v := range inner {
		out[k] = v
	}
	output.PrintResult(output.SuccessEnvelope(out), f.Format)
	return nil
}

// ─── fork ───────────────────────────────────────────────────────

func newCmdPkgFork(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "fork <src-ns>/<name>",
		Short: "Fork 一个包到新命名空间",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgFork(cmd, f, args[0])
		}),
	}
	cmd.Flags().String("to", "", "<target-namespace>/<target-name>(必填)")
	_ = cmd.MarkFlagRequired("to")
	cmd.Flags().String("organization-id", "", "目标 Organization ID(默认当前 profile)")
	cmd.Flags().Int("at-version", 0, "只 fork 到指定版本(默认全部)")
	return cmd
}

func runPkgFork(cmd *cobra.Command, f *cmdutil.Factory, srcRef string) error {
	src, err := parseForkRef(srcRef)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "source: "+err.Error(), "", output.ExitGeneral,
		))
	}
	to, _ := cmd.Flags().GetString("to")
	tgt, err := parseForkRef(to)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "target (--to): "+err.Error(), "", output.ExitGeneral,
		))
	}
	organizationID, _ := cmd.Flags().GetString("organization-id")
	if organizationID == "" {
		organizationID = firstNonEmpty(getEnv("TABTIN_ORGANIZATION_ID"), pkgProfileOrganization(f))
	}
	if organizationID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"需要 --organization-id 或设置 TABTIN_ORGANIZATION_ID 环境变量",
			"", output.ExitGeneral,
		))
	}
	atVersion, _ := cmd.Flags().GetInt("at-version")

	tr, err := requireCliServerTransport(f, "pkg fork")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}
	packageID, _, lookupErr := pkgLookup(reqCtx, tr, src.Namespace, src.Name)
	if lookupErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound), lookupErr.Error(), "", output.ExitNotFound,
		))
	}
	body := map[string]any{
		"target_namespace":       tgt.Namespace,
		"target_name":            tgt.Name,
		"target_organization_id": organizationID,
	}
	if atVersion > 0 {
		body["fork_at_version_seq"] = atVersion
	}
	parsed, status, fErr := pkgRequestParsed(reqCtx, tr, "POST",
		pkgRouteBase+"/packages/"+packageID+"/fork", body)
	if fErr != nil {
		code, exit := pkgMapStatusToCodeAndExit(status)
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(code), fErr.Error(), "", exit,
		))
	}
	inner := pkgInnerData(parsed)
	out := map[string]any{
		"source_namespace": src.Namespace,
		"source_name":      src.Name,
		"target_namespace": tgt.Namespace,
		"target_name":      tgt.Name,
	}
	for k, v := range inner {
		out[k] = v
	}
	output.PrintResult(output.SuccessEnvelope(out), f.Format)
	return nil
}

// ─── revert ────────────────────────────────────────────────────

func newCmdPkgRevert(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "revert <ns>/<name> <seq>",
		Short: "回滚到指定旧版本(创建新版本指向旧内容)",
		Long: `等价 git revert: **新建一个版本指向旧内容**,不删除任何东西。
ManagedSkill.version 字符串指针自动同步。

也支持 <ns>/<name>@<seq> 单参数形式(与 Python CLI 兼容)。

示例:
  tabtin pkg revert demo/hello 3
  tabtin pkg revert demo/hello@3`,
		Args: cobra.RangeArgs(1, 2),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runPkgRevert(cmd, f, args)
		}),
	}
	return cmd
}

func runPkgRevert(cmd *cobra.Command, f *cmdutil.Factory, args []string) error {
	var nsName string
	var seq int
	var hasSeq bool

	if len(args) == 1 {
		// 单参数形式 —— 必须含 @seq
		r, err := parsePkgRef(args[0])
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}
		if r.Version == nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				"必须指定版本号,格式: <ns>/<name>@<seq> 或 <ns>/<name> <seq>",
				"", output.ExitGeneral,
			))
		}
		nsName = r.Namespace + "/" + r.Name
		seq = *r.Version
		hasSeq = true
	} else {
		// 双参数形式: <ns>/<name> <seq>
		r, err := parseForkRef(args[0])
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}
		v, err := strconv.Atoi(args[1])
		if err != nil || v <= 0 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("seq 必须是正整数: %q", args[1]),
				"", output.ExitGeneral,
			))
		}
		nsName = r.Namespace + "/" + r.Name
		seq = v
		hasSeq = true
	}
	if !hasSeq {
		return fmt.Errorf("internal: hasSeq false")
	}
	parts := strings.SplitN(nsName, "/", 2)
	ns := parts[0]
	name := parts[1]

	tr, err := requireCliServerTransport(f, "pkg revert")
	if err != nil {
		return err
	}
	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}
	packageID, _, lookupErr := pkgLookup(reqCtx, tr, ns, name)
	if lookupErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NotFound), lookupErr.Error(), "", output.ExitNotFound,
		))
	}
	path := fmt.Sprintf("%s/packages/%s/versions/%d/revert", pkgRouteBase, packageID, seq)
	parsed, status, rErr := pkgRequestParsed(reqCtx, tr, "POST", path, nil)
	if rErr != nil {
		if status == 410 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound),
				fmt.Sprintf("目标版本 %s/%s@%d 已被下架,不能 revert。"+
					"用 `tabtin pkg list %s/%s` 查看可用版本",
					ns, name, seq, ns, name),
				"", output.ExitGeneral,
			))
		}
		code, exit := pkgMapStatusToCodeAndExit(status)
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(code), rErr.Error(), "", exit,
		))
	}
	inner := pkgInnerData(parsed)
	out := map[string]any{
		"namespace":          ns,
		"name":               name,
		"target_version_seq": seq,
	}
	for k, v := range inner {
		out[k] = v
	}
	output.PrintResult(output.SuccessEnvelope(out), f.Format)
	return nil
}

// min 是 Go 1.21+ 内置,但 helper 形式更显式。
// (本仓库 go.mod go 1.26,可直接用内置 min,但保留封装防止以后回退。)
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
