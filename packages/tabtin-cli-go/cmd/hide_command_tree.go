package cmd

import "github.com/spf13/cobra"

// hideCommandTree 递归 Hidden 整棵子树。
// cobra 父 Hidden 不会传给子命令；#5353 /  需要叶子也打标，
// 才能让 GetRegisteredCommands 打出 hidden=true、默认发现面剔除。
func hideCommandTree(cmd *cobra.Command) {
	if cmd == nil {
		return
	}
	cmd.Hidden = true
	for _, child := range cmd.Commands() {
		hideCommandTree(child)
	}
}
