package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestSlideHTMLGuidanceUsesCrossPlatformFileInput(t *testing.T) {
	fileInputPattern := regexp.MustCompile(`--html\s+["']?@`)
	cmd := newCmdSlide(cmdutil.NewFactory())
	for _, subcommand := range cmd.Commands() {
		if strings.Contains(subcommand.Example, "| tabtin slide") {
			t.Errorf("%s help 不应推荐 shell 管道传 HTML: %q", subcommand.Name(), subcommand.Example)
		}
	}
	render, _, err := cmd.Find([]string{"render"})
	if err != nil {
		t.Fatalf("find render: %v", err)
	}
	if strings.Contains(render.Example, "--html -") {
		t.Fatalf("render help 不应推荐 shell stdin 管道: %q", render.Example)
	}
	if !fileInputPattern.MatchString(render.Example) {
		t.Fatalf("render help 应推荐跨平台 @file 输入: %q", render.Example)
	}

	skillFiles := []string{
		"../../apps/tabslide/skills/tabslide-operator/SKILL.md",
		"../../apps/tabslide/skills/tabslide-operator/references/command-reference.md",
		"../../apps/tabslide/skills/operations/SKILL.md",
	}
	for _, relPath := range skillFiles {
		content, readErr := os.ReadFile(filepath.Clean(relPath))
		if readErr != nil {
			t.Fatalf("读取 %s: %v", relPath, readErr)
		}
		text := string(content)
		if strings.Contains(text, "| tabtin slide") {
			t.Errorf("%s 不应推荐 shell 管道传 HTML", relPath)
		}
		if !fileInputPattern.MatchString(text) {
			t.Errorf("%s 应保留 @file HTML 示例", relPath)
		}
	}
}

func TestSlideCreateAcceptsHTMLInput(t *testing.T) {
	cmd := newCmdSlide(cmdutil.NewFactory())
	leaf, _, err := cmd.Find([]string{"create"})
	if err != nil {
		t.Fatalf("find create: %v", err)
	}
	if leaf == nil || leaf.Name() != "create" {
		t.Fatalf("未找到 create 命令")
	}

	def := cmdutil.GetCommandDef(leaf)
	if def == nil {
		t.Fatalf("create 缺少 CommandDef")
	}
	if def.Path != "/slide/create" {
		t.Fatalf("Path = %q, want /slide/create", def.Path)
	}
	if def.FileField != "html" {
		t.Fatalf("FileField = %q, want html", def.FileField)
	}
	if def.Conflicts["file"][0] != "html" || def.Conflicts["html"][0] != "file" {
		t.Fatalf("file/html 应互斥，得到 %#v", def.Conflicts)
	}
	fileFlagFound := false
	for _, flag := range def.Flags {
		if flag.Name == "file" {
			fileFlagFound = true
			if !flag.CliOnly {
				t.Fatalf("--file 应为 CliOnly，避免把本地路径发给后端")
			}
		}
	}
	if !fileFlagFound {
		t.Fatalf("create 命令缺少 --file")
	}
}

func TestSlideGenerateRequiresExplicitReplace(t *testing.T) {
	cmd := newCmdSlide(cmdutil.NewFactory())
	leaf, _, err := cmd.Find([]string{"generate"})
	if err != nil {
		t.Fatalf("find generate: %v", err)
	}

	def := cmdutil.GetCommandDef(leaf)
	if def == nil {
		t.Fatalf("generate 缺少 CommandDef")
	}
	if def.StdinField != "html" {
		t.Fatalf("StdinField = %q, want html", def.StdinField)
	}

	replaceFound := false
	for _, flag := range def.Flags {
		if flag.Name == "replace" {
			replaceFound = true
			if flag.Type != cmdutil.FlagBool {
				t.Fatalf("--replace 类型 = %q, want bool", flag.Type)
			}
		}
	}
	if !replaceFound {
		t.Fatalf("generate 命令缺少 --replace")
	}
}

func TestSlideAddPageAcceptsHTMLInput(t *testing.T) {
	cmd := newCmdSlide(cmdutil.NewFactory())
	leaf, _, err := cmd.Find([]string{"add-page"})
	if err != nil {
		t.Fatalf("find add-page: %v", err)
	}

	def := cmdutil.GetCommandDef(leaf)
	if def == nil {
		t.Fatalf("add-page 缺少 CommandDef")
	}
	if def.FileField != "html" {
		t.Fatalf("FileField = %q, want html", def.FileField)
	}
	if def.StdinField != "html" {
		t.Fatalf("StdinField = %q, want html", def.StdinField)
	}
	if def.Conflicts["file"][0] != "html" || def.Conflicts["html"][0] != "file" {
		t.Fatalf("file/html 应互斥，得到 %#v", def.Conflicts)
	}

	flags := map[string]cmdutil.FlagDef{}
	for _, flag := range def.Flags {
		flags[flag.Name] = flag
	}
	if flag, ok := flags["file"]; !ok {
		t.Fatalf("add-page 命令缺少 --file")
	} else if !flag.CliOnly {
		t.Fatalf("--file 应为 CliOnly，避免把本地路径发给后端")
	}
	if _, ok := flags["html"]; !ok {
		t.Fatalf("add-page 命令缺少 --html")
	}
}

// TestSlideCommandVisibilityForAgent 锁定  的核心收敛：`slide create` 对 Agent
// 隐藏（cobra Hidden → 从 `--help` 与 `tabtin commands` 命令发现面剔除），`render` /
// `export` 保持可发现。防止有人手滑把 create 改回可见、让 Agent 又去建云项目。
func TestSlideCommandVisibilityForAgent(t *testing.T) {
	cmd := newCmdSlide(cmdutil.NewFactory())
	cases := map[string]bool{ // 子命令 → 期望 Hidden
		"create": true,
		"render": false,
		"export": false,
	}
	for sub, wantHidden := range cases {
		leaf, _, err := cmd.Find([]string{sub})
		if err != nil || leaf == nil || leaf.Name() != sub {
			t.Fatalf("找不到 slide %s 子命令: %v", sub, err)
		}
		if leaf.Hidden != wantHidden {
			t.Fatalf("slide %s Hidden = %v, want %v", sub, leaf.Hidden, wantHidden)
		}
	}
}

// TestSlideExportInfoParsesEnvelopes 锁定 slideExportInfo 对两种响应形状的解析：
// Django/Electron envelope（{data:{...}}）与已解包对象。
func TestSlideExportInfoParsesEnvelopes(t *testing.T) {
	cases := map[string]string{
		"enveloped": `{"ok":true,"data":{"download_url":"https://oss/x.pptx","filename":"x.pptx"}}`,
		"unwrapped": `{"download_url":"https://oss/x.pptx","filename":"x.pptx"}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			url, filename := slideExportInfo([]byte(raw))
			if url != "https://oss/x.pptx" {
				t.Fatalf("download_url = %q", url)
			}
			if filename != "x.pptx" {
				t.Fatalf("filename = %q", filename)
			}
		})
	}
	t.Run("missing url", func(t *testing.T) {
		if url, _ := slideExportInfo([]byte(`{"data":{}}`)); url != "" {
			t.Fatalf("expected empty url, got %q", url)
		}
	})
}

// TestSlideRenderProjectInfo 锁定 create 响应中 project id / page_count / layout_problems 的提取。
func TestSlideRenderProjectInfo(t *testing.T) {
	id, pages, layout := slideRenderProjectInfo([]byte(
		`{"data":{"id":"proj-1","page_count":8,"layout_problems":[{"type":"html_overflow"}]}}`))
	if id != "proj-1" || pages != 8 || len(layout) != 1 {
		t.Fatalf("id=%q pages=%d layout=%d", id, pages, len(layout))
	}
	id2, pages2, layout2 := slideRenderProjectInfo([]byte(`{"id":"proj-2"}`))
	if id2 != "proj-2" || pages2 != 0 || layout2 != nil {
		t.Fatalf("id2=%q pages2=%d layout2=%v", id2, pages2, layout2)
	}
}

func TestSlideHTMLOverflowProblems(t *testing.T) {
	problems := []any{
		map[string]any{"type": "html_overflow", "severity": "error", "page_id": "page-5"},
		map[string]any{"type": "html_overflow", "severity": "warning", "page_id": "page-4"},
		map[string]any{"type": "out_of_canvas", "severity": "warning", "page_id": "page-1"},
		map[string]any{"type": "html_clipped_text", "severity": "info", "page_id": "page-5"},
	}
	blocking := slideHTMLOverflowProblems(problems)
	if len(blocking) != 1 {
		t.Fatalf("expected 1 blocking error html_overflow, got %d", len(blocking))
	}
}
