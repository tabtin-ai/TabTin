package extension

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

const catalogPath = "/extensions/cli-commands"
const catalogTimeout = 2500 * time.Millisecond

type ExtensionCommand struct {
	ExtensionID string           `json:"extension_id"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	APIEndpoint string           `json:"api_endpoint"`
	Method      string           `json:"method"`
	Options     []ExtensionOption `json:"options"`
	// ── W7 marketplace 扩展字段 ──────────────────────────────────
	// 由 CLI Server 的 marketplace scanner 填充；Django 后端扩展不带这些字段。
	Source    string `json:"source,omitempty"`
	Domain   string `json:"domain,omitempty"`
	Verb     string `json:"verb,omitempty"`
	RiskLevel string `json:"risk_level,omitempty"`
}

type ExtensionOption struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
	Default     any    `json:"default"`
}

func RegisterDynamicCommands(rootCmd *cobra.Command, tr transport.Transport) {
	if tr == nil {
		return
	}

	resp, err := tr.Request(context.Background(), "GET", catalogPath, nil, &transport.RequestOptions{Timeout: catalogTimeout})
	if err != nil || resp.Status != 200 {
		return
	}

	commands := parseCatalog(resp.Data)
	if len(commands) == 0 {
		return
	}

	groups := groupByExtension(commands)

	for extID, cmds := range groups {
		extCmd := &cobra.Command{
			Use:   extID,
			Short: fmt.Sprintf("扩展: %s", extID),
		}

		for _, c := range cmds {
			proxyCmd := createProxyCommand(tr, c)
			extCmd.AddCommand(proxyCmd)
		}

		rootCmd.AddCommand(extCmd)
	}
}

func parseCatalog(data json.RawMessage) []ExtensionCommand {
	var wrapper struct {
		Data struct {
			Commands []ExtensionCommand `json:"commands"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &wrapper); err == nil && len(wrapper.Data.Commands) > 0 {
		return wrapper.Data.Commands
	}

	var alt struct {
		Commands []ExtensionCommand `json:"commands"`
	}
	if err := json.Unmarshal(data, &alt); err == nil {
		return alt.Commands
	}

	return nil
}

func groupByExtension(cmds []ExtensionCommand) map[string][]ExtensionCommand {
	groups := make(map[string][]ExtensionCommand)
	for _, c := range cmds {
		if c.ExtensionID == "" || c.Name == "" || c.APIEndpoint == "" {
			continue
		}
		groups[c.ExtensionID] = append(groups[c.ExtensionID], c)
	}
	return groups
}

// FetchExtensionCatalog 拉取 /extensions/cli-commands 并返回解析后的命令列表。
// 任何错误静默返回 nil——不影响原生命令输出。
// 供 tabtin commands --json 合并 extension + marketplace 命令到 schema 输出。
func FetchExtensionCatalog(tr transport.Transport) []ExtensionCommand {
	if tr == nil {
		return nil
	}
	resp, err := tr.Request(context.Background(), "GET", catalogPath, nil, &transport.RequestOptions{Timeout: catalogTimeout})
	if err != nil || resp.Status != 200 {
		return nil
	}
	return parseCatalog(resp.Data)
}

func createProxyCommand(tr transport.Transport, def ExtensionCommand) *cobra.Command {
	cmd := &cobra.Command{
		Use:   def.Name,
		Short: def.Description,
		RunE: func(cmd *cobra.Command, args []string) error {
			body := make(map[string]any)

			for _, opt := range def.Options {
				name := strings.TrimPrefix(opt.Name, "--")
				switch opt.Type {
				case "string":
					val, _ := cmd.Flags().GetString(name)
					if val != "" {
						body[name] = val
					}
				case "boolean":
					val, _ := cmd.Flags().GetBool(name)
					if val {
						body[name] = val
					}
				case "number":
					val, _ := cmd.Flags().GetInt(name)
					if val != 0 {
						body[name] = val
					}
				}
			}

			endpoint := def.APIEndpoint
			if strings.HasPrefix(endpoint, "/api/extensions") {
				endpoint = strings.TrimPrefix(endpoint, "/api")
			}
			if !strings.HasPrefix(endpoint, "/extensions/") {
				endpoint = "/extensions/" + strings.TrimPrefix(endpoint, "/")
			}

			method := def.Method
			if method == "" {
				method = "POST"
			}

			reqCtx := cmd.Context()
			resp, err := tr.Request(reqCtx, method, endpoint, body, nil)
			if err != nil {
				return fmt.Errorf("扩展命令执行失败: %w", err)
			}

			var data any
			_ = json.Unmarshal(resp.Data, &data)
			if resp.Status >= 400 {
				exitCode := cmdutil.MapHTTPToExitCode(resp.Status)
				responseBody, _ := data.(map[string]any)
				code, message, hint := cmdutil.ExtractAPIError(responseBody)
				if code == "" {
					code = cmdutil.HTTPStatusToErrorCode(resp.Status)
				}
				if message == "" {
					message = fmt.Sprintf("扩展命令执行失败 (HTTP %d)", resp.Status)
				}
				return output.PrintErrorAndExit(
					output.ErrorEnvelope(code, message, hint, exitCode),
				)
			}
			output.PrintResult(data, output.FormatJSON)
			return nil
		},
	}

	for _, opt := range def.Options {
		name := strings.TrimPrefix(opt.Name, "--")
		switch opt.Type {
		case "string":
			d, _ := opt.Default.(string)
			cmd.Flags().String(name, d, opt.Description)
		case "boolean":
			cmd.Flags().Bool(name, false, opt.Description)
		case "number":
			d := 0
			if v, ok := opt.Default.(float64); ok {
				d = int(v)
			}
			cmd.Flags().Int(name, d, opt.Description)
		}
		if opt.Required {
			_ = cmd.MarkFlagRequired(name)
		}
	}

	return cmd
}
