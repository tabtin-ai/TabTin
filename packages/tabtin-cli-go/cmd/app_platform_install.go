package cmd

// `tabtin install` — 薄 shim fork Python tabtin_cli.install（A5 启动包）。
// 真正的实现（manifest 解析 / SHA256 校验 / 解压 / 写本地 registry）在 Python 侧。
//
// Python 侧退出码协议（A5）：
//   0    成功
//   2    argparse 参数错误
//   78   E_INSTALL_CHECKSUM_MISSING（SHA256 缺失，除非 TABTIN_ALLOW_UNCHECKED_INSTALL=1）
//   126  评估层 deny / fail-close
//   其他 透传（如 download HTTP error）

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdInstall(_ *cmdutil.Factory) *cobra.Command {
	var (
		manifest    string
		registryDir string
		jsonOut     bool
		autoInstall bool
	)

	cmd := &cobra.Command{
		Use:   "install <app_id>",
		Short: "安装 marketplace App",
		Long: `安装 marketplace App。

按 manifest ` + "`install.type`" + ` 分发：
  - npm-global  检查 CLI 是否已在 PATH；未装则默认引导用户跑
                ` + "`npm install -g <package>`" + `（加 --auto-install 让 tabtin 代跑）
  - tarball     下载 tar.gz → SHA256 校验 → 解压 → 写 registry

本命令是 Python tabtin_cli 的薄 shim；实际实现见
` + "`apps/services/agent_engine/cli/tabtin_cli/install.py`" + `。

示例：
  tabtin install <app_id>                   # 引导 npm 安装（首次用户需要手动执行）
  tabtin install <app_id> --auto-install    # 代跑 npm install -g <package>
  tabtin install <app_id> --json
  tabtin install <app_id> --registry-dir=/custom/path

退出码：
  0    安装成功
  2    参数错误
  78   npm 引导 / checksum 缺失（需用户额外操作后重试）
  126  平台治理拒绝
  127  binary 不可达`,
		Args: cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			appID := args[0]

			forkArgs := []string{appID}
			if manifest != "" {
				forkArgs = append(forkArgs, "--manifest", manifest)
			}
			if registryDir != "" {
				forkArgs = append(forkArgs, "--registry-dir", registryDir)
			}
			if jsonOut {
				forkArgs = append(forkArgs, "--json")
			}
			if autoInstall {
				forkArgs = append(forkArgs, "--auto-install")
			}

			return forkPythonTabtinCli(cmd.Context(), "install", forkArgs)
		}),
	}

	cmd.Flags().StringVar(&manifest, "manifest", "",
		"显式指定 app.json 路径（默认从 packages/apps/<app_id>/app.json 读）")
	cmd.Flags().StringVar(&registryDir, "registry-dir", "",
		"覆盖 marketplace App 安装目录（默认 ~/.tabtin-marketplace-apps/）")
	cmd.Flags().BoolVar(&jsonOut, "json", false,
		"JSON 输出格式（便于脚本 / Agent 消费）")
	cmd.Flags().BoolVar(&autoInstall, "auto-install", false,
		"npm-global 类型 App 未装时代跑 `npm install -g <package>`（默认关闭）")

	return cmd
}
