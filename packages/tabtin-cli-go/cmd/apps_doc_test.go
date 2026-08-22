// apps_doc_test.go — tabdoc CLI 命令树注册期 invariant + markdown warning helper 单测。
//
// 目的（cli-spec 收口 review A5 项）：把 cmdutil.MustRegisterCommand 注册期 panic
// 提前到 `go test` 触发。当前框架下，注册期断言（Layer/Risk/RiskDeclared/Long≥3/
// Example≥3/写命令 DryRun）只在跑 `./dist/tabtin --help` 这类 cobra 实际构造命令树
// 的路径才会触发——`go test` 默认不构造，refactor 静默 drop 命令 / 漏字段 / 写命令
// 忘补 DryRun 不会被 CI 抓到。本测试通过 newCmdDoc + 遍历叶子命令直接断言。
//
// 三条核心 invariant（与 cli-spec 铁律对齐）：
//  1. TestDocCommandsMounted：所有期望的命令路径都挂到 cobra 树（抓注册
//     顺序错乱 / 嵌套 group 漏挂 / refactor typo 如 version save → version-save）
//  2. TestDocAllRiskDeclared：所有叶子命令都设了 RiskDeclared:true（防"忘填 Risk
//     被默认为 RiskRead 绕过 dry-run 断言"）
//  3. TestDocWriteHasDryRun：所有写命令（Risk != RiskRead）声明了 DryRun 钩子
//     （cli-spec 铁律 3 的 unit test 镜像）
//
// 另外（A7）：TestDocMarkdownWarnings 单测 docMarkdownWarnings helper 的 3 类
// 静默 corruption 盲区检测——价格场景 $ 配对 / 未闭合 fence / 未注册 directive。
package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// newTestDocCmd 构造一棵 doc 命令树供单测断言。
// cmdutil.NewFactory() 即可——这些测试不发任何 HTTP / 不需要 auth，
// 只检查 cobra 树结构和注册期登记到 registeredCommands 的 CommandDef。
func newTestDocCmd(t *testing.T) *cobra.Command {
	t.Helper()
	f := cmdutil.NewFactory()
	return newCmdDoc(f)
}

// TestDocCommandsMounted 断言 doc 命令树挂了所有期望的命令路径（含 embed-table / insert-html / update-html）。
//
// 抓的失败模式：
//   - 注册顺序错乱（某个 def 没被遍历到 → 子命令未挂）
//   - 嵌套 group 漏挂（registerDocVersionCommands 等忘 parent.AddCommand(versionCmd)）
//   - refactor typo（version save → version-save / collaborator → collaborators）
//   - 命令命名误改（命中错误 cobra 节点）
//
// 用 cmd.Find(parts) 走原生 cobra 查找路径——子命令组的 .AddCommand 关系
// 都得正确，否则 Find 返回 err 或落到错误节点。
func TestDocCommandsMounted(t *testing.T) {
	cmd := newTestDocCmd(t)

	expected := []string{
		// 顶层（含  move）
		"list", "create", "move", "search", "search-blocks", "read", "chunks", "export",
		"delete", "list-blocks", "update", "save-content",
		// Block 级编辑（TD-3 +  read-section +  embed-table +  html +  image）
		"read-block", "read-section", "update-block", "format-text", "highlight-text", "insert-block", "delete-block", "append", "embed-table",
		"insert-image", "insert-html", "update-html",
		// 回收站 4 条
		"trash", "restore", "unarchive", "permanent-delete",
		// 版本子组 6 条
		"version list", "version preview", "version restore",
		"version save", "version rename", "version rm",
		// 协作者子组 4 条
		"collaborator list", "collaborator invite", "collaborator update", "collaborator rm",
		// 分享子组 4 条
		"share set", "share get", "share off", "share refresh",
		//  W4：权限覆盖 / 分享给我的（html-share 已随  移除）
		"perm get", "perm set",
		"shared-with-me",
		// 导入子组 + job 状态链 + 评论
		"import markdown", "import file",
		"import job status", "import job result", "import job retry", "import job cancel",
		"comment list", "comment create", "comment rm",
		"comment add", "comment reply", "comment resolve", "comment reopen", "comment reanchor",
	}
	for _, path := range expected {
		parts := strings.Split(path, " ")
		found, _, err := cmd.Find(parts)
		if err != nil || found == nil {
			t.Errorf("命令 %q 未挂到 cobra 树上: err=%v", path, err)
			continue
		}
		lastName := parts[len(parts)-1]
		if found.Name() != lastName {
			t.Errorf("命令 %q 挂到了错误的节点：want=%q, got=%q",
				path, lastName, found.Name())
		}
	}
}

func TestDocOverviewPromotesTitleAwareMarkdownWrites(t *testing.T) {
	cmd := newTestDocCmd(t)
	if !strings.Contains(cmd.Long, `tabtin doc create --title "周报" --markdown @.agent-drafts/weekly.md`) {
		t.Fatalf("doc 顶层说明必须优先展示 title 与正文一步写入，long=%q", cmd.Long)
	}
	if strings.Contains(cmd.Long, "save-content <document-id> --markdown @./draft.md") {
		t.Fatalf("doc 顶层说明不得再展示缺 title 上下文的整篇写入，long=%q", cmd.Long)
	}
}

func TestDocFormatTextExposesNativeToolbarCapabilities(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"format-text"})
	if err != nil || found == nil || found.Name() != "format-text" {
		t.Fatalf("doc format-text 未挂载: err=%v found=%v", err, found)
	}
	for _, name := range []string{
		"text", "bold", "italic", "underline", "strike", "code",
		"text-color", "background-color", "link-url", "remove-link",
	} {
		if found.Flags().Lookup(name) == nil {
			t.Errorf("format-text 缺少 --%s", name)
		}
	}
	def := cmdutil.GetCommandDef(found)
	if def == nil || def.DryRun == nil {
		t.Fatal("format-text 缺少 CommandDef 或 dry-run")
	}
	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"doc-1", "blk-1"},
		FlagValues: map[string]any{
			"text": "父子对话", "bold": "set", "background-color": "yellow",
		},
	})
	if plan == nil || len(plan.Plan) != 1 || plan.Plan[0].URL != "/api/tabdoc/documents/doc-1/blocks/blk-1/format-text" {
		t.Fatalf("format-text dry-run 路径错误: %#v", plan)
	}
	body, ok := plan.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("format-text dry-run body 类型错误: %#v", plan.Plan[0].Body)
	}
	if got, ok := body["background_color"]; !ok || got != "yellow" {
		t.Fatalf("format-text dry-run 未输出 background_color: %#v", body)
	}
	if got, ok := body["bold"]; !ok || got != true {
		t.Fatalf("format-text dry-run 未将 --bold set 转成布尔值: %#v", body)
	}
}

func TestDocInsertBlockDryRunSupportsDocumentStart(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"insert-block"})
	if err != nil || found == nil {
		t.Fatalf("doc insert-block 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(found)
	if def == nil || def.DryRun == nil {
		t.Fatal("doc insert-block 缺少 CommandDef 或 dry-run")
	}
	if conflicts := def.Conflicts["at-start"]; len(conflicts) != 1 || conflicts[0] != "after" {
		t.Fatalf("--at-start 必须与 --after 互斥: %#v", def.Conflicts)
	}

	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"doc_x"},
		FlagValues: map[string]any{
			"markdown": "文档导语",
			"at-start": true,
		},
	})
	if plan == nil || len(plan.Plan) != 1 {
		t.Fatalf("insert-block dry-run 异常: %#v", plan)
	}
	body, ok := plan.Plan[0].Body.(map[string]any)
	if !ok || body["at_start"] != true {
		t.Fatalf("顶部插入必须透传 at_start=true: %#v", plan.Plan[0].Body)
	}
}

// TestDocAllRiskDeclared 断言所有 doc 叶子命令都设了 RiskDeclared:true。
//
// 把注册期 MustRegisterCommand 的 panic 提前到 go test —— 避免新增命令忘加
// RiskDeclared 后只能通过实跑 ./dist/tabtin --help 才暴露。
// 兼容性：namespace 父命令（doc / doc version 等）走 GetCommandDef 返回 nil，
// 跳过（它们本来就不是 CommandDef，是手写 cobra.Command + AddCommand 挂的）。
func TestDocAllRiskDeclared(t *testing.T) {
	cmd := newTestDocCmd(t)
	leaves := walkLeafDocCommands(cmd)
	if len(leaves) == 0 {
		t.Fatal("doc 命令树叶子数为 0；命令注册可能完全失败")
	}
	for _, leaf := range leaves {
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Logf("跳过 %q（无关联 CommandDef，可能是 cobra 内置如 help/completion）", leaf.CommandPath())
			continue
		}
		if !def.RiskDeclared {
			t.Errorf("命令 %q 缺 RiskDeclared:true（MustRegisterCommand 注册期会 panic）",
				leaf.CommandPath())
		}
	}
}

// TestDocWriteHasDryRun 断言所有 doc 写命令（Risk != RiskRead）都声明了 DryRun 钩子。
//
// 这是 cli-spec 铁律 3 的 unit test 镜像 —— 写命令必须可 dry-run，否则 agent
// 在真实执行前没法预演，传 --dry-run 会撞 NOT_IMPLEMENTED 报错。
// MustRegisterCommand 注册期已断言（pipeline.go:166-168），本测试是静态镜像。
func TestDocWriteHasDryRun(t *testing.T) {
	cmd := newTestDocCmd(t)
	leaves := walkLeafDocCommands(cmd)
	for _, leaf := range leaves {
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			continue
		}
		if def.Risk != cmdutil.RiskRead && def.DryRun == nil {
			t.Errorf("写命令 %q（Risk=%q）缺 DryRun 钩子",
				leaf.CommandPath(), def.Risk)
		}
	}
}

// TestDocShowcaseRegistryComplete 断言每个 doc 叶子命令都在 showcase registry 或 hidden 闭集中登记。
func TestDocShowcaseRegistryComplete(t *testing.T) {
	cmd := newTestDocCmd(t)
	leaves := walkLeafDocCommands(cmd)
	for _, leaf := range leaves {
		rel := docRelativePath(leaf)
		if _, hidden := docShowcaseHidden[rel]; hidden {
			continue
		}
		if _, ok := docShowcaseRegistry[rel]; !ok {
			t.Errorf("doc 命令 %q 未登记 showcase 分组（加入 docShowcaseRegistry 或 docShowcaseHidden）", rel)
		}
	}
	for rel := range docShowcaseRegistry {
		parts := strings.Split(rel, " ")
		found, _, err := cmd.Find(parts)
		if err != nil || found == nil {
			t.Errorf("docShowcaseRegistry 引用不存在的命令 %q", rel)
		}
	}
}

// TestDocAIHelpRegistryComplete 断言每个 doc 叶子命令都在 docAIHelpRegistry 登记。
func TestDocAIHelpRegistryComplete(t *testing.T) {
	cmd := newTestDocCmd(t)
	for _, leaf := range walkLeafDocCommands(cmd) {
		rel := docRelativePath(leaf)
		if _, ok := docAIHelpRegistry[rel]; !ok {
			t.Errorf("doc 命令 %q 未登记 docAIHelpRegistry", rel)
		}
	}
	if len(docAIHelpRegistry) != len(docSkillCLIOrder) {
		t.Errorf("docAIHelpRegistry 数量=%d, docSkillCLIOrder=%d，应一致", len(docAIHelpRegistry), len(docSkillCLIOrder))
	}
	for rel := range docAIHelpRegistry {
		found := false
		for _, want := range docSkillCLIOrder {
			if want == rel {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("docAIHelpRegistry 有多余条目 %q", rel)
		}
	}
}

// TestDocAIHelpApplied 断言 registry 中的 Help 已写入 CommandDef.AIHelp。
func TestDocAIHelpApplied(t *testing.T) {
	cmd := newTestDocCmd(t)
	for _, leaf := range walkLeafDocCommands(cmd) {
		rel := docRelativePath(leaf)
		want, ok := docAIHelpRegistry[rel]
		if !ok {
			continue
		}
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatalf("命令 %q 无 CommandDef", rel)
		}
		if def.AIHelp != want.Help {
			t.Errorf("命令 %q AIHelp 与 registry 不一致", rel)
		}
	}
}

func TestDocAIHelpGuidesCloudDocumentFlow(t *testing.T) {
	createHelp := docAIHelpRegistry["create"].Help
	if !strings.Contains(createHelp, "生成文档/报告") {
		t.Fatalf("doc create AIHelp 应明确承接生成文档场景，got: %s", createHelp)
	}
	for _, want := range []string{
		"最终产物是云端文档",
		"Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时",
		"唯一允许 `write_file` 创建的路径",
		"工作区相对 `.agent-drafts/<slug>.md`",
		"`--markdown @.agent-drafts/<slug>.md` 上传",
		"不能汇报为本地交付",
	} {
		if !strings.Contains(createHelp, want) {
			t.Fatalf("doc create AIHelp 应同时说明云端最终产物与本地临时草稿边界，缺少 %q，got: %s", want, createHelp)
		}
	}

	readHelp := docAIHelpRegistry["read"].Help
	if !strings.Contains(readHelp, "current_doc_id") {
		t.Fatalf("doc read AIHelp 应提示可直接使用当前上下文文档 id，got: %s", readHelp)
	}
}

func TestDocListUsesBackendPaginationContract(t *testing.T) {
	cmd := newTestDocCmd(t)
	listCmd, _, err := cmd.Find([]string{"list"})
	if err != nil || listCmd == nil {
		t.Fatalf("doc list 命令不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(listCmd)
	if def == nil {
		t.Fatal("doc list 无 CommandDef")
	}

	flags := map[string]bool{}
	for _, flag := range def.Flags {
		flags[flag.Name] = true
	}
	for _, name := range []string{"page", "page-size"} {
		if !flags[name] {
			t.Fatalf("doc list 应暴露后端真实分页参数 %q，flags=%v", name, flags)
		}
	}
	for _, name := range []string{"limit", "offset"} {
		if flags[name] {
			t.Fatalf("doc list 不应继续暴露已与后端脱节的分页参数 %q，flags=%v", name, flags)
		}
	}
	if !strings.Contains(def.Long, "--page") || !strings.Contains(def.Long, "--page-size") {
		t.Fatalf("doc list Long 应说明 --page/--page-size，got: %s", def.Long)
	}
	if strings.Contains(def.Long, "--limit") || strings.Contains(def.Long, "--offset") {
		t.Fatalf("doc list Long 不应继续说明 --limit/--offset，got: %s", def.Long)
	}
}

func TestDocAIHelpNamesChunksBlobB64(t *testing.T) {
	chunksHelp := docAIHelpRegistry["chunks"].Help
	if !strings.Contains(chunksHelp, "blob_b64") {
		t.Fatalf("doc chunks AIHelp 应说明真实响应字段 blob_b64，got: %s", chunksHelp)
	}
	if strings.Contains(chunksHelp, " / blob）") {
		t.Fatalf("doc chunks AIHelp 不应再写 blob 字段，got: %s", chunksHelp)
	}

	cmd := newTestDocCmd(t)
	chunksCmd, _, err := cmd.Find([]string{"chunks"})
	if err != nil || chunksCmd == nil {
		t.Fatalf("doc chunks 命令不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(chunksCmd)
	if def == nil {
		t.Fatal("doc chunks 无 CommandDef")
	}
	if !strings.Contains(def.Long, "blob_b64") {
		t.Fatalf("doc chunks Long 应说明真实响应字段 blob_b64，got: %s", def.Long)
	}
	if strings.Contains(def.Long, " / blob ") {
		t.Fatalf("doc chunks Long 不应再写 blob 字段，got: %s", def.Long)
	}
}

func TestDocShareParentHelpMatchesOrganizationSupport(t *testing.T) {
	cmd := newTestDocCmd(t)
	shareCmd, _, err := cmd.Find([]string{"share"})
	if err != nil || shareCmd == nil {
		t.Fatalf("doc share 命令不存在: err=%v", err)
	}
	if strings.Contains(shareCmd.Long, "off/refresh 当前仅作用于 public") {
		t.Fatalf("doc share 父级 help 不应再误导 off/refresh 仅 public，got: %s", shareCmd.Long)
	}
	if !strings.Contains(shareCmd.Long, "acknowledge-public-exposure") {
		t.Fatalf("doc share 父级 help 应说明 public 须 --acknowledge-public-exposure，got: %s", shareCmd.Long)
	}
	if !strings.Contains(shareCmd.Long, "当前有效分享") {
		t.Fatalf("doc share 父级 help 应说明 get/off/refresh 可操作当前有效分享，got: %s", shareCmd.Long)
	}
}

func TestDocShareSetRequiresPublicExposureAckFlag(t *testing.T) {
	cmd := newTestDocCmd(t)
	setCmd, _, err := cmd.Find([]string{"share", "set"})
	if err != nil || setCmd == nil {
		t.Fatalf("doc share set 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(setCmd)
	if def == nil {
		t.Fatal("doc share set 无 CommandDef")
	}
	found := false
	for _, f := range def.Flags {
		if f.Name == "acknowledge-public-exposure" {
			found = true
			if f.Type != cmdutil.FlagBool {
				t.Fatalf("acknowledge-public-exposure 应为 FlagBool，got %v", f.Type)
			}
		}
	}
	if !found {
		t.Fatal("doc share set 缺少 --acknowledge-public-exposure")
	}
	if !strings.Contains(def.Long, "PUBLIC_EXPOSURE_ACK_REQUIRED") {
		t.Fatalf("doc share set Long 应说明 409 PUBLIC_EXPOSURE_ACK_REQUIRED，got: %s", def.Long)
	}
}

func TestDocShareGetOffRefreshOmitShareTypeDefault(t *testing.T) {
	cmd := newTestDocCmd(t)
	for _, path := range [][]string{{"share", "get"}, {"share", "off"}, {"share", "refresh"}} {
		sub, _, err := cmd.Find(path)
		if err != nil || sub == nil {
			t.Fatalf("doc %s 不存在: err=%v", strings.Join(path, " "), err)
		}
		def := cmdutil.GetCommandDef(sub)
		if def == nil {
			t.Fatalf("doc %s 无 CommandDef", strings.Join(path, " "))
		}
		for _, f := range def.Flags {
			if f.Name == "share-type" && f.Default != nil && f.Default != "" {
				t.Fatalf("doc %s --share-type 不应再默认 public，got Default=%v", strings.Join(path, " "), f.Default)
			}
		}
		if !strings.Contains(def.Long, "有效分享") {
			t.Fatalf("doc %s Long 应说明省略 --share-type 时操作有效分享，got: %s", strings.Join(path, " "), def.Long)
		}
	}
}

// TestDocAIHelpExportedInCommandsSchema tabtin commands JSON 应携带 ai_help。
func TestDocAIHelpExportedInCommandsSchema(t *testing.T) {
	newTestDocCmd(t)
	byName := map[string]cmdutil.CommandSchema{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		byName[schema.Name] = schema
	}
	for rel, entry := range docAIHelpRegistry {
		name := "doc " + rel
		schema, ok := byName[name]
		if !ok {
			t.Fatalf("命令 %q 不在 GetRegisteredCommands 输出", name)
		}
		if schema.AIHelp != entry.Help {
			t.Errorf("命令 %q JSON ai_help 与 registry 不一致", name)
		}
	}
}

// TestDocSkillCLISectionMarkdown 生成段应含表头与全部命令行。
func TestDocSkillCLISectionMarkdown(t *testing.T) {
	section := renderDocSkillCLISectionMarkdown()
	if !strings.Contains(section, docSkillCLISectionBegin) {
		t.Fatal("缺少 begin marker")
	}
	if !strings.Contains(section, docSkillCLISectionEnd) {
		t.Fatal("缺少 end marker")
	}
	for _, rel := range docSkillCLIOrder {
		entry := docAIHelpRegistry[rel]
		if !strings.Contains(section, entry.Invoke) {
			t.Errorf("生成段缺少 invoke %q", rel)
		}
	}
}

// TestExportDocSkillCLISectionToFile 供 scripts/generate-tabdoc-skill-section.py 导出。
func TestExportDocSkillCLISectionToFile(t *testing.T) {
	outPath := os.Getenv("TABDOC_SKILL_CLI_EXPORT")
	if outPath == "" {
		t.Skip("TABDOC_SKILL_CLI_EXPORT 未设置")
	}
	newTestDocCmd(t)
	content := renderDocSkillCLISectionMarkdown()
	if err := os.WriteFile(outPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}

// TestDocShowcaseApplied 断言 registry 中的命令都设了 Showcase=true + 对应 ShowcaseGroup。
func TestDocShowcaseApplied(t *testing.T) {
	cmd := newTestDocCmd(t)
	for _, leaf := range walkLeafDocCommands(cmd) {
		rel := docRelativePath(leaf)
		group, wantShowcase := docShowcaseRegistry[rel]
		if !wantShowcase {
			continue
		}
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatalf("命令 %q 无 CommandDef", rel)
		}
		if !def.Showcase {
			t.Errorf("命令 %q 应在 registry 中 Showcase=true", rel)
		}
		if def.ShowcaseGroup != group {
			t.Errorf("命令 %q ShowcaseGroup=%q, want %q", rel, def.ShowcaseGroup, group)
		}
	}
}

// TestDocFeaturedScenariosBindCLI featured 卡引用的命令必须存在于 CLI 导出且 showcase=true。
func TestDocFeaturedScenariosBindCLI(t *testing.T) {
	newTestDocCmd(t)
	showcaseNames := map[string]bool{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		if schema.Showcase {
			showcaseNames[schema.Name] = true
		}
	}
	for _, scenario := range docFeaturedScenarios {
		if len(scenario.Commands) == 0 {
			t.Errorf("featured %q 缺 commands 绑定", scenario.Key)
			continue
		}
		for _, name := range scenario.Commands {
			if !showcaseNames[name] {
				t.Errorf("featured %q 引用 %q，但该命令不在 showcase CLI 导出中", scenario.Key, name)
			}
		}
	}
}

// TestDocShowcaseManifestExport 生成 manifest 结构完整性（CI + generate 脚本共用逻辑）。
func TestDocShowcaseManifestExport(t *testing.T) {
	newTestDocCmd(t)
	manifest := buildDocShowcaseManifest()
	if len(manifest.Groups) != len(docShowcaseGroupOrder) {
		t.Fatalf("groups 数量=%d, want %d", len(manifest.Groups), len(docShowcaseGroupOrder))
	}
	if len(manifest.Commands) != len(docShowcaseRegistry) {
		t.Fatalf("commands 数量=%d, want %d", len(manifest.Commands), len(docShowcaseRegistry))
	}
	if len(manifest.Featured) != len(docFeaturedScenarios) {
		t.Fatalf("featured 数量=%d, want %d", len(manifest.Featured), len(docFeaturedScenarios))
	}
	raw, err := marshalDocShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if len(raw) < 100 {
		t.Fatalf("manifest JSON 过短")
	}
}

// TestExportDocShowcaseManifestToFile 供 scripts/generate-tabdoc-capabilities.py 导出落盘 JSON。
func TestExportDocShowcaseManifestToFile(t *testing.T) {
	outPath := os.Getenv("TABDOC_SHOWCASE_EXPORT")
	if outPath == "" {
		t.Skip("TABDOC_SHOWCASE_EXPORT 未设置")
	}
	newTestDocCmd(t)
	manifest := buildDocShowcaseManifest()
	raw, err := marshalDocShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}

// TestDocMarkdownWarnings 单测 docMarkdownWarnings 的 3 类静默 corruption 盲区检测。
//
// 覆盖（实测确认的 corruption 场景）：
//   - 价格场景 $ 配对：「总价 $5 加 $10」中间被吞为 latex
//   - inline code 包 $ / \$ 转义不报警（合法用法）
//   - 未闭合 fence（``` 或 $$）：吞光后续正文
//   - 未注册 directive（白名单仅 tabdata / htmlblock）
//   - 组合错误：多个独立 footgun 同时存在
//
// 断言策略：检查 warning 条数（精确）+ 关键词存在（确认是正确那条 warning）。
// 不锁完整 message 字符串，便于 helper 未来微调 wording 不破坏测试。
func TestDocMarkdownWarnings(t *testing.T) {
	cases := []struct {
		name         string
		markdown     string
		wantCount    int      // 期望 warning 条数
		wantContains []string // 期望 warning 全集合并后含的关键词
	}{
		{
			name:      "正常 markdown 无 warning",
			markdown:  "# 标题\n\n正文一段。",
			wantCount: 0,
		},
		{
			name:         "价格场景奇数 $",
			markdown:     "总价 $5 加 $10",
			wantCount:    1,
			wantContains: []string{"$"},
		},
		{
			name:      "价格场景已 \\$ 转义",
			markdown:  `总价 \$5 加 \$10`,
			wantCount: 0,
		},
		{
			name:      "inline code 包 $ 安全",
			markdown:  "总价 `$5` 加 `$10`",
			wantCount: 0,
		},
		{
			name:         "未闭合 ```",
			markdown:     "```python\nfor i in range(10):",
			wantCount:    1,
			wantContains: []string{"代码块"},
		},
		{
			name:         "未闭合 $$",
			markdown:     "$$ \\frac{1}{2}",
			wantCount:    1,
			wantContains: []string{"公式块"},
		},
		{
			name:         "未注册 directive :::callout",
			markdown:     ":::callout\n内容\n:::",
			wantCount:    1,
			wantContains: []string{"directive", "callout"},
		},
		{
			name:      "已注册 directive :::tabdata 不报",
			markdown:  `:::tabdata{tableId="x"}` + "\n:::",
			wantCount: 0,
		},
		{
			name:         "组合错误（价格 $ + fence 未闭合）",
			markdown:     "总价 $5 加 $10\n\n```\n未闭合",
			wantCount:    2,
			wantContains: []string{"$", "代码块"},
		},
		{
			name:      "fenced 代码内 $ 不被检测（属于代码字面）",
			markdown:  "```python\nprice = '$5'\nresult = price + '$10'\n```",
			wantCount: 0,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := docMarkdownWarnings(c.markdown)
			if len(got) != c.wantCount {
				t.Errorf("warning 条数=%d, want %d；warnings=%v",
					len(got), c.wantCount, got)
				return
			}
			joined := strings.Join(got, "\n")
			for _, kw := range c.wantContains {
				if !strings.Contains(joined, kw) {
					t.Errorf("warnings 缺关键词 %q；实际=%v", kw, got)
				}
			}
		})
	}
}

func TestDocCreateRemovesDuplicateLeadingTitleFromMarkdownBody(t *testing.T) {
	cmd := newTestDocCmd(t)
	createCmd, _, err := cmd.Find([]string{"create"})
	if err != nil || createCmd == nil {
		t.Fatalf("doc create 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(createCmd)
	if def == nil || def.Validate == nil {
		t.Fatal("doc create 缺少 CommandDef 或 Validate")
	}

	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"title":    "周报",
		"markdown": "# 周报\n\n本周完成三项工作。",
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("doc create 校验失败: %v", err)
	}
	if got := ctx.FlagValues["initial-content-markdown"]; got != "本周完成三项工作。" {
		t.Fatalf("同名一级标题不应进入正文，got=%q", got)
	}
}

func TestDocCreateRemovesDuplicateLeadingTitleWithDecorativePunctuation(t *testing.T) {
	cmd := newTestDocCmd(t)
	createCmd, _, err := cmd.Find([]string{"create"})
	if err != nil || createCmd == nil {
		t.Fatalf("doc create 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(createCmd)
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"title":    "立秋逢台风：上海本周从桑拿天转入风雨模式",
		"markdown": "# 立秋逢台风：上海本周从\"桑拿天\"转入风雨模式\n\n正文。",
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("doc create 校验失败: %v", err)
	}
	if got := ctx.FlagValues["initial-content-markdown"]; got != "正文。" {
		t.Fatalf("仅差装饰性标点的同名一级标题不应进入正文，got=%q", got)
	}
}

func TestDocSaveContentRemovesDuplicateLeadingTitleWhenTitleIsProvided(t *testing.T) {
	cmd := newTestDocCmd(t)
	saveCmd, _, err := cmd.Find([]string{"save-content"})
	if err != nil || saveCmd == nil {
		t.Fatalf("doc save-content 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(saveCmd)
	if def == nil || def.Validate == nil {
		t.Fatal("doc save-content 缺少 CommandDef 或 Validate")
	}

	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"title":    "项目复盘",
		"markdown": "# 项目复盘\r\n\r\n结论先行。",
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("doc save-content 校验失败: %v", err)
	}
	if got := ctx.FlagValues["content-markdown"]; got != "结论先行。" {
		t.Fatalf("同名一级标题不应进入正文，got=%q", got)
	}
}

func TestDocSaveContentRejectsLeadingH1WhenTitleIsOmitted(t *testing.T) {
	cmd := newTestDocCmd(t)
	saveCmd, _, err := cmd.Find([]string{"save-content"})
	if err != nil || saveCmd == nil {
		t.Fatalf("doc save-content 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(saveCmd)
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"markdown": "# 用户保留的一级标题\n\n正文。",
	}}
	if err := def.Validate(ctx); err == nil {
		t.Fatal("正文以 H1 开头但未传 title 时必须拒绝，避免重复全文标题静默落库")
	}
}

func TestDocCreateRemovesLeadingArticleTitleEvenWhenTextDiffersFromMetadataTitle(t *testing.T) {
	cmd := newTestDocCmd(t)
	createCmd, _, err := cmd.Find([]string{"create"})
	if err != nil || createCmd == nil {
		t.Fatalf("doc create 未挂载: err=%v", err)
	}
	def := cmdutil.GetCommandDef(createCmd)
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"title":    "项目复盘",
		"markdown": "# 项目复盘报告\n\n这是正文导语。",
	}}
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("doc create 校验失败: %v", err)
	}
	if got := ctx.FlagValues["initial-content-markdown"]; got != "这是正文导语。" {
		t.Fatalf("title 已承担整篇标题，content 的首个文章级 H1 不应保留，got=%q", got)
	}
}

func TestValidateDocMarkdownRejectsUnsupportedInlineHighlightMarkup(t *testing.T) {
	for _, markdown := range []string{
		"父亲说 <mark>我买几个橘子去。</mark>",
		"父亲说 ==我买几个橘子去。==",
	} {
		err := validateDocMarkdownInput(markdown)
		if err == nil {
			t.Fatalf("unsupported inline highlight markup must be rejected, markdown=%q err=%v", markdown, err)
		}
	}
}

// TestLooksLikeBareMarkdownFilePath ·
// Agent 把「导出到本地」误写成 save-content --markdown "$path.md"（无 @），
// CLI 把路径字符串当正文整篇覆盖。硬拦必须吃掉这条脚枪。
func TestLooksLikeBareMarkdownFilePath(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "正常正文", in: "# 标题\n\n正文一段。", want: false},
		{name: "短标题带井号", in: "# 周报", want: false},
		{name: "Windows 绝对路径 md", in: `C:\Users\Lenovo\TabTin\默认 Agent-2\淬炼盛夏荣光.md`, want: true},
		{name: "POSIX 绝对路径", in: "/Users/me/TabTin/workspace/report.md", want: true},
		{name: "相对路径带斜杠", in: "./drafts/weekly.md", want: true},
		{name: "反斜杠相对路径", in: `artifacts\news.md`, want: true},
		{name: "单独文件名 md", in: "report.md", want: true},
		{name: "标题里偶然出现 .md 扩展名但不整段是路径", in: "请阅读 report.md 后再改", want: false},
		{name: "URL 不是本地路径", in: "https://example.com/report.md", want: false},
		{name: "带 URL 的句子不是本地路径", in: "请看 https://example.com/report.md", want: false},
		{name: "空串", in: "", want: false},
		{name: "markdown 扩展名", in: `D:\docs\note.markdown`, want: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := looksLikeBareMarkdownFilePath(c.in)
			if got != c.want {
				t.Errorf("looksLikeBareMarkdownFilePath(%q)=%v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestRejectBareMarkdownFilePathError(t *testing.T) {
	// reject 命中时会输出标准错误信封；单测只验判别 + 正常正文不触发 reject 的 nil 分支。
	if err := rejectBareMarkdownFilePath("# 标题\n正文"); err != nil {
		t.Errorf("正常正文不应被拒：%v", err)
	}
	if !looksLikeBareMarkdownFilePath(`C:\Users\me\out.md`) {
		t.Fatal("裸路径应被判别为 true（PrintErrorAndExit 集成路径由 CLI 实跑覆盖）")
	}
}

// TestBuildDocTabdataEmbedMarkdown ·
// Agent 嵌表必须产出可解析的 :::tabdata{tableId="..."}（双引号 + 转义），
// 不能手写无引号 directive 再静默变成空 tableId。
func TestBuildDocTabdataEmbedMarkdown(t *testing.T) {
	md, err := buildDocTabdataEmbedMarkdown(
		`tbl_"123`,
		`User tableId="not-attr" \ Summary`,
		`vw_\456`,
		400,
	)
	if err != nil {
		t.Fatalf("合法 tableId 不应失败: %v", err)
	}
	// 与 packages/doc-editor/.../fixtures/19-tabdata-block.json 同一 canonical
	// directive，供 Go 生成器、TS 与 Python parser 做跨语言 round-trip。
	want := ":::tabdata{tableId=\"tbl_\\\"123\" viewId=\"vw_\\\\456\" title=\"User tableId=\\\"not-attr\\\" \\\\ Summary\"}\n:::"
	if md != want {
		t.Errorf("embed markdown 不符\ngot:  %q\nwant: %q", md, want)
	}
	if err := validateDocTabdataDirectives(md); err != nil {
		t.Errorf("自产 markdown 应通过校验: %v", err)
	}

	if _, err := buildDocTabdataEmbedMarkdown("", "标题", "", 0); err == nil {
		t.Fatal("空 tableId 必须失败")
	}
	if _, err := buildDocTabdataEmbedMarkdown("   ", "标题", "", 0); err == nil {
		t.Fatal("空白 tableId 必须失败")
	}
}

func TestBuildDocTabdataEmbedMarkdownRejectsControlCharactersInIDs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		tableID string
		viewID  string
	}{
		{name: "table id newline", tableID: "tbl-1\ninjected"},
		{name: "table id trailing newline", tableID: "tbl-1\n"},
		{name: "table id carriage return", tableID: "tbl-1\rinjected"},
		{name: "table id NUL", tableID: "tbl-1\x00injected"},
		{name: "view id newline", tableID: "tbl-1", viewID: "view-1\ninjected"},
		{name: "view id trailing tab", tableID: "tbl-1", viewID: "view-1\t"},
		{name: "view id DEL", tableID: "tbl-1", viewID: "view-1\x7finjected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildDocTabdataEmbedMarkdown(tc.tableID, "标题", tc.viewID, 0); err == nil {
				t.Fatal("含 CR/LF/控制字符的 id 必须失败")
			}
		})
	}
}

func TestBuildDocTabdataEmbedMarkdownNormalizesTitleControls(t *testing.T) {
	md, err := buildDocTabdataEmbedMarkdown(
		"tbl-1",
		"  销售\n数据\t\x00 第二行  ",
		"",
		0,
	)
	if err != nil {
		t.Fatalf("title 归一不应失败: %v", err)
	}
	want := ":::tabdata{tableId=\"tbl-1\" title=\"销售 数据 第二行\"}\n:::"
	if md != want {
		t.Fatalf("title 应归一为空格且不能拆 directive\ngot:  %q\nwant: %q", md, want)
	}
}

// TestValidateDocTabdataDirectives ·
// 无引号 / 空 tableId 不得静默成功（否则 Electron 显示「未关联表格」）。
func TestValidateDocTabdataDirectives(t *testing.T) {
	cases := []struct {
		name    string
		md      string
		wantErr bool
	}{
		{name: "合法双引号", md: ":::tabdata{tableId=\"tbl-001\"}\n:::", wantErr: false},
		{name: "无引号 tableId", md: ":::tabdata{tableId=tbl-001}\n:::", wantErr: true},
		{name: "空 tableId", md: ":::tabdata{tableId=\"\"}\n:::", wantErr: true},
		{name: "缺 tableId", md: ":::tabdata{title=\"x\"}\n:::", wantErr: true},
		{name: "stableId 不得冒充 tableId", md: ":::tabdata{stableId=\"tbl-x\"}\n:::", wantErr: true},
		{name: "mytableId 不得冒充 tableId", md: ":::tabdata{mytableId=\"tbl-x\"}\n:::", wantErr: true},
		{name: "重复 tableId", md: ":::tabdata{tableId=\"tbl-a\" tableId=\"tbl-b\"}\n:::", wantErr: true},
		{name: "directive 花括号未闭合", md: ":::tabdata{tableId=\"tbl-001\"\n:::", wantErr: true},
		{name: "普通段落无 directive", md: "# 标题\n\n正文", wantErr: false},
		{name: "markdown 管道表不是 tabdata", md: "| a | b |\n| --- | --- |\n| 1 | 2 |\n", wantErr: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateDocTabdataDirectives(c.md)
			if c.wantErr && err == nil {
				t.Fatal("期望校验失败，实际通过")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("期望通过，实际失败: %v", err)
			}
		})
	}
}

func TestParseQuotedDocAttrRequiresExactAttributeBoundary(t *testing.T) {
	attrs := `stableViewId="bad" mytitle="bad" mymaxHeight="999"`
	parsed, err := parseDocDirectiveAttrs(attrs)
	if err != nil {
		t.Fatalf("解析前缀属性失败: %v", err)
	}
	for _, name := range []string{"viewId", "title", "maxHeight"} {
		if got := parsed[name]; len(got) != 0 {
			t.Errorf("%s 不得命中带前缀属性，got=%v", name, got)
		}
	}

	attrs = `viewId="view-ok" title="Title \"ok\"" maxHeight="620"`
	parsed, err = parseDocDirectiveAttrs(attrs)
	if err != nil {
		t.Fatalf("解析合法属性失败: %v", err)
	}
	if got := parsed["viewId"]; len(got) != 1 || got[0] != "view-ok" {
		t.Errorf("viewId 合法属性解析失败: %v", got)
	}
	if got := parsed["title"]; len(got) != 1 || got[0] != `Title "ok"` {
		t.Errorf("title 合法转义解析失败: %v", got)
	}
	if got := parsed["maxHeight"]; len(got) != 1 || got[0] != "620" {
		t.Errorf("maxHeight 合法属性解析失败: %v", got)
	}
}

// TestValidateDocMarkdownInputRejectsBadTabdata ·
// insert-block / append / save-content 共用入口必须硬拦坏 tabdata。
func TestValidateDocMarkdownInputRejectsBadTabdata(t *testing.T) {
	if err := validateDocMarkdownInput(":::tabdata{tableId=tbl-001}\n:::"); err == nil {
		t.Fatal("无引号 tableId 必须经 validateDocMarkdownInput 硬失败")
	}
	if err := validateDocMarkdownInput(":::tabdata{tableId=\"tbl-ok\"}\n:::"); err != nil {
		t.Fatalf("合法 tabdata 不应失败: %v", err)
	}
}

// TestLooksLikeLiteralEscapedMultilineMarkdown ·
// Agent 在 zsh/PowerShell 双引号里写 \n 未展开 → 文档出现字面 \n、有序列表失效。
func TestLooksLikeLiteralEscapedMultilineMarkdown(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{
			name: "复现：标题+有序列表字面换行",
			in:   "## FAQ\\n\\n1. 退货退款流程怎么走（342 次）\\n2. 物流显示签收但没收到货（287 次）\\n3. 商品与描述不符怎么维权（195 次）",
			want: true,
		},
		{
			name: "复现：仅有序列表字面换行",
			in:   "1. first\\n2. second",
			want: true,
		},
		{
			name: "真实换行有序列表不拦",
			in:   "1. first\n2. second",
			want: false,
		},
		{
			name: "真实换行标题+列表不拦",
			in:   "## FAQ\n\n1. a\n2. b",
			want: false,
		},
		{
			name: "单行短正文不拦",
			in:   "## 新的一节",
			want: false,
		},
		{
			name: "代码字面 \\n 无结构不拦",
			in:   `print('hello\nworld')`,
			want: false,
		},
		{
			name: "无 \\n 不拦",
			in:   "一段普通正文没有列表",
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := looksLikeLiteralEscapedMultilineMarkdown(c.in)
			if got != c.want {
				t.Fatalf("looksLikeLiteralEscapedMultilineMarkdown(%q)=%v, want %v", c.in, got, c.want)
			}
		})
	}
}

// TestValidateDocMarkdownInputRejectsLiteralEscapedNewlines ·
func TestValidateDocMarkdownInputRejectsLiteralEscapedNewlines(t *testing.T) {
	bad := "## FAQ\\n\\n1. first\\n2. second"
	if err := validateDocMarkdownInput(bad); err == nil {
		t.Fatal("结构向字面 \\n 必须经 validateDocMarkdownInput 硬失败")
	}
	good := "## FAQ\n\n1. first\n2. second"
	if err := validateDocMarkdownInput(good); err != nil {
		t.Fatalf("真实换行多行 Markdown 不应失败: %v", err)
	}
}

// TestLooksLikeShellExpandedMathDollar ·
func TestLooksLikeShellExpandedMathDollar(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{
			name: "PowerShell 吃掉 $a 后的残缺公式",
			in:   "1. 平方差公式：^2 - b^2 = (a+b)(a-b)$",
			want: true,
		},
		{
			name: "残缺 \\frac 公式",
			in:   "面积公式：\\frac{1}{2}ah$",
			want: true,
		},
		{
			name: "完好行内公式不拦",
			in:   "公式 $a^2 - b^2 = (a+b)(a-b)$ 可用",
			want: false,
		},
		{
			name: "普通金额不拦",
			in:   "总价约 5$",
			want: false,
		},
		{
			name: "价格前缀 $ 不拦",
			in:   "单价 $5",
			want: false,
		},
		{
			name: "@文件风格完好公式不拦",
			in:   "1. 平方差：$a^2 - b^2 = (a+b)(a-b)$\n2. 完全平方：$(a+b)^2 = a^2+2ab+b^2$",
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := looksLikeShellExpandedMathDollar(c.in)
			if got != c.want {
				t.Fatalf("looksLikeShellExpandedMathDollar(%q)=%v, want %v", c.in, got, c.want)
			}
		})
	}
}

// TestValidateDocMarkdownInputRejectsShellExpandedMath ·
func TestValidateDocMarkdownInputRejectsShellExpandedMath(t *testing.T) {
	bad := "1. 平方差公式：^2 - b^2 = (a+b)(a-b)$"
	if err := validateDocMarkdownInput(bad); err == nil {
		t.Fatal("shell 展开残缺公式必须经 validateDocMarkdownInput 硬失败")
	}
	good := "1. 平方差公式：$a^2 - b^2 = (a+b)(a-b)$"
	if err := validateDocMarkdownInput(good); err != nil {
		t.Fatalf("完好公式不应失败: %v", err)
	}
}

// TestEmbedTableCommandFlags ·  可发现性：一等命令 + 关键 flag。
func TestEmbedTableCommandFlags(t *testing.T) {
	cmd := newTestDocCmd(t)
	found, _, err := cmd.Find([]string{"embed-table"})
	if err != nil || found == nil || found.Name() != "embed-table" {
		t.Fatalf("embed-table 未挂载: err=%v found=%v", err, found)
	}
	for _, name := range []string{"table-id", "title", "view-id", "max-height", "after", "base-version"} {
		if found.Flags().Lookup(name) == nil {
			t.Errorf("embed-table 缺少 flag --%s", name)
		}
	}
	def := cmdutil.GetCommandDef(found)
	if def == nil || def.AIHelp == "" {
		t.Fatal("embed-table 必须有 AIHelp，供 skill / ai-help 发现")
	}
	if !strings.Contains(def.AIHelp, "tabdataBlock") && !strings.Contains(def.AIHelp, "多维表") {
		t.Errorf("AIHelp 应区分多维表嵌入与普通 markdown table，got=%q", def.AIHelp)
	}
}

// TestDocExportFormatEnum · ：--export-format 必须是强校验的 FlagEnum，
// 覆盖 Django exchange_service._SUPPORTED_EXPORT_FORMATS 全部 5 种格式；
// docx/pdf 是二进制格式，Long 必须说明必须搭配 --output。
func TestDocExportFormatEnum(t *testing.T) {
	cmd := newTestDocCmd(t)
	exportCmd, _, err := cmd.Find([]string{"export"})
	if err != nil || exportCmd == nil {
		t.Fatalf("doc export 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(exportCmd)
	if def == nil {
		t.Fatal("doc export 无 CommandDef")
	}

	var flag *cmdutil.FlagDef
	for i := range def.Flags {
		if def.Flags[i].Name == "export-format" {
			flag = &def.Flags[i]
			break
		}
	}
	if flag == nil {
		t.Fatal("doc export 缺少 --export-format")
	}
	if flag.Type != cmdutil.FlagEnum {
		t.Fatalf("--export-format 应为 FlagEnum，got %v", flag.Type)
	}
	wantEnum := []string{"markdown", "html", "txt", "docx", "pdf"}
	if len(flag.Enum) != len(wantEnum) {
		t.Fatalf("--export-format Enum=%v，want %v", flag.Enum, wantEnum)
	}
	for i, v := range wantEnum {
		if flag.Enum[i] != v {
			t.Fatalf("--export-format Enum[%d]=%q，want %q", i, flag.Enum[i], v)
		}
	}
	if flag.Default != "markdown" {
		t.Fatalf("--export-format 默认值应保持 markdown，got %v", flag.Default)
	}
	for _, kw := range []string{"docx", "pdf", "--output", "二进制"} {
		if !strings.Contains(def.Long, kw) {
			t.Errorf("doc export Long 应提及 %q（docx/pdf 必须搭配 --output），got: %s", kw, def.Long)
		}
	}
	if def.Timeout <= 0 {
		t.Errorf("doc export 应设置较长 Timeout（PDF 经 Playwright 渲染较慢），got %v", def.Timeout)
	}
}

// TestDocCreateParentItemID · ：知识库树父节点与 Document.parent 分旗。
func TestDocCreateParentItemID(t *testing.T) {
	cmd := newTestDocCmd(t)
	createCmd, _, err := cmd.Find([]string{"create"})
	if err != nil || createCmd == nil {
		t.Fatalf("doc create 不存在: err=%v", err)
	}
	def := cmdutil.GetCommandDef(createCmd)
	if def == nil {
		t.Fatal("doc create 无 CommandDef")
	}

	flags := map[string]bool{}
	for _, f := range def.Flags {
		flags[f.Name] = true
	}
	if !flags["parent-item-id"] {
		t.Fatalf("doc create 应暴露 --parent-item-id，flags=%v", flags)
	}
	if !flags["parent-id"] {
		t.Fatalf("doc create 应保留 --parent-id（Document 内页树），flags=%v", flags)
	}
	if !strings.Contains(def.Long, "parent-item-id") || !strings.Contains(def.Long, "ContextItem") {
		t.Fatalf("doc create Long 应区分知识库树 parent-item-id，got: %s", def.Long)
	}
	if !strings.Contains(def.AIHelp, "parent-item-id") || !strings.Contains(def.AIHelp, "ContextItem.parent") {
		t.Fatalf("doc create AIHelp 应说明知识库树挂载，got: %s", def.AIHelp)
	}

	if def.DryRun == nil {
		t.Fatal("doc create 缺 DryRun")
	}

	// 只传 parent-item-id：body 含 parent_item_id，不含 parent_id
	planItem := def.DryRun(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"title":          "子文档",
			"parent-item-id": "ctx_parent_1",
		},
	})
	bodyItem, ok := planItem.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("dry-run body 类型异常: %#v", planItem.Plan[0].Body)
	}
	if bodyItem["parent_item_id"] != "ctx_parent_1" {
		t.Fatalf("dry-run 应携带 parent_item_id，got %#v", bodyItem)
	}
	if _, has := bodyItem["parent_id"]; has {
		t.Fatalf("未传 --parent-id 时不应出现 parent_id，got %#v", bodyItem)
	}

	// 不传父节点：根级创建，两套 parent 字段都缺省
	planRoot := def.DryRun(&cmdutil.RunContext{
		FlagValues: map[string]any{"title": "根文档"},
	})
	bodyRoot, ok := planRoot.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("root dry-run body 类型异常: %#v", planRoot.Plan[0].Body)
	}
	if _, has := bodyRoot["parent_item_id"]; has {
		t.Fatalf("根级创建不应带 parent_item_id，got %#v", bodyRoot)
	}
	if _, has := bodyRoot["parent_id"]; has {
		t.Fatalf("根级创建不应带 parent_id，got %#v", bodyRoot)
	}

	// 两套父参数可并存（后端语义独立）
	planBoth := def.DryRun(&cmdutil.RunContext{
		FlagValues: map[string]any{
			"title":          "双父",
			"parent-item-id": "ctx_1",
			"parent-id":      "doc_1",
		},
	})
	bodyBoth, ok := planBoth.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("both dry-run body 类型异常: %#v", planBoth.Plan[0].Body)
	}
	if bodyBoth["parent_item_id"] != "ctx_1" || bodyBoth["parent_id"] != "doc_1" {
		t.Fatalf("两套父参数应同时进入 body，got %#v", bodyBoth)
	}
}
