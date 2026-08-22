package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 大输出兜底落盘（ 第二层）。
//
// 第一层（browser-core 字段级 file_ref）负责已知大字段的精准替换；本层是 Go CLI 出口的
// 通用兜底——拿到的是**渲染完的字节流**、不知内容语义，只能整体落盘。因此阈值放宽到 64KB，
// 只兜「异常膨胀」（未接入第一层的命令、意外超大列表、忘传 --output 的整表导出等），
// 不干扰正常路径。
//
// 协议顺序（见 PrintResultWithSchema）：jq → --output → quiet → 体量闸门 → stdout。
// --output / --quiet 语义不变；--jq 过滤后才量（过滤后通常已小）；--inline 逃生阀跳过本层。
const (
	// maxInlineOutputBytes 是单次成功输出内联进 stdout 的上限；超过即整体落盘换摘要。
	maxInlineOutputBytes = 64 * 1024
	// spillPreviewBytes 是摘要里 preview 头部片段的字节数——够 agent 判断「是不是我要的内容」。
	spillPreviewBytes = 512
	// spillTTL 是落盘目录的保留时长；超期的日期目录在下次落盘时 best-effort 清理。
	spillTTL = 48 * time.Hour
)

// globalInline 是 root persistent flag `--inline` 的值——true 时禁用本层落盘，超限也直接
// 输出 stdout（人用管道 `tabtin ... | jq`、或显式要完整内联的场景）。
var globalInline bool

// SetGlobalInline 由 cmd/root.go PersistentPreRunE 在 --inline Changed 时调用。
func SetGlobalInline(v bool) { globalInline = v }

// ResetGlobalInline 仅供测试用。
func ResetGlobalInline() { globalInline = false }

// maybeSpill 决定渲染结果的去向，返回应写到 stdout 的字节：
//   - `--inline` 或未超限：原样返回 rendered；
//   - 超限：落盘到 ~/.tabtin/cli-outputs/<日期>/，返回带读取 hint 的 file_ref 摘要 JSON；
//   - 落盘失败：退回原样返回 rendered（绝不吞数据）。
func maybeSpill(rendered []byte, format Format) []byte {
	if globalInline || len(rendered) <= maxInlineOutputBytes {
		return rendered
	}
	path, err := writeSpillFile(rendered, spillExt(format))
	if err != nil {
		// 落盘失败不能让数据丢失——退回直接输出（宁可撑上下文，不可静默丢结果）。
		return rendered
	}
	return buildSpillSummary(rendered, path, format)
}

// buildSpillSummary 构造与 Envelope 同形（ok/data/meta）的摘要——data 是 file_ref，
// 让 agent 用同一套 `.data` 解析拿到路径与读取 hint。
func buildSpillSummary(rendered []byte, path string, format Format) []byte {
	summary := map[string]any{
		"ok": true,
		"data": map[string]any{
			"_type":   "file_ref",
			"path":    path,
			"bytes":   len(rendered),
			"lines":   bytes.Count(rendered, []byte("\n")) + 1,
			"preview": previewHead(rendered),
			"hint":    spillHint(format),
		},
		"meta": map[string]any{
			"spilled": true,
			"reason":  fmt.Sprintf("output exceeds inline limit (%dKB)", maxInlineOutputBytes/1024),
		},
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	// 关掉 HTML 转义：hint/preview 是给 Agent 读的操作指引，默认会把 < > & 转成 \u003c 等，
	// 导致 Agent 照抄 `jq '.data.<字段>'` 时命令失效。
	enc.SetEscapeHTML(false)
	_ = enc.Encode(summary)
	return buf.Bytes()
}

// writeSpillFile 把渲染结果写到 ~/.tabtin/cli-outputs/<日期>/cli-output-<纳秒>.<ext>，
// 返回绝对路径。落盘后顺带 best-effort 清理超期日期目录。
func writeSpillFile(content []byte, ext string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	root := filepath.Join(home, ".tabtin", "cli-outputs")
	dir := filepath.Join(root, time.Now().Format("2006-01-02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("cli-output-%d.%s", time.Now().UnixNano(), ext)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	cleanupSpillDir(root)
	return path, nil
}

// cleanupSpillDir best-effort 删除超过 spillTTL 的日期目录——按目录名（YYYY-MM-DD）解析，
// 不逐文件 stat，快且安全；任何错误静默（清理失败不影响本次输出）。
func cleanupSpillDir(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-spillTTL)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		day, err := time.Parse("2006-01-02", e.Name())
		if err != nil {
			continue // 非日期目录不碰
		}
		// 目录代表一整天，过完当天再算 TTL 起点，避免边界误删当天产物。
		if day.Add(24 * time.Hour).Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
}

// spillExt 按渲染格式选落盘文件扩展名——JSON/CSV 保留可解析扩展，其余按纯文本。
func spillExt(format Format) string {
	switch format {
	case FormatCSV:
		return "csv"
	case FormatJSON:
		return "json"
	default:
		return "txt"
	}
}

// spillHint 按格式给「怎么读」的引导——核心目的是提示 agent 按需读取而非整读回上下文。
func spillHint(format Format) string {
	switch format {
	case FormatJSON:
		return "输出超过 64KB 已落盘，请勿整读。文件保留完整 JSON envelope，业务数据位于 .data；用 jq 取字段：jq '.data.<字段>' <path>；或 grep -n '关键词' <path> 定位后 sed -n '起行,止行p' <path> 读片段。"
	case FormatCSV:
		return "输出超过 64KB 已落盘（CSV），请勿整读。head -n 20 <path> 看表头与样例；grep '关键词' <path> 过滤目标行。"
	default:
		return "输出超过 64KB 已落盘，请勿整读。grep -n '关键词' <path> 定位；sed -n '起行,止行p' <path> 读片段。"
	}
}

// previewHead 取头部片段作 preview——按 UTF-8 边界裁剪，剔除截断产生的半个多字节字符。
func previewHead(b []byte) string {
	if len(b) <= spillPreviewBytes {
		return strings.ToValidUTF8(string(b), "")
	}
	return strings.ToValidUTF8(string(b[:spillPreviewBytes]), "") + "…"
}
