package cmdutil

import "os"

// DryRunPlan 描述一个 dry-run 输出的多步编排计划。
//
// 由 CommandDef.DryRun 钩子返回，框架在 pipeline.go 的 dry-run 分支自动
// 序列化到 envelope.data（规范 §9.2、cli-protocol.md §1.6）：
//
//	{
//	  "ok": true,
//	  "data": {
//	    "dry_run": true,
//	    "description": "...",
//	    "plan": [
//	      {"step": 1, "method": "POST", "url": "...", "body": {...}},
//	      {"step": 2, "method": "POST", "url": "...", "file": "/path", "size_bytes": 12345}
//	    ]
//	  },
//	  "meta": {"endpoint": "...(dry-run)"}
//	}
type DryRunPlan struct {
	Description string         `json:"description"`
	Plan        []DryRunStep   `json:"plan"`
	Extra       map[string]any `json:"extra,omitempty"`
}

// DryRunStep 是 dry-run 计划里的一步将执行的 HTTP 调用。
type DryRunStep struct {
	Step      int    `json:"step"`
	Method    string `json:"method"`
	URL       string `json:"url"`
	Body      any    `json:"body,omitempty"`
	File      string `json:"file,omitempty"`       // 此步上传的文件路径
	SizeBytes int64  `json:"size_bytes,omitempty"` // 文件大小（File(path) 时自动 os.Stat 填充）
}

// NewDryRunPlan 返回一个空白计划。配合链式 builder 使用：
//
//	cmdutil.NewDryRunPlan().
//	    Desc("3-step orchestration: create block → upload media → bind").
//	    Step("POST", "/api/tabdoc/documents/{id}/blocks", blockBody).
//	    Step("POST", "/api/services/oss/upload").File("/tmp/img.png").
//	    Step("PATCH", "/api/tabdoc/documents/{id}/blocks/{block_id}", bindBody)
func NewDryRunPlan() *DryRunPlan {
	return &DryRunPlan{
		Plan: make([]DryRunStep, 0, 4),
	}
}

// Desc 设置整体描述。
func (p *DryRunPlan) Desc(s string) *DryRunPlan {
	p.Description = s
	return p
}

// Step 追加一步 HTTP 调用。body 是可变参数，最多取第一个；不传即不带 body。
//
// 多个 body 参数会被忽略——这是 fluent builder 的设计：
//
//	.Step("GET", "/x")               // 无 body
//	.Step("POST", "/y", payload)     // 带 body
func (p *DryRunPlan) Step(method, url string, body ...any) *DryRunPlan {
	step := DryRunStep{
		Step:   len(p.Plan) + 1,
		Method: method,
		URL:    url,
	}
	if len(body) > 0 {
		step.Body = body[0]
	}
	p.Plan = append(p.Plan, step)
	return p
}

// File 给"最近追加的那一步"挂上一个待上传文件路径，并自动 os.Stat 取文件大小填到
// SizeBytes。文件不存在 / 无权限读时 SizeBytes 留 0，不报错——dry-run 本来就是
// 预演，不应因文件检查失败而阻塞。
//
// 在没有 Step 的情况下调用 File 是 no-op（防御）。
func (p *DryRunPlan) File(path string) *DryRunPlan {
	if len(p.Plan) == 0 {
		return p
	}
	last := &p.Plan[len(p.Plan)-1]
	last.File = path
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		last.SizeBytes = info.Size()
	}
	return p
}

// Body 给"最近追加的那一步"挂上 body。等价于 `.Step(method, url, body)` 但用链式分两步
// 更可读：`.Step("POST", "/x").Body(payload)`。
//
// 在没有 Step 的情况下调用 Body 是 no-op（防御）。
func (p *DryRunPlan) Body(body any) *DryRunPlan {
	if len(p.Plan) == 0 {
		return p
	}
	p.Plan[len(p.Plan)-1].Body = body
	return p
}

// Set 写一个 key/value 到 Extra 元数据 map。给"步骤之外的附加信息"用，如
// `as: bot` / `placeholder_refs: ${step1.id}` 等（规范 §10）。
func (p *DryRunPlan) Set(k string, v any) *DryRunPlan {
	if p.Extra == nil {
		p.Extra = make(map[string]any)
	}
	p.Extra[k] = v
	return p
}
