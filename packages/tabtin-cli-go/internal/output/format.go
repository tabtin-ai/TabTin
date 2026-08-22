package output

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

var noColor bool

func SetNoColor(v bool) { noColor = v }
func IsNoColor() bool   { return noColor || os.Getenv("NO_COLOR") != "" }

// IsTerminal 报告 stdout 是否连到 TTY——formatValue 中 datetime 渲染按 TTY 切换相对/ISO。
// 注意：output 包不能 import cmdutil（cmdutil 已经 import output），所以本地复制。
func IsTerminal() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

// quietMode 控制 PrintResult / PrintResultWithSchema 是否抑制 stdout 输出（Sprint 1.C --quiet）。
//
// 协议（cli-spec.md §10）：
//   - 成功路径：stdout 抑制（含 batch 每行 + summary）
//   - 失败路径：error envelope 不抑制（PrintError 独立通道，必出）
//   - dry-run：stdout plan 不抑制（plan 是核心信息，agent 必须看到）
//   - transport / Daemon 提示等 "进度提示"类 stderr：由调用方判断 IsQuiet() 决定是否打
var quietMode bool

// SetQuietMode 由 cmd/root.go PersistentPreRun 在 --quiet/-Q/TABTIN_QUIET=1 时设 true。
func SetQuietMode(v bool) { quietMode = v }

// IsQuietMode 返回当前是否 quiet——stderr 提示类的调用方用它决定要不要打。
func IsQuietMode() bool { return quietMode || os.Getenv("TABTIN_QUIET") == "1" }

// globalOutputPath 是 root PersistentFlag `--output` 的值（仅 root persistent 自己被
// Changed 时设）。
//
// 关键设计（TabData v10 P0/P1 修复）：
//   - 必须只在 rootCmd.PersistentFlags().Lookup("output").Changed=true 时 set；child
//     命令的同名 -o 被 cobra inherit 是不能算的——否则 `table export csv -o /tmp/x.csv`
//     会让 root 也以为 globalOutputPath=/tmp/x.csv 造成双重写盘
//   - PrintResultWithSchema 入口看 globalOutputPath，非空时统一走全局写盘——
//     不论是 pipeline 命令还是手写命令（如 commands）都生效
var globalOutputPath string

// SetGlobalOutputPath 由 cmd/root.go PersistentPreRunE 设——仅在 root persistent --output
// 自己 Changed 时调用，且必须穿透前已 jq 互斥校验过。
func SetGlobalOutputPath(p string) { globalOutputPath = p }

// GetGlobalOutputPath 返回当前全局写盘路径——空字符串表示未设。
func GetGlobalOutputPath() string { return globalOutputPath }

// ResetGlobalOutputPath 仅供测试用。
func ResetGlobalOutputPath() { globalOutputPath = "" }

// globalJQ 是 root PersistentFlag `--jq` 的值。
//
// v10.3 P0 修复：之前 jq 只在 pipeline.go 内部应用（line 874），手写命令（commands /
// search 等）和 dry-run plan 都完全绕过 jq——破协议。v10.7 P1：agent run json 模式也收回。
//
// 现在 jq 作为全局输出层协议在 `PrintResultWithSchema / PrintResultForce` 入口先应用：
//   - 优先级：jq → globalOutputPath（写盘）→ quiet（抑 stdout）→ stdout
//   - 即 `--jq` 处理后再决定写盘还是 stdout；--jq 结果是显式请求，与 --output 同等待遇不被 quiet 抑
//   - --jq + --output 已在 root.PersistentPreRunE / pipeline.go / cmd/api.go 拦成 VALIDATION_ERROR
//   - jq 失败一律 VALIDATION_ERROR + ExitValidation（v10.5 P1 修正，原为 ExitGeneral）
var globalJQ string

// SetGlobalJQ 由 cmd/root.go PersistentPreRunE 在 root --jq Changed 时调用。
func SetGlobalJQ(expr string) { globalJQ = expr }

// GetGlobalJQ 返回当前 jq 表达式（空字符串表示未设）。
func GetGlobalJQ() string { return globalJQ }

// ResetGlobalJQ 仅供测试用。
func ResetGlobalJQ() { globalJQ = "" }

// applyGlobalJQAndUnwrap 在 jq 应用前先解 envelope.data（让用户写 `.foo` 而不是 `.data.foo`）。
// 失败时调用 PrintError + os.Exit——保持与其他 PrintResult* 系列一致的失败路径（无返回 err）。
//
// 返回 (jq 处理后的数据, 是否要继续走渲染路径)：
//   - globalJQ 为空：原样返回 data，true
//   - jq 成功：返回结果（标量/数组/对象），true（继续按 format 渲染）
//   - jq 失败：PrintError + os.Exit，永不返回
func applyGlobalJQAndUnwrap(data any) any {
	if globalJQ == "" {
		return data
	}
	jqData := unwrapForJQ(data)
	result, err := ApplyJQ(jqData, globalJQ)
	if err != nil {
		// v10.5 P1 修复：jq 表达式语法错是**用户输入校验错误**，应是 ExitValidation (2)
		// 而非 ExitGeneral (1)——与 --output + --jq 互斥（ExitValidation）保持一致，
		// agent 收到 exit 2 就明确"是我传错了 flag/值"，不是后端故障。
		//
		// ：报错必须带解包后顶层的实际形状——Agent 反复盲试
		// "expected object but got array" 的根因是不知道数据长什么样。
		hint := "检查 jq 表达式语法（如 '.items | length'）；--jq 已自动解包 envelope.data，直接写字段名（如 '.content'），不要带 .data 前缀；" + describeJQShape(jqData)
		PrintError(ErrorEnvelope(
			"VALIDATION_ERROR",
			fmt.Sprintf("--jq 处理失败：%s", err.Error()),
			hint,
			ExitValidation,
		))
		os.Exit(ExitValidation)
	}
	return result
}

// describeJQShape 描述解包后数据的顶层形状，给 --jq 失败的 Agent 一次改对所需的最小信息。
func describeJQShape(data any) string {
	switch v := data.(type) {
	case nil:
		return "解包后顶层是 null——上游没有 data 内容，检查命令本身的输出"
	case []any:
		return fmt.Sprintf("解包后顶层是 array（%d 项），试 '.[] | ...' 或 '.[0]'", len(v))
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
			if len(keys) >= 8 {
				break
			}
		}
		sort.Strings(keys)
		return fmt.Sprintf("解包后顶层是 object，keys 含: %s", strings.Join(keys, ", "))
	case string:
		return "解包后顶层是 string 标量，无字段可取"
	case bool:
		return "解包后顶层是 bool 标量，无字段可取"
	default:
		return "解包后顶层是 number 标量，无字段可取"
	}
}

// unwrapForJQ 在应用 jq 之前先解一层 envelope.data——让 `--jq '.foo'` 直接拿 data.foo
// 而不是写 `.data.foo`。这是与 pipeline 旧行为对齐：之前 pipeline.go 也调用了
// output.UnwrapDjangoEnvelope。
//
// 三种形态：
//  1. *Envelope：返 Data 字段（Unmarshal 出来）
//  2. map[string]any 且含 "ok"+"data"：返 data 字段
//  3. 其他：原样
func unwrapForJQ(data any) any {
	if env, ok := data.(*Envelope); ok && env != nil && len(env.Data) > 0 {
		var inner any
		if json.Unmarshal(env.Data, &inner) == nil {
			return inner
		}
	}
	if m, ok := data.(map[string]any); ok {
		if _, hasOk := m["ok"]; hasOk {
			if d, hasData := m["data"]; hasData {
				return d
			}
		}
		// Django legacy {success: true, data: ...} 也解一层
		if _, hasSuccess := m["success"]; hasSuccess {
			if d, hasData := m["data"]; hasData {
				return d
			}
		}
	}
	return data
}

type Format string

const (
	FormatJSON   Format = "json"
	FormatTable  Format = "table"
	FormatCSV    Format = "csv"
	FormatPretty Format = "pretty"
	FormatAgent  Format = "agent"
)

// ParseFormat 是**容错**解析——未知值（含空串）静默回退 FormatJSON。
//
// 适用场景：
//   - cfg.Defaults.Format 历史脏值不该让 CLI 启动直接挂
//   - 任何内部路径里 Format 已经被早层校验过、这里只是 cast
//
// CLI 显式 `--format` 用户输入**不要**走这条——非法值会被静默吞掉，
// 看起来 flag 生效实际跑到 json，这是 v10.12 P1 修的"silent accept"漏洞。
// 显式入口请用 ParseFormatStrict。
func ParseFormat(s string) Format {
	switch strings.ToLower(s) {
	case "json":
		return FormatJSON
	case "table":
		return FormatTable
	case "csv":
		return FormatCSV
	case "pretty":
		return FormatPretty
	case "agent":
		return FormatAgent
	default:
		return FormatJSON
	}
}

// ValidFormats 是全局 --format 接受的闭集（cli-spec.md §6.3）。
// 顺序与 root.go 帮助文本对齐，错误消息也按此顺序列。
var ValidFormats = []string{"json", "table", "csv", "pretty", "agent"}

// ParseFormatStrict 是**严格**解析——只接受 ValidFormats 闭集（大小写不敏感），
// 其余返回 error。CLI 显式 `--format` 用户输入必须走这条。
//
// 错误形态：error.Error() 返回带"可选值"列表的人话，
// 调用方应套 ErrorEnvelope(ValidationError, ..., exit 2) 输出。
func ParseFormatStrict(s string) (Format, error) {
	switch strings.ToLower(s) {
	case "json":
		return FormatJSON, nil
	case "table":
		return FormatTable, nil
	case "csv":
		return FormatCSV, nil
	case "pretty":
		return FormatPretty, nil
	case "agent":
		return FormatAgent, nil
	default:
		return "", fmt.Errorf("非法 --format 值 %q，可选：%s", s, strings.Join(ValidFormats, " | "))
	}
}

// PrintResult 输出数据到 stdout（无 schema 信息，table/agent/csv 走启发式列推断）。
//
// 命令应该用 PrintResultWithSchema 让 schema-aware 渲染生效；保留本函数供旧路径继续用。
func PrintResult(data any, format Format) {
	PrintResultWithSchema(data, format, nil)
}

// PrintResultForce 绕过 quiet 模式强制输出——用于 dry-run plan 等"核心信息不抑制"场景
// （决策 C1：dry-run plan 不能因 quiet 被吞，agent 必须看得到）。
//
// 注意：PrintResultForce 也走全局 --output 写盘——dry-run plan 输出到文件也是合法的
// （用户可能 dry-run 后想保留 plan 做 review）。
// 顺序与 PrintResultWithSchema 一致：jq → --output → stdout（quiet 不阻断显式写盘也不抑 force 的 stdout）。
//
// v10.3 P0 修复：dry-run + jq 也必须工作——`tabtin doc list --dry-run --jq '.plan'`
// 之前完全绕过 jq 输出 envelope；现在 jq 先应用，让 agent 能拿到关心的字段。
//
// ：Force 路径同样经体量闸门（printOrSpill）——超大 dry-run plan 也会落盘换
// file_ref，Agent 仍能读文件，不违背「必出」（要完整内联可加 --inline）。
func PrintResultForce(data any, format Format) {
	data = applyGlobalJQAndUnwrap(data)
	if globalOutputPath != "" {
		writeResultToFile(globalOutputPath, data, format, nil)
		return
	}
	printOrSpill(data, format, nil)
}

// PrintResultWithSchema 输出数据到 stdout，带 OutputSchema 上下文。
//
// 行为（Sprint 1.C）：
//   - **quiet 模式 stdout 抑制**——成功路径不输出；error envelope 走 PrintError 独立通道不受影响
//   - format=json/pretty：忽略 schema（envelope 已经是结构化 JSON）
//   - format=table/agent：schema 非空时按 schema 顺序 + Label 渲染；schema 为空 fallback orderedKeys 启发式
//   - format=csv：schema 非空时 header 用 Key（不是 Label，机器解析友好）；为空 fallback
//
// data 可能是：
//  1. envelope 整体（map[string]any 含 "ok"/"data" 等字段）
//  2. envelope.data 已经解出来的值——可能是数组、单 map、或容器 map（{documents:[...]}）
//
// 启发式：data 是容器 map（{documents:[...]}）时找首个数组字段 + 数组元素 key 与 schema key
// 交集 ≥ 50% 视为命中；多个数组都达标选交集占比最高的；都不达标 fallback。
func PrintResultWithSchema(data any, format Format, schema []FieldSchema) {
	printResultWithSchema(data, format, schema, false)
}

// PrintResultWithSchemaInline 同 PrintResultWithSchema，但**跳过大输出落盘兜底**。
//
// 用于「命令目录 / 能力自描述」这类协议输出——消费方是程序（如 agent-runtime 子进程解析
// `tabtin commands`），不是 LLM 上下文。这类输出即便超过 64KB 也必须完整内联，否则落盘换成
// file_ref 摘要会直接破坏能力发现 / schema 解析。
func PrintResultWithSchemaInline(data any, format Format, schema []FieldSchema) {
	printResultWithSchema(data, format, schema, true)
}

func printResultWithSchema(data any, format Format, schema []FieldSchema, forceInline bool) {
	// v10.3 P0 修复：协议层最终顺序（必须严格遵守，所有 PrintResult* 入口对齐）：
	//   1. jq 过滤（globalJQ）——成功路径数据变形最先发生；jq 失败 → VALIDATION_ERROR + ExitValidation (v10.5 P1)
	//   2. globalOutputPath 写盘——优先于 stdout（quiet 也不阻断显式写盘动作）
	//   3. IsQuietMode 抑 stdout（仅当 jq 也没设时）——
	//      关键：--jq 是**显式输出请求**，与 --output 同等待遇——quiet 不阻断 jq 结果
	//      （否则 `--quiet --jq '.id'` 静默无输出，违反"显式请求必出"的协议）
	//
	// 注意：jq 应用后 schema 大概率不再匹配（如 `.[0].id` 返回标量），
	// 但仍要把 schema 传下游：format=json/pretty 时 schema 被忽略，table/agent/csv 走
	// schemaMatchesRows 启发式自然回落到 fallback——不会因 schema 不匹配崩溃。
	jqActive := globalJQ != ""
	data = applyGlobalJQAndUnwrap(data)
	if globalOutputPath != "" {
		writeResultToFile(globalOutputPath, data, format, schema)
		return
	}
	if IsQuietMode() && !jqActive {
		return // quiet：成功 stdout 抑制；error envelope 走 PrintError 不受此影响
	}
	if forceInline {
		writeResult(os.Stdout, data, format, schema) // 协议输出：跳过落盘兜底（见 PrintResultWithSchemaInline）
		return
	}
	printOrSpill(data, format, schema)
}

// printOrSpill 是 stdout 成功输出的统一出口——先渲染到内存缓冲，经体量闸门（maybeSpill）
// 决定内联还是落盘（ 第二层）。这是 jq/--output/quiet 之后的最后一环。
func printOrSpill(data any, format Format, schema []FieldSchema) {
	var buf bytes.Buffer
	writeResult(&buf, data, format, schema)
	_, _ = os.Stdout.Write(maybeSpill(buf.Bytes(), format))
}

// writeResult 把渲染逻辑抽出来——既给 stdout 用，也给写盘用。
func writeResult(w io.Writer, data any, format Format, schema []FieldSchema) {
	switch format {
	case FormatJSON:
		printJSON(w, data)
	case FormatTable:
		printTableWithSchema(w, data, schema)
	case FormatCSV:
		printCSVWithSchema(w, data, schema)
	case FormatPretty:
		printPretty(w, data)
	case FormatAgent:
		printAgentWithSchema(w, data, schema)
	default:
		printJSON(w, data)
	}
}

// writeResultToFile 把渲染结果写到文件——路径不存在 / 无权限走 PrintError + os.Exit。
//
// 设计：
//   - 写盘后**不再**输出 stdout（决策：写盘语义即"不要在 stdout 重复"）
//   - 失败一律 PrintError + os.Exit(ExitGeneral)——CLI 无法 return error 给上层（PrintResult 类签名）
//   - 写盘成功 stderr 不打提示——避免污染机器解析（用户已用 --output 表示要文件）
//   - ：`doc export --output out.md --format json` 若仍写 JSON 信封，
//     Agent 会把 `{content,filename,mime_type}` 当 markdown 文件。对内容型扩展名
//     且 payload 是导出示样（含 content 字符串）时，改写 raw 正文。
func writeResultToFile(path string, data any, format Format, schema []FieldSchema) {
	if raw, ok := extractRawExportContentForOutputFile(path, data); ok {
		if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
			PrintError(ErrorEnvelope(
				"IO_ERROR",
				fmt.Sprintf("--output 写盘失败：%s", err.Error()),
				fmt.Sprintf("检查路径是否可写：%s（目录需存在 + 有写权限）", path),
				ExitGeneral,
			))
			os.Exit(ExitGeneral)
		}
		return
	}

	f, err := os.Create(path)
	if err != nil {
		PrintError(ErrorEnvelope(
			"IO_ERROR",
			fmt.Sprintf("--output 写盘失败：%s", err.Error()),
			fmt.Sprintf("检查路径是否可写：%s（目录需存在 + 有写权限）", path),
			ExitGeneral,
		))
		os.Exit(ExitGeneral)
	}
	defer f.Close()
	writeResult(f, data, format, schema)
}

// extractRawExportContentForOutputFile · 。
// 仅当目标路径像内容文件，且 payload 是 tabdoc export 形态（content + format）时返回 raw。
func extractRawExportContentForOutputFile(path string, data any) (string, bool) {
	if !outputPathLooksLikeDocumentContentFile(path) {
		return "", false
	}
	payload := unwrapForExportContent(data)
	m, ok := payload.(map[string]any)
	if !ok {
		return "", false
	}
	content, ok := m["content"].(string)
	if !ok {
		return "", false
	}
	format, _ := m["format"].(string)
	if !looksLikeExportContentPayload(m) {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "markdown", "html", "txt", "text":
		return content, true
	default:
		return "", false
	}
}

func looksLikeExportContentPayload(m map[string]any) bool {
	if filename, ok := m["filename"].(string); ok && filename != "" {
		return true
	}
	if mimeType, ok := m["mime_type"].(string); ok && strings.HasPrefix(strings.ToLower(mimeType), "text/") {
		return true
	}
	return false
}

func outputPathLooksLikeDocumentContentFile(path string) bool {
	lower := strings.ToLower(strings.TrimSpace(path))
	for _, ext := range []string{".md", ".markdown", ".html", ".htm", ".txt"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

func unwrapForExportContent(data any) any {
	switch v := data.(type) {
	case *Envelope:
		if v == nil || len(v.Data) == 0 {
			return data
		}
		var inner any
		if json.Unmarshal(v.Data, &inner) != nil {
			return data
		}
		return unwrapForExportContent(inner)
	case Envelope:
		if len(v.Data) == 0 {
			return data
		}
		var inner any
		if json.Unmarshal(v.Data, &inner) != nil {
			return data
		}
		return unwrapForExportContent(inner)
	case map[string]any:
		if _, hasOk := v["ok"]; hasOk {
			if d, ok := v["data"]; ok {
				return unwrapForExportContent(d)
			}
		}
		if _, hasSuccess := v["success"]; hasSuccess {
			if d, ok := v["data"]; ok {
				return unwrapForExportContent(d)
			}
		}
		return v
	default:
		return data
	}
}

// resolveTabularData 把 data 解析为"实际要表格化的数组" + 是否使用 schema 的决定。
//
// 处理三种形态：
//  1. data 本身是 []any → 直接返回
//  2. data 是 map 且含 "ok"/"data" envelope → 解 data 字段后递归
//  3. data 是容器 map（{documents:[...], total:n}）→ 启发式找首个数组字段，
//     若 schema 非空则检查交集比例 ≥ 50% 才用 schema，否则视为命中但不用 schema
//
// 返回：([]map[string]any 行集合, bool schema 是否命中)。
func resolveTabularData(data any, schema []FieldSchema) ([]map[string]any, bool) {
	// 0. *Envelope / Envelope 解包——SuccessEnvelope 返的是 *Envelope，Data 是
	// json.RawMessage（[]byte），需要先 Unmarshal 成 any 才能 type switch。
	// 这是 v10 P2 修复：之前 type switch 直接漏，data=*Envelope → 全 fallback printJSON。
	if env, ok := data.(*Envelope); ok && env != nil {
		if len(env.Data) > 0 {
			var inner any
			if json.Unmarshal(env.Data, &inner) == nil {
				return resolveTabularData(inner, schema)
			}
		}
		return nil, false
	}
	if env, ok := data.(Envelope); ok {
		if len(env.Data) > 0 {
			var inner any
			if json.Unmarshal(env.Data, &inner) == nil {
				return resolveTabularData(inner, schema)
			}
		}
		return nil, false
	}

	// 1. map envelope 解包（手写命令 PrintResult(map{ok,data,...}, format)）
	if m, ok := data.(map[string]any); ok {
		if _, hasOk := m["ok"]; hasOk {
			if d, ok2 := m["data"]; ok2 {
				return resolveTabularData(d, schema)
			}
		}
	}

	// 2. 直接是数组
	if arr, ok := data.([]any); ok {
		rows := arrayToRows(arr)
		return rows, schemaMatchesRows(schema, rows)
	}
	if rows, ok := data.([]map[string]any); ok {
		return rows, schemaMatchesRows(schema, rows)
	}

	// 3. 容器 map：找首个匹配度最高的数组字段
	if m, ok := data.(map[string]any); ok {
		bestRows := []map[string]any(nil)
		bestRatio := -1.0
		bestSchemaHit := false
		for _, v := range m {
			// 兼容三种数组形态：
			//   - []any (json.Unmarshal 默认产物)
			//   - []map[string]any (调用方手工构造)
			//   - []SomeStruct (调用方传 typed slice 进来)
			var rows []map[string]any
			if arr, isArr := v.([]any); isArr {
				rows = arrayToRows(arr)
			} else if rs, isRows := v.([]map[string]any); isRows {
				rows = rs
			} else {
				// 用 reflect 兼容 typed slice / typed map
				rv := reflect.ValueOf(v)
				if rv.Kind() != reflect.Slice {
					continue
				}
				rows = make([]map[string]any, 0, rv.Len())
				for i := 0; i < rv.Len(); i++ {
					if m2, ok2 := rv.Index(i).Interface().(map[string]any); ok2 {
						rows = append(rows, m2)
					} else {
						// 用 json marshal/unmarshal 转 map（兜底 struct → map）
						b, err := json.Marshal(rv.Index(i).Interface())
						if err != nil {
							continue
						}
						var m3 map[string]any
						if json.Unmarshal(b, &m3) == nil {
							rows = append(rows, m3)
						}
					}
				}
			}
			if len(rows) == 0 {
				continue
			}
			ratio := schemaCoverageRatio(schema, rows)
			schemaHit := schemaMatchesRows(schema, rows)
			// 优先选 schema 匹配的；否则选 ratio 最高的
			if schemaHit && !bestSchemaHit {
				bestRows = rows
				bestRatio = ratio
				bestSchemaHit = true
			} else if schemaHit == bestSchemaHit && ratio > bestRatio {
				bestRows = rows
				bestRatio = ratio
				bestSchemaHit = schemaHit
			}
		}
		if bestRows != nil {
			return bestRows, bestSchemaHit
		}
	}
	return nil, false
}

// arrayToRows 把任意 []any 转为 []map[string]any（非 map 元素填 "value" key）。
func arrayToRows(arr []any) []map[string]any {
	rows := make([]map[string]any, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			rows = append(rows, m)
		} else {
			rows = append(rows, map[string]any{"value": item})
		}
	}
	return rows
}

// schemaCoverageRatio 计算 schema key 在 rows 元素 key 集合里的覆盖率。
func schemaCoverageRatio(schema []FieldSchema, rows []map[string]any) float64 {
	if len(schema) == 0 || len(rows) == 0 {
		return 0
	}
	keys := map[string]bool{}
	for _, r := range rows {
		for k := range r {
			keys[k] = true
		}
	}
	hit := 0
	for _, f := range schema {
		if keys[f.Key] {
			hit++
		}
	}
	return float64(hit) / float64(len(schema))
}

// schemaMatchesRows 判定 schema 是否"命中" rows——交集占比 ≥ 50% 视为命中。
func schemaMatchesRows(schema []FieldSchema, rows []map[string]any) bool {
	if len(schema) == 0 {
		return false
	}
	return schemaCoverageRatio(schema, rows) >= 0.5
}

var activeFormat Format

func SetActiveFormat(f Format) { activeFormat = f }
func ActiveFormat() Format     { return activeFormat }

// PrintError 始终把 error envelope 以 JSON 形式写到 stderr。
//
// v10.10 P1 修复：之前 activeFormat == FormatAgent 时会走 printErrorAgent 输出
// 裸 "Error: ... / Hint: ..." 文本——直接违反 "error envelope 必出"协议
// （cli-spec.md §1 / §6.3 / §10 全部承诺错误是 envelope），且让 agent 端在
// --format agent 下无法稳定解析错误。
//
// 协议：error envelope 是机器可读的失败信号——不受成功路径 --format 影响。
// 成功路径 --format agent 走 Markdown 表格（PrintResultWithSchema 内）；
// 失败路径仍是 JSON envelope（本函数 + 调用方 SafeRunE 走的也是 envelope）。
//
// 如果用户真需要把错误转 markdown 给 LLM 看，请显式调 FormatErrorAgent helper
// （不能由 PrintError 自动接管）。
func PrintError(env *Envelope) {
	enc := json.NewEncoder(os.Stderr)
	enc.SetIndent("", "  ")
	_ = enc.Encode(env)
}

func PrintErrorAndExit(env *Envelope) error {
	PrintError(env)
	code := ExitGeneral
	if env.Meta != nil && env.Meta.ExitCode != 0 {
		code = env.Meta.ExitCode
	}
	return NewExitError(code)
}

// FormatErrorAgent 把 error envelope 渲染成人类可读的 "Error: ... / Hint: ..." 文本。
//
// v10.10 P1：这是**显式 helper**——只在调用方明确想给人看 markdown 风格时用。
// PrintError 不再自动调用本函数（避免把 stderr 协议打成裸文本）。
//
// 典型用法：CLI shell 包装器把 envelope 转人话提示，或者测试断言。
func FormatErrorAgent(w io.Writer, env *Envelope) {
	if env.Error != nil {
		fmt.Fprintf(w, "Error: %s\n", env.Error.Message)
		if env.Error.Hint != "" {
			fmt.Fprintf(w, "Hint: %s\n", env.Error.Hint)
		}
	}
}

func printJSON(w io.Writer, data any) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(data)
}

func printTable(w io.Writer, data any) {
	printTableWithSchema(w, data, nil)
}

// printTableWithSchema 按 OutputSchema 渲染表格——schema 非空且命中时用 Label 作表头、按 schema 顺序排列；
// schema 为空或不命中时 fallback 到 orderedKeys 启发式（旧行为）。
//
// 启发式容器检测：data 是 {documents:[...]} 这种 envelope.data 容器 map 时自动找首个匹配数组字段。
func printTableWithSchema(w io.Writer, data any, schema []FieldSchema) {
	// 1. 启发式找出真正的 rows + schema 是否命中
	rows, schemaHit := resolveTabularData(data, schema)
	if len(rows) == 0 {
		// 没有可表格化的数据——fallback 到 toSliceOfMaps（旧逻辑）
		items, ok := toSliceOfMaps(data)
		if !ok || len(items) == 0 {
			printJSON(w, data)
			return
		}
		rows = items
	}

	// 2. 决定列：schema 命中用 schema 顺序；否则 orderedKeys
	var keys []string
	var headers []string
	if schemaHit {
		keys = make([]string, len(schema))
		headers = make([]string, len(schema))
		for i, f := range schema {
			keys[i] = f.Key
			if f.Label != "" {
				headers[i] = f.Label
			} else {
				headers[i] = f.Key
			}
		}
	} else {
		keys = orderedKeys(rows[0])
		headers = keys
	}

	// 3. 渲染（schemaHit 时按 schema 的 Type 格式化每个值）
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(headers, "\t"))
	fmt.Fprintln(tw, strings.Repeat("─\t", len(keys)))
	for _, item := range rows {
		vals := make([]string, len(keys))
		for i, k := range keys {
			var fieldType string
			if schemaHit {
				fieldType = schema[i].Type
			}
			vals[i] = formatValue(item[k], fieldType)
		}
		fmt.Fprintln(tw, strings.Join(vals, "\t"))
	}
	tw.Flush()
}

func printCSV(w io.Writer, data any) {
	printCSVWithSchema(w, data, nil)
}

// printCSVWithSchema 按 OutputSchema 渲染 CSV——header 用 Key（不是 Label，因为 CSV
// 是机器解析格式；中文表头会破 import 工具，决策 C3）。
func printCSVWithSchema(w io.Writer, data any, schema []FieldSchema) {
	rows, schemaHit := resolveTabularData(data, schema)
	if len(rows) == 0 {
		items, ok := toSliceOfMaps(data)
		if !ok || len(items) == 0 {
			printJSON(w, data)
			return
		}
		rows = items
	}

	var keys []string
	if schemaHit {
		keys = make([]string, len(schema))
		for i, f := range schema {
			keys[i] = f.Key
		}
	} else {
		keys = orderedKeys(rows[0])
	}

	cw := csv.NewWriter(w)
	_ = cw.Write(keys)
	for _, item := range rows {
		row := make([]string, len(keys))
		for i, k := range keys {
			// CSV 是机器格式，缺失值必须写空字符串而不是 "<nil>"——
			// 否则下游 pandas / Excel / jq 导入会把 "<nil>" 当字符串值，
			// 与真正的 string "nil" 混淆（TabData v10.1 P1 修复）。
			v, exists := item[k]
			if !exists || v == nil {
				row[i] = ""
				continue
			}
			row[i] = fmt.Sprintf("%v", v)
		}
		_ = cw.Write(row)
	}
	cw.Flush()
}

func printPretty(w io.Writer, data any) {
	switch v := data.(type) {
	case map[string]any:
		printPrettyMap(w, v, 0)
	case []any:
		for i, item := range v {
			if i > 0 {
				fmt.Fprintln(w)
			}
			if m, ok := item.(map[string]any); ok {
				fmt.Fprintf(w, "── #%d ──\n", i+1)
				printPrettyMap(w, m, 1)
			} else {
				fmt.Fprintf(w, "%v\n", item)
			}
		}
	default:
		items, ok := toSliceOfMaps(data)
		if ok && len(items) > 0 {
			for i, item := range items {
				if i > 0 {
					fmt.Fprintln(w)
				}
				fmt.Fprintf(w, "── #%d ──\n", i+1)
				printPrettyMap(w, item, 1)
			}
		} else {
			printJSON(w, data)
		}
	}
}

func printPrettyMap(w io.Writer, m map[string]any, indent int) {
	prefix := strings.Repeat("  ", indent)
	keys := orderedKeys(m)
	maxKeyLen := 0
	for _, k := range keys {
		if len(k) > maxKeyLen {
			maxKeyLen = len(k)
		}
	}
	for _, k := range keys {
		val := m[k]
		padding := strings.Repeat(" ", maxKeyLen-len(k))
		switch v := val.(type) {
		case map[string]any:
			fmt.Fprintf(w, "%s%s%s:\n", prefix, k, padding)
			printPrettyMap(w, v, indent+1)
		case []any:
			if len(v) == 0 {
				fmt.Fprintf(w, "%s%s%s: []\n", prefix, k, padding)
			} else {
				fmt.Fprintf(w, "%s%s%s: [%d items]\n", prefix, k, padding, len(v))
			}
		default:
			fmt.Fprintf(w, "%s%s%s: %v\n", prefix, k, padding, val)
		}
	}
}

func toSliceOfMaps(data any) ([]map[string]any, bool) {
	v := reflect.ValueOf(data)
	if v.Kind() == reflect.Ptr {
		v = v.Elem()
	}
	if v.Kind() != reflect.Slice {
		return nil, false
	}
	result := make([]map[string]any, 0, v.Len())
	for i := 0; i < v.Len(); i++ {
		item := v.Index(i).Interface()
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		} else {
			raw, err := json.Marshal(item)
			if err != nil {
				return nil, false
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, false
			}
			result = append(result, m)
		}
	}
	return result, true
}

// printAgent outputs LLM-friendly plain text:
// - string → direct print
// - single map → key: value pairs
// - slice of maps → Markdown table
// - other → fmt fallback
func printAgent(w io.Writer, data any) {
	printAgentWithSchema(w, data, nil)
}

// printAgentWithSchema 同 printAgent 但 schema 命中时按 schema 顺序 + Label 渲染 Markdown 表格。
func printAgentWithSchema(w io.Writer, data any, schema []FieldSchema) {
	// 先尝试 schema-aware 容器解包
	if rows, schemaHit := resolveTabularData(data, schema); schemaHit && len(rows) > 0 {
		printAgentMarkdownTableWithSchema(w, rows, schema)
		return
	}
	// fallback 到旧逻辑
	switch v := data.(type) {
	case string:
		fmt.Fprintln(w, v)
	case map[string]any:
		printAgentMap(w, v)
	case []any:
		printAgentSlice(w, v)
	default:
		items, ok := toSliceOfMaps(data)
		if ok && len(items) > 0 {
			printAgentMarkdownTable(w, items)
		} else {
			fmt.Fprintf(w, "%v\n", data)
		}
	}
}

func printAgentMap(w io.Writer, m map[string]any) {
	keys := orderedKeys(m)
	for _, k := range keys {
		val := m[k]
		switch v := val.(type) {
		case map[string]any:
			raw, _ := json.Marshal(v)
			fmt.Fprintf(w, "%s: %s\n", k, string(raw))
		case []any:
			if len(v) == 0 {
				fmt.Fprintf(w, "%s: (empty)\n", k)
			} else {
				fmt.Fprintf(w, "%s: %d items\n", k, len(v))
			}
		default:
			fmt.Fprintf(w, "%s: %v\n", k, val)
		}
	}
}

func printAgentSlice(w io.Writer, items []any) {
	if len(items) == 0 {
		fmt.Fprintln(w, "(empty)")
		return
	}
	if _, ok := items[0].(map[string]any); ok {
		maps := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if m, ok := item.(map[string]any); ok {
				maps = append(maps, m)
			}
		}
		if len(maps) > 0 {
			printAgentMarkdownTable(w, maps)
			return
		}
	}
	for _, item := range items {
		fmt.Fprintf(w, "%v\n", item)
	}
}

const agentTableMaxRows = 50

// printAgentMarkdownTableWithSchema 按 schema 顺序 + Label 渲染 Markdown 表格（带 Type 格式化）。
//
// v10.1 P2 修复：单行也走 schema——之前 len(items)==1 直接 fallback printAgentMap，
// 会丢 schema 的 Label / 顺序 / Type 格式化。单行用 "key-value 列表"形态（不画表头表行）
// 保持紧凑可读，同时按 schema 顺序 + Label + Type 渲染。
func printAgentMarkdownTableWithSchema(w io.Writer, items []map[string]any, schema []FieldSchema) {
	if len(items) == 1 {
		printAgentSingleRowWithSchema(w, items[0], schema)
		return
	}
	headers := make([]string, len(schema))
	keys := make([]string, len(schema))
	for i, f := range schema {
		keys[i] = f.Key
		if f.Label != "" {
			headers[i] = f.Label
		} else {
			headers[i] = f.Key
		}
	}
	fmt.Fprintf(w, "| %s |\n", strings.Join(headers, " | "))
	seps := make([]string, len(headers))
	for i := range seps {
		seps[i] = "---"
	}
	fmt.Fprintf(w, "| %s |\n", strings.Join(seps, " | "))

	total := len(items)
	display := items
	if total > agentTableMaxRows {
		display = items[:agentTableMaxRows]
	}
	for _, item := range display {
		vals := make([]string, len(keys))
		for i, k := range keys {
			vals[i] = formatValue(item[k], schema[i].Type)
		}
		fmt.Fprintf(w, "| %s |\n", strings.Join(vals, " | "))
	}
	if total > agentTableMaxRows {
		fmt.Fprintf(w, "\n(showing %d of %d rows, use --format json for full output)\n", agentTableMaxRows, total)
	}
}

// printAgentSingleRowWithSchema 单行数据按 schema 渲染——"Label: Value" 列表形式。
//
// 单行场景常tabtin agent get / tabtin memo get / tabtin doc info 等查询单一资源。
// 保留 schema 的 Label（中文友好）+ 顺序 + Type 格式化（datetime/id/bool 渲染）。
func printAgentSingleRowWithSchema(w io.Writer, item map[string]any, schema []FieldSchema) {
	for _, f := range schema {
		label := f.Label
		if label == "" {
			label = f.Key
		}
		val := formatValue(item[f.Key], f.Type)
		fmt.Fprintf(w, "%s: %s\n", label, val)
	}
}

func printAgentMarkdownTable(w io.Writer, items []map[string]any) {
	if len(items) == 1 {
		printAgentMap(w, items[0])
		return
	}
	keys := orderedKeys(items[0])
	fmt.Fprintf(w, "| %s |\n", strings.Join(keys, " | "))
	seps := make([]string, len(keys))
	for i := range seps {
		seps[i] = "---"
	}
	fmt.Fprintf(w, "| %s |\n", strings.Join(seps, " | "))

	total := len(items)
	display := items
	if total > agentTableMaxRows {
		display = items[:agentTableMaxRows]
	}
	for _, item := range display {
		vals := make([]string, len(keys))
		for i, k := range keys {
			vals[i] = fmt.Sprintf("%v", item[k])
		}
		fmt.Fprintf(w, "| %s |\n", strings.Join(vals, " | "))
	}
	if total > agentTableMaxRows {
		fmt.Fprintf(w, "\n(showing %d of %d rows, use --format json for full output)\n", agentTableMaxRows, total)
	}
}

// formatValue 按 FieldSchema.Type 启发式渲染一个值——纯文本格式。
//
// Type 闭集（cli-protocol.md §7.3 / 与 packages/agent-runtime/src/capability/core/cli-output-render.ts
// normalizeSchemaType 对齐）：
//   - "":               %v
//   - "string":         %v
//   - "number":         %v（千分位由 stringifyNumber 处理）
//   - "id":             长度 > 12 时中段截断成 abcdef…789012（保留首 6 + 末 6）
//   - "datetime":       TTY 显示 "2h ago" 相对时间；非 TTY 显示 ISO 截断到秒
//   - "duration":       毫秒/秒转人话（"1.2s"、"35m"、"2h"），输入是数字或 "1500ms" 字符串
//   - "bool" / "boolean":  ✓/✗ if 解得出 bool；否则 %v
//   - "enum":           %v（着色由后续 TTY renderer 做）
//   - "json":           marshal 嵌套对象（最多 60 字符截断）
//
// TabData v10 P1 修复：补 boolean alias、datetime、duration、id 中段截断。
func formatValue(v any, fieldType string) string {
	if v == nil {
		return ""
	}
	switch fieldType {
	case "bool", "boolean":
		if b, ok := v.(bool); ok {
			if b {
				return "✓"
			}
			return "✗"
		}
		// JSON unmarshal 可能把 "true"/"false" 字符串带出来；兼容
		if s, ok := v.(string); ok {
			if s == "true" {
				return "✓"
			}
			if s == "false" {
				return "✗"
			}
		}
		return fmt.Sprintf("%v", v)
	case "id":
		s := fmt.Sprintf("%v", v)
		if len(s) > 12 {
			return s[:6] + "…" + s[len(s)-6:]
		}
		return s
	case "datetime":
		return formatDatetime(v)
	case "duration":
		return formatDuration(v)
	case "enum":
		// 着色暂不做（避免引入 color 依赖；TTY 染色留给后续 sink 层）。原样返回。
		return fmt.Sprintf("%v", v)
	case "json":
		if m, ok := v.(map[string]any); ok {
			raw, _ := json.Marshal(m)
			s := string(raw)
			if len(s) > 60 {
				s = s[:57] + "..."
			}
			return s
		}
		if arr, ok := v.([]any); ok {
			return fmt.Sprintf("[%d items]", len(arr))
		}
		return fmt.Sprintf("%v", v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// formatDatetime 把 ISO8601 / Unix epoch 数字格式化成易读时间。
//
//   - TTY：相对时间 "2h ago" / "3d ago"（用 IsTTY 检测，避免污染机器解析）
//   - 非 TTY：ISO8601 截断到秒（"2026-05-20T11:00:00Z"）；解不出来则原样
//
// 输入类型可能是：
//   - string ISO8601（Django 标准输出）
//   - float64 Unix epoch 秒（JSON unmarshal 默认）
//   - int64 Unix epoch 秒
func formatDatetime(v any) string {
	var t time.Time
	switch x := v.(type) {
	case string:
		parsed, err := parseISOTime(x)
		if err != nil {
			return x // 解不出来原样
		}
		t = parsed
	case float64:
		t = time.Unix(int64(x), 0)
	case int64:
		t = time.Unix(x, 0)
	case int:
		t = time.Unix(int64(x), 0)
	default:
		return fmt.Sprintf("%v", v)
	}
	// 非 TTY 用 ISO 截断到秒——机器友好
	if !IsTerminal() {
		return t.UTC().Format("2006-01-02T15:04:05Z")
	}
	// TTY 显示相对时间
	d := time.Since(t)
	if d < 0 {
		// 未来时间
		return t.Format("2006-01-02 15:04")
	}
	if d < time.Minute {
		return "just now"
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	if d < 30*24*time.Hour {
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
	return t.Format("2006-01-02")
}

// parseISOTime 尝试多种 ISO8601 格式——Django 默认带毫秒/纳秒/带或不带时区。
func parseISOTime(s string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano, // 2026-05-20T11:00:00.123456789Z
		time.RFC3339,     // 2026-05-20T11:00:00Z
		"2006-01-02T15:04:05.999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse %q", s)
}

// formatDuration 把毫秒/秒数字或 "1500ms"/"1.5s" 字符串转人话。
//
//   - < 1s:    "423ms"
//   - < 60s:   "1.2s"
//   - < 60m:   "35m"
//   - < 24h:   "2h"
//   - else:    "3d"
//
// 输入：
//   - float64/int 默认是毫秒（与 Django duration 字段约定对齐）
//   - string "Xms" / "Xs" 解出对应单位；其他原样
func formatDuration(v any) string {
	var ms float64
	switch x := v.(type) {
	case float64:
		ms = x
	case int:
		ms = float64(x)
	case int64:
		ms = float64(x)
	case string:
		// 尝试解 "Xms" / "Xs" / 纯数字
		s := strings.TrimSpace(x)
		if strings.HasSuffix(s, "ms") {
			n, err := strconv.ParseFloat(strings.TrimSuffix(s, "ms"), 64)
			if err != nil {
				return x
			}
			ms = n
		} else if strings.HasSuffix(s, "s") {
			n, err := strconv.ParseFloat(strings.TrimSuffix(s, "s"), 64)
			if err != nil {
				return x
			}
			ms = n * 1000
		} else {
			n, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return x
			}
			ms = n
		}
	default:
		return fmt.Sprintf("%v", v)
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", int(ms))
	}
	s := ms / 1000
	if s < 60 {
		return fmt.Sprintf("%.1fs", s)
	}
	m := s / 60
	if m < 60 {
		return fmt.Sprintf("%dm", int(m))
	}
	h := m / 60
	if h < 24 {
		return fmt.Sprintf("%dh", int(h))
	}
	return fmt.Sprintf("%dd", int(h/24))
}

func orderedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	priority := map[string]int{"id": 0, "name": 1, "type": 2, "status": 3}
	for i := 0; i < len(keys)-1; i++ {
		for j := i + 1; j < len(keys); j++ {
			pi, oki := priority[keys[i]]
			pj, okj := priority[keys[j]]
			if !oki {
				pi = 100
			}
			if !okj {
				pj = 100
			}
			if pi > pj || (pi == pj && keys[i] > keys[j]) {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}
