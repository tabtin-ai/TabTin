package cmdutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewDryRunPlanEmpty(t *testing.T) {
	p := NewDryRunPlan()
	if p == nil {
		t.Fatal("NewDryRunPlan() 返回 nil")
	}
	if p.Description != "" {
		t.Errorf("初始 Description 应为空，得到 %q", p.Description)
	}
	if len(p.Plan) != 0 {
		t.Errorf("初始 Plan 应为空 slice，得到 %d 个元素", len(p.Plan))
	}
	if p.Extra != nil {
		t.Errorf("初始 Extra 应为 nil（延迟初始化）")
	}
}

func TestDryRunPlanDescChainable(t *testing.T) {
	p := NewDryRunPlan().Desc("3-step orchestration")
	if p.Description != "3-step orchestration" {
		t.Errorf("Desc 未生效: %q", p.Description)
	}
}

func TestDryRunPlanStepWithoutBody(t *testing.T) {
	p := NewDryRunPlan().Step("GET", "/api/x")
	if len(p.Plan) != 1 {
		t.Fatalf("Step 后 Plan 长度 = %d, want 1", len(p.Plan))
	}
	s := p.Plan[0]
	if s.Step != 1 || s.Method != "GET" || s.URL != "/api/x" {
		t.Errorf("Step 字段异常: %+v", s)
	}
	if s.Body != nil {
		t.Errorf("无 body 时 Body 应为 nil，得到 %v", s.Body)
	}
}

func TestDryRunPlanStepWithBodyAutoIncrement(t *testing.T) {
	p := NewDryRunPlan().
		Step("POST", "/api/a", map[string]any{"k": "v"}).
		Step("POST", "/api/b", map[string]any{"k2": "v2"}).
		Step("PATCH", "/api/c")
	if len(p.Plan) != 3 {
		t.Fatalf("Plan 长度 = %d, want 3", len(p.Plan))
	}
	for i, s := range p.Plan {
		wantStep := i + 1
		if s.Step != wantStep {
			t.Errorf("plan[%d].Step = %d, want %d（自动递增失败）", i, s.Step, wantStep)
		}
	}
	body, ok := p.Plan[0].Body.(map[string]any)
	if !ok || body["k"] != "v" {
		t.Errorf("plan[0].Body 未正确写入: %v", p.Plan[0].Body)
	}
	if p.Plan[2].Body != nil {
		t.Errorf("plan[2] 无 body 应为 nil，得到 %v", p.Plan[2].Body)
	}
}

func TestDryRunPlanStepMultipleBodiesTakesFirst(t *testing.T) {
	p := NewDryRunPlan().Step("POST", "/x", "first", "second", "third")
	if p.Plan[0].Body != "first" {
		t.Errorf("variadic body 应只取第一个，得到 %v", p.Plan[0].Body)
	}
}

func TestDryRunPlanFileFillsSize(t *testing.T) {
	tmpDir := t.TempDir()
	fp := filepath.Join(tmpDir, "demo.bin")
	payload := []byte("hello dry-run plan")
	if err := os.WriteFile(fp, payload, 0644); err != nil {
		t.Fatalf("准备临时文件失败: %v", err)
	}

	p := NewDryRunPlan().
		Step("POST", "/api/upload").
		File(fp)

	if len(p.Plan) != 1 {
		t.Fatalf("Plan 长度异常: %d", len(p.Plan))
	}
	s := p.Plan[0]
	if s.File != fp {
		t.Errorf("File 路径未写入: %q", s.File)
	}
	if s.SizeBytes != int64(len(payload)) {
		t.Errorf("SizeBytes = %d, want %d", s.SizeBytes, len(payload))
	}
}

func TestDryRunPlanFileMissingNoError(t *testing.T) {
	p := NewDryRunPlan().
		Step("POST", "/api/upload").
		File("/nonexistent/path/should/never/exist.bin")

	s := p.Plan[0]
	if s.File != "/nonexistent/path/should/never/exist.bin" {
		t.Errorf("即使文件不存在，File 路径仍应被记录: %q", s.File)
	}
	if s.SizeBytes != 0 {
		t.Errorf("文件不存在时 SizeBytes 应为 0，得到 %d", s.SizeBytes)
	}
}

func TestDryRunPlanFileWithoutPrecedingStepIsNoop(t *testing.T) {
	p := NewDryRunPlan().File("/whatever")
	if len(p.Plan) != 0 {
		t.Errorf("无 Step 时 File 应是 no-op，得到 %d 个 plan 项", len(p.Plan))
	}
}

func TestDryRunPlanSetExtra(t *testing.T) {
	p := NewDryRunPlan().Set("as", "bot").Set("retry", 3)
	if p.Extra == nil {
		t.Fatal("Set 后 Extra 应被初始化")
	}
	if p.Extra["as"] != "bot" {
		t.Errorf("Extra[as] = %v, want bot", p.Extra["as"])
	}
	if p.Extra["retry"] != 3 {
		t.Errorf("Extra[retry] = %v, want 3", p.Extra["retry"])
	}
}

func TestDryRunPlanFullChain(t *testing.T) {
	tmpDir := t.TempDir()
	fp := filepath.Join(tmpDir, "x.png")
	if err := os.WriteFile(fp, []byte("png"), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewDryRunPlan().
		Desc("3-step orchestration: block + upload + bind").
		Step("POST", "/api/tabdoc/documents/abc/blocks", map[string]any{"type": "image"}).
		Step("POST", "/api/services/oss/upload").File(fp).
		Step("PATCH", "/api/tabdoc/documents/abc/blocks/xyz", map[string]any{"file_token": "${step2.token}"}).
		Set("as", "bot")

	if p.Description == "" || len(p.Plan) != 3 {
		t.Fatalf("链式构造异常: desc=%q steps=%d", p.Description, len(p.Plan))
	}
	if p.Plan[1].SizeBytes != 3 {
		t.Errorf("step2 应有文件大小 3，得到 %d", p.Plan[1].SizeBytes)
	}
	if p.Extra["as"] != "bot" {
		t.Errorf("Extra[as] 未写入: %v", p.Extra)
	}
}
