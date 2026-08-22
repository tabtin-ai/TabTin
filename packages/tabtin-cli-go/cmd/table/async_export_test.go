// async_export_test.go —  W3 异步导入/导出 HTTP 闭环的命令注册期契约测试。
//
// 这组测试钉住的是「CLI 声明 vs cli-server 伪路由 vs Django 端点」三者的接缝：
// 异步链路要跑通得靠 export --async → export wait → export download 三条命令
// 的 flag 名 / 路由 / 退出语义都对得上，任何一环漂移都会让 Agent 卡在
// 「拿到 task_id 之后不知道怎么办」。真实网络行为不在这里验（见
// docs/agent/cli-gaps-w3-async-import-export-acceptance.md 的 live harness）。
package table

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func findTableCommandDef(t *testing.T, path ...string) *cmdutil.CommandDef {
	t.Helper()
	f := cmdutil.NewFactory()
	root := NewCmdTable(f)
	cmd, rest, err := root.Find(path)
	if err != nil || len(rest) > 0 || cmd == root {
		t.Fatalf("命令 `table %s` 未注册: err=%v rest=%v", strings.Join(path, " "), err, rest)
	}
	def := cmdutil.GetCommandDef(cmd)
	if def == nil {
		t.Fatalf("命令 `table %s` 无 CommandDef", strings.Join(path, " "))
	}
	return def
}

func findFlag(def *cmdutil.CommandDef, name string) *cmdutil.FlagDef {
	for i := range def.Flags {
		if def.Flags[i].Name == name {
			return &def.Flags[i]
		}
	}
	return nil
}

// TestExportAsyncFlagOnBinaryFormats 断言三种可异步的导出格式都暴露了 --async。
// 这个 flag 名必须与 cli-routes 的 `body.async_mode ?? body.async` 对齐——
// 改名会让异步分支静默退回同步导出（大表直接超时，且没有任何报错提示）。
func TestExportAsyncFlagOnBinaryFormats(t *testing.T) {
	for _, format := range []string{"csv", "excel", "pdf"} {
		def := findTableCommandDef(t, "export", format)
		flag := findFlag(def, "async")
		if flag == nil {
			t.Fatalf("table export %s 缺少 --async", format)
		}
		if flag.Type != cmdutil.FlagBool {
			t.Fatalf("table export %s 的 --async 应为 FlagBool，got %v", format, flag.Type)
		}
		if flag.CliOnly {
			t.Fatalf("table export %s 的 --async 必须发给后端（不能 CliOnly）", format)
		}
	}
}

// TestExportJSONStaysSynchronous 守住「W3 不重开 JSON 导出」的边界：
// cli-server 对 format=json 固定回 410，给它加 --async 只会造出一条死路。
func TestExportJSONStaysSynchronous(t *testing.T) {
	def := findTableCommandDef(t, "export", "json")
	if findFlag(def, "async") != nil {
		t.Fatal("table export json 不应有 --async——JSON 导出仍是 410 FEATURE_DISABLED")
	}
}

// TestExportWaitCommandContract 覆盖 wait 的三件事：自定义执行钩子、必填 task-id、
// timeout/interval 有可用默认值（不能逼调用方每次都算轮询节奏）。
func TestExportWaitCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "export", "wait")
	if def.Execute == nil {
		t.Fatal("table export wait 应由 Execute 钩子实现轮询（声明式管线没有轮询语义）")
	}
	if def.Method != "" || def.Path != "" {
		t.Fatalf("table export wait 不应声明 Method/Path（与 Execute 互斥），got %s %s", def.Method, def.Path)
	}

	taskID := findFlag(def, "task-id")
	if taskID == nil || !taskID.Required {
		t.Fatal("table export wait 的 --task-id 应为必填")
	}
	// --timeout 是 root persistent flag（单次请求超时），命令级同名会遮蔽它。
	if findFlag(def, "timeout") != nil {
		t.Fatal("table export wait 不应声明命令级 --timeout（会遮蔽 root 的 persistent --timeout）")
	}
	timeout := findFlag(def, "wait-timeout")
	if timeout == nil || timeout.Default == nil {
		t.Fatal("table export wait 的 --wait-timeout 应有默认值")
	}
	interval := findFlag(def, "interval")
	if interval == nil || interval.Default == nil {
		t.Fatal("table export wait 的 --interval 应有默认值")
	}
	if !strings.Contains(def.Long, "退出码") {
		t.Fatalf("table export wait 的 Long 应说明退出码语义（失败 vs 超时），got: %s", def.Long)
	}
}

// TestExportDownloadCommandContract 断言 download 走 cli-server 的 /table/export-download
// 伪路由（那里才有「取签名 URL → 代取字节 → __binary 信封」的两段式），
// 且 -o 是命令级 CliOnly（二进制必须落盘，不能直出 stdout）。
func TestExportDownloadCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "export", "download")
	if def.Path != "/table/export-download" {
		t.Fatalf("table export download 路径漂移，got %s", def.Path)
	}
	if def.Method != "POST" {
		t.Fatalf("table export download 应为 POST（cli-server 伪路由约定），got %s", def.Method)
	}
	fileID := findFlag(def, "file-id")
	if fileID == nil || !fileID.Required {
		t.Fatal("table export download 的 --file-id 应为必填")
	}
	out := findFlag(def, "output")
	if out == nil || !out.CliOnly || out.Short != "o" {
		t.Fatal("table export download 应有命令级 CliOnly 的 -o/--output")
	}
	if findFlag(def, "url-only") == nil {
		t.Fatal("table export download 应有 --url-only（超大文件/自取场景的逃生口）")
	}
}

// TestExportStatsCommandContract 体积预检是只读辅助查询，路由必须指向 /table/export-stats。
func TestExportStatsCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "export", "stats")
	if def.Path != "/table/export-stats" {
		t.Fatalf("table export stats 路径漂移，got %s", def.Path)
	}
	if def.Risk != cmdutil.RiskRead {
		t.Fatalf("table export stats 应为 RiskRead，got %v", def.Risk)
	}
	if findFlag(def, "table-id") == nil {
		t.Fatal("table export stats 缺少 --table-id")
	}
}

// TestImportFileCommandContract 覆盖大文件导入：只发路径、不发字节 + 走
// /table/import-file，与既有的 import csv/json/excel 同步路径分开（不复用它们的端点）。
func TestImportFileCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "import", "file")
	if def.Path != "/table/import-file" {
		t.Fatalf("table import file 路径漂移，got %s", def.Path)
	}
	// 关键回归：文件字节一旦进 CLI 请求体就会撞 cli-server 的 10MB 上限
	// （base64 还膨胀 4/3），大文件导入必须由 cli-server 读盘。
	if def.FileField != "" || def.FileBase64 {
		t.Fatalf("table import file 不该把文件读进请求体，got FileField=%s FileBase64=%v",
			def.FileField, def.FileBase64)
	}
	fileFlag := findFlag(def, "file")
	if fileFlag == nil || !fileFlag.Required {
		t.Fatal("table import file 缺少必填 --file")
	}
	if fileFlag.CliOnly {
		t.Fatal("--file 必须随 body 发给 cli-server（路径本身就是参数），不能是 CliOnly")
	}
	if !fileFlag.NoFileInput {
		t.Fatal("--file 应声明 NoFileInput，避免 @file 语法把路径读成文件内容")
	}
	if def.Risk != cmdutil.RiskWrite || def.DryRun == nil {
		t.Fatal("table import file 是写操作，必须 RiskWrite + 实现 DryRun 钩子")
	}
	if def.Validate == nil {
		t.Fatal("table import file 应有 Validate 钩子（推断 file-type + 体积预检）")
	}
}

// TestValidateImportFileSize 钉住本地体积预检：超过后端上限时提前报错并说出真实天花板，
// 而不是让请求发出去在传输层被掐断。
func TestValidateImportFileSize(t *testing.T) {
	dir := t.TempDir()

	small := filepath.Join(dir, "small.csv")
	if err := os.WriteFile(small, make([]byte, 1024), 0o600); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	if err := validateImportFileSize(small, "csv"); err != nil {
		t.Fatalf("小文件不该被拒: %v", err)
	}

	// 12MB：超 CSV/JSON 的 10MB，但在 Excel 的 20MB 之内——按类型分别判定。
	big := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(big, make([]byte, 12*1024*1024), 0o600); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	err := validateImportFileSize(big, "csv")
	if err == nil {
		t.Fatal("12MB CSV 应超过 10MB 上限被拒")
	}
	if !strings.Contains(err.Error(), "10MB") {
		t.Fatalf("错误信息应说出真实上限 10MB，got %v", err)
	}
	if err := validateImportFileSize(big, "excel"); err != nil {
		t.Fatalf("12MB Excel 在 20MB 上限内，不该被拒: %v", err)
	}

	// 路径不存在不在本地判死——白名单 / 软链 / 不存在统一由 cli-server 裁决，
	// 免得两处规则漂移。
	if err := validateImportFileSize(filepath.Join(dir, "nope.csv"), "csv"); err != nil {
		t.Fatalf("不存在的路径应交给 cli-server 裁决: %v", err)
	}
}

// TestImportFileValidateInfersFileType 断言扩展名推断真的落进 FlagValues
// （buildRequestBody 读的是 FlagValues），以及不认识的扩展名会被明确拒绝——
// 静默按 csv 解析 .dat 只会产出一堆乱码行，比报错难查得多。
func TestImportFileValidateInfersFileType(t *testing.T) {
	def := findTableCommandDef(t, "import", "file")

	cases := []struct {
		name     string
		file     string
		explicit string
		want     string
		wantErr  bool
	}{
		{"csv 扩展名", "/tmp/a.csv", "", "csv", false},
		{"xlsx 归一到 excel", "/tmp/a.XLSX", "", "excel", false},
		{"json 扩展名", "/tmp/a.json", "", "json", false},
		{"未知扩展名要求显式指定", "/tmp/a.dat", "", "", true},
		{"显式 file-type 优先", "/tmp/a.dat", "csv", "csv", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flagVals := map[string]any{"file": tc.file}
			if tc.explicit != "" {
				flagVals["file-type"] = tc.explicit
			}
			ctx := &cmdutil.RunContext{FlagValues: flagVals}
			err := def.Validate(ctx)
			if tc.wantErr {
				if err == nil {
					t.Fatal("期望报错，实际放行")
				}
				return
			}
			if err != nil {
				t.Fatalf("期望放行，实际报错: %v", err)
			}
			if got, _ := ctx.FlagValues["file-type"].(string); got != tc.want {
				t.Fatalf("file-type = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestImportFileDryRunPlan 钉住 dry-run 不发请求且能看出目标端点与推断出的类型。
func TestImportFileDryRunPlan(t *testing.T) {
	def := findTableCommandDef(t, "import", "file")
	ctx := &cmdutil.RunContext{FlagValues: map[string]any{
		"table-id": "tbl-1",
		"file":     "/tmp/big.xlsx",
	}}
	plan := def.DryRun(ctx)
	if plan == nil || len(plan.Plan) == 0 {
		t.Fatal("import file DryRun 应返回至少一步计划")
	}
	step := plan.Plan[0]
	if step.Method != "POST" || step.URL != "/table/import-file" {
		t.Fatalf("DryRun 第一步应为 POST /table/import-file，got %s %s", step.Method, step.URL)
	}
	body, ok := step.Body.(map[string]any)
	if !ok {
		t.Fatalf("DryRun body 类型异常: %T", step.Body)
	}
	if body["file_type"] != "excel" {
		t.Fatalf("DryRun 应展示推断出的 file_type=excel，got %v", body["file_type"])
	}
}

func TestImportFileTypeByExt(t *testing.T) {
	cases := map[string]string{
		"data.csv":       "csv",
		"DATA.CSV":       "csv",
		"book.xlsx":      "excel",
		"legacy.xls":     "excel",
		"payload.json":   "json",
		"noext":          "",
		"archive.tar.gz": "",
	}
	for input, want := range cases {
		if got := importFileTypeByExt(input); got != want {
			t.Errorf("importFileTypeByExt(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestParseAsyncTaskStatus 覆盖状态解析的三种输入：Django 信封、裸对象、坏 JSON。
// 坏 JSON 必须回空状态（= 继续轮询），不能被当成任务失败——中间层多包一层信封
// 这种历史问题不该让调用方误判任务挂了。
func TestParseAsyncTaskStatus(t *testing.T) {
	wrapped, _ := json.Marshal(map[string]any{
		"success": true,
		"data":    map[string]any{"task_id": "t-1", "status": "success", "file_id": "f-1"},
	})
	status, payload := parseAsyncTaskStatus(wrapped)
	if status != "success" || payload["file_id"] != "f-1" {
		t.Fatalf("信封形态解析失败: status=%q payload=%v", status, payload)
	}

	bare, _ := json.Marshal(map[string]any{"task_id": "t-2", "status": "pending"})
	if status, _ := parseAsyncTaskStatus(bare); status != "pending" {
		t.Fatalf("裸对象解析失败: status=%q", status)
	}

	if status, payload := parseAsyncTaskStatus([]byte("not-json")); status != "" || payload != nil {
		t.Fatalf("坏 JSON 应回空状态继续轮询，got status=%q payload=%v", status, payload)
	}
}
