package cmdutil

import (
	"strings"

	"github.com/spf13/cobra"
)

// positionalAliasFlags 为 Agent 常见误用（REST 风格 --id / --document-id）注入隐藏兼容 flag。
func positionalAliasFlags(def CommandDef) []FlagDef {
	if len(def.ArgsMapping) == 0 {
		return nil
	}
	first := def.ArgsMapping[0]
	switch first {
	case "document_id":
		return []FlagDef{
			{
				Name:        "id",
				Type:        FlagString,
				Hidden:      true,
				NoFileInput: true,
				Desc:        "[兼容别名] 等价于位置参数 <document-id>",
			},
			{
				Name:        "document-id",
				Type:        FlagString,
				Hidden:      true,
				NoFileInput: true,
				Desc:        "[兼容别名] 等价于位置参数 <document-id>",
			},
		}
	default:
		return nil
	}
}

// coalescePositionalAliases 把隐藏兼容 flag 折叠进 ctx.Args，供 path 占位与校验共用。
func coalescePositionalAliases(cmd *cobra.Command, ctx *RunContext, def CommandDef) {
	if len(def.ArgsMapping) == 0 {
		return
	}
	first := def.ArgsMapping[0]
	kebab := kebabName(first)

	if cmd.Flags().Lookup(kebab) != nil && cmd.Flags().Changed(kebab) {
		if v, _ := cmd.Flags().GetString(kebab); strings.TrimSpace(v) != "" {
			ctx.Args = setFirstArgIfEmpty(ctx.Args, v)
		}
	}

	if first == "document_id" && cmd.Flags().Changed("id") {
		if v, _ := cmd.Flags().GetString("id"); strings.TrimSpace(v) != "" {
			ctx.Args = setFirstArgIfEmpty(ctx.Args, strings.TrimSpace(v))
		}
		delete(ctx.FlagValues, "id")
	}
}

func setFirstArgIfEmpty(args []string, value string) []string {
	if len(args) == 0 {
		return []string{value}
	}
	if strings.TrimSpace(args[0]) != "" {
		return args
	}
	out := make([]string, len(args))
	copy(out, args)
	out[0] = value
	return out
}
