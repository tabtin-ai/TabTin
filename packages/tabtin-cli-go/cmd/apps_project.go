package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// newCmdProject 暴露 Project 的统一 CLI 入口。Project 的物理成员关系仍复用
// SpaceMembership；CLI 使用 Project 产品语言，不把这一实现细节暴露给用户。
func newCmdProject(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "project",
		Short: "Project 协作与任务工作台",
	}

	membersCmd := &cobra.Command{
		Use:   "members",
		Short: "Project 成员",
	}
	cmdutil.MustRegisterCommand(membersCmd, f, cmdutil.CommandDef{
		Use:   "list <project-id>",
		Short: "列出 Project 成员",
		Long: `列出调用者有权访问的 Project 成员。
Project 当前复用 SpaceMembership 保存成员关系，命令会将其作为 Project 成员返回。
这是只读查询；不能用它枚举无权访问的 Project。`,
		Example: `  tabtin project members list <project-id>
  tabtin project members list <project-id> --format json
  tabtin project members list <project-id> --jq '.data.memberships'`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "GET",
		Path:         "/api/context/spaces/{project_id}/memberships",
		ArgsMapping:  []string{"project_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "memberships", Label: "Members", Type: "json"},
			{Key: "total", Label: "Total", Type: "number"},
		},
	})
	cmd.AddCommand(membersCmd)

	tasksCmd := &cobra.Command{
		Use:   "tasks",
		Short: "Project 任务",
	}
	cmdutil.MustRegisterCommand(tasksCmd, f, cmdutil.CommandDef{
		Use:   "list <project-id>",
		Short: "列出 Project 任务",
		Long: `列出调用者有权访问的 Project 中全部任务。
结果包含任务责任人与当前执行准备状态，供编排前选择已有任务使用。
这是只读查询；创建任务请使用 tasks create 并确认写入。`,
		Example: `  tabtin project tasks list <project-id>
  tabtin project tasks list <project-id> --format json
  tabtin project tasks list <project-id> --jq '.data.tasks[] | .title'`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "GET",
		Path:         "/api/context/projects/{project_id}/tasks",
		ArgsMapping:  []string{"project_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "tasks", Label: "Tasks", Type: "json"},
			{Key: "total", Label: "Total", Type: "number"},
		},
	})
	cmdutil.MustRegisterCommand(tasksCmd, f, cmdutil.CommandDef{
		Use:   "create <project-id>",
		Short: "创建 Project 任务",
		Long: `从一个严格校验的 JSON object 创建一条 Project 任务，并指定现有 Project 成员为责任人。
用 --input - 从 stdin 接收 JSON，或用 --input @path 从安全校验过的本地文件读取；不接受任意字段或多个 JSON 值。
创建会影响协作分工，因此真实写入必须先获得用户确认并显式传 --yes；可先用 --dry-run 查看计划。`,
		Example: `  tabtin project tasks create <project-id> --input '{"title":"整理需求","responsible_user_id":"<user-id>"}' --yes
  echo '{"title":"整理需求","description":"补齐验收项","priority":"high","responsible_user_id":"<user-id>"}' | tabtin project tasks create <project-id> --input - --yes
  tabtin project tasks create <project-id> --input @task.json --dry-run`,
		Layer:        "L2",
		Risk:         cmdutil.RiskDestructive,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "POST",
		Path:         "/api/context/projects/{project_id}/tasks",
		ArgsMapping:  []string{"project_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "input", Type: cmdutil.FlagString, Required: true, CliOnly: true, Desc: "任务 JSON object（支持 @文件或 - 从 stdin 读取）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{{Key: "task", Label: "Task", Type: "json"}},
		Validate: func(ctx *cmdutil.RunContext) error {
			if len(ctx.Args) != 1 {
				return fmt.Errorf("请提供 Project ID，用法：tabtin project tasks create <project-id> --input <json> --yes")
			}
			if err := cmdutil.ValidatePathParam(ctx.Args[0], "Project ID"); err != nil {
				return err
			}
			_, err := parseProjectTaskCreateInput(ctx.Str("input"))
			return err
		},
		DryRun:  projectTaskCreateDryRun,
		RunFunc: projectTaskCreateFunc(f),
	})
	cmd.AddCommand(tasksCmd)

	taskCmd := &cobra.Command{
		Use:   "task",
		Short: "Project Task 工作台",
	}
	// Layer: L2
	cmdutil.MustRegisterCommand(taskCmd, f, cmdutil.CommandDef{
		Use:   "current",
		Short: "读取当前 Project Task 的工作面",
		Long: `从当前 Agent 执行会话推导并读取其绑定的 Project Task 工作面。
		不接受 project-id 或 task-id：服务端会同时验证会话归属、TaskRun 与责任人，
		普通聊天、缺失会话或其他成员的 Task 都会被拒绝。`,
		Example: `  tabtin project task current --format json
  tabtin project task current --format table
  tabtin project task current --jq '.data.workbench.primary_artifact'`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "GET",
		Path:         "/api/context/projects/tasks/current",
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "workbench", Label: "Workbench", Type: "json"},
		},
		Tips: []string{
			"仅能在系统绑定的 Project Task 执行会话中使用；不要尝试传入或猜测 Task ID。",
			"该命令只读；验收、发布和替他人接单不能由 Agent 通过 CLI 完成。",
		},
	})
	cmdutil.MustRegisterCommand(taskCmd, f, cmdutil.CommandDef{
		Use:   "feedback <project-id> <task-id>",
		Short: "增量读取指定 Project Task 的公开反馈",
		Long: `按游标增量读取当前可访问 Task 的公开人工评论，不会写入评论、交付物或 Task 状态。
游标只能续读同一 Task 的公开评论，避免把其他 Task 的事件标识当作读取范围。
首次调用不传游标；后续只使用响应的 next_cursor，直到 has_more 为 false。`,
		Example: `  tabtin project task feedback <project-id> <task-id> --format json
  tabtin project task feedback <project-id> <task-id> --limit 20
  tabtin project task feedback <project-id> <task-id> --cursor <next-cursor> --format json`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "GET",
		Path:         "/api/context/projects/{project_id}/tasks/{task_id}/feedback",
		ArgsMapping:  []string{"project_id", "task_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "cursor", Type: cmdutil.FlagString, NoFileInput: true, Desc: "上次响应返回的 next_cursor"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 50, Desc: "单次最多读取的评论数（1-100，默认 50）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "feedback", Label: "公开反馈", Type: "json"},
			{Key: "next_cursor", Label: "下页游标", Type: "string"},
			{Key: "has_more", Label: "仍有更多", Type: "boolean"},
		},
		Tips: []string{
			"Project Task 会话优先使用系统上下文提供的 project-id 和 task-id；不要猜测或枚举其他 Task。",
			"本命令只读公开评论；不能回复反馈、交付、验收或调用 present_to_user。",
		},
	})
	cmdutil.MustRegisterCommand(taskCmd, f, cmdutil.CommandDef{
		Use:   "get <project-id> <task-id>",
		Short: "读取指定 Project Task 的工作面",
		Long: `读取调用者有权限访问的指定 Project Task 工作面、人工反馈与已发布交付物。
责任人会额外看到自身最新 Run 的候选交付物；它不会把传入 ID 当作运行身份，也不会修改 Task 状态。
Project Task 执行会话应使用系统上下文提供的 ID，不要猜测或枚举其他 Task。`,
		Example: `  tabtin project task get <project-id> <task-id> --format json
  tabtin project task get <project-id> <task-id> --format table
  tabtin project task get <project-id> <task-id> --jq '.data.workbench.primary_artifact'`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteDirect,
		Runtime:      cmdutil.RuntimeCloud,
		Method:       "GET",
		Path:         "/api/context/projects/{project_id}/tasks/{task_id}/workbench",
		ArgsMapping:  []string{"project_id", "task_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "workbench", Label: "Workbench", Type: "json"},
		},
		Tips: []string{
			"Project Task 会话中，project-id 和 task-id 由运行上下文提供；先读取任务，再修改当前中间产物。",
			"该命令只读；验收、发布和替他人接单不能由 Agent 通过 CLI 完成。",
		},
	})
	cmd.AddCommand(taskCmd)
	return cmd
}

type projectTaskCreateInput struct {
	Title             string  `json:"title"`
	Description       string  `json:"description"`
	Priority          *string `json:"priority"`
	ResponsibleUserID string  `json:"responsible_user_id"`
}

// parseProjectTaskCreateInput 只接受一个 API 定义的 JSON object：DisallowUnknownFields
// 防止拼写错误静默丢失，EOF 检查阻止 JSON 拼接造成歧义。
func parseProjectTaskCreateInput(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	var input projectTaskCreateInput
	if err := decoder.Decode(&input); err != nil {
		return nil, fmt.Errorf("--input 必须是合法的任务 JSON object: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("--input 只能包含一个 JSON object")
		}
		return nil, fmt.Errorf("--input JSON 解析失败: %w", err)
	}
	input.Title = strings.TrimSpace(input.Title)
	input.ResponsibleUserID = strings.TrimSpace(input.ResponsibleUserID)
	if input.Title == "" {
		return nil, fmt.Errorf("--input.title 不能为空")
	}
	if input.ResponsibleUserID == "" {
		return nil, fmt.Errorf("--input.responsible_user_id 不能为空")
	}
	body := map[string]any{
		"title":               input.Title,
		"description":         input.Description,
		"responsible_user_id": input.ResponsibleUserID,
	}
	if input.Priority != nil {
		priority := strings.TrimSpace(*input.Priority)
		if priority != "low" && priority != "medium" && priority != "high" && priority != "urgent" {
			return nil, fmt.Errorf("--input.priority 必须是 low / medium / high / urgent")
		}
		body["priority"] = priority
	}
	return body, nil
}

func projectTaskCreateDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	body, err := parseProjectTaskCreateInput(ctx.Str("input"))
	if err != nil {
		body = map[string]any{"input": "<任务 JSON 将在真实执行前校验>"}
	}
	projectID := "{project_id}"
	if len(ctx.Args) == 1 {
		projectID = url.PathEscape(ctx.Args[0])
	}
	return cmdutil.NewDryRunPlan().
		Desc("创建一条 Project 任务（不写入）").
		Step("POST", "/api/context/projects/"+projectID+"/tasks", body)
}

func projectTaskCreateFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		body, err := parseProjectTaskCreateInput(ctx.Str("input"))
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}
		tr, err := requireCloudTransport(f, "project tasks create")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		path := "/api/context/projects/" + url.PathEscape(ctx.Args[0]) + "/tasks"
		resp, err := tr.Request(reqCtx, "POST", path, body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.Unavailable), err.Error(), "", output.ExitNetwork,
			))
		}
		return printTransportResponse(resp, f.Format)
	}
}
