# @tabtin/cli

TabTin 统一 CLI（`tabtin`）的**本地安装包**。把 `packages/tabtin-cli-go` 编译出的
Go 二进制打进一个 npm 包，靠标准 `npm i -g` 完成全局安装 + PATH 挂载，免去手工
`symlink` 到 `~/.local/bin`。

对应 issue [#5888](https://github.com/larchiveai/TabTin/issues/5888) 工作包二（CLI 云端 /
独立分发）。

> **仅供内部分发，不发布到公共 npm registry。** `package.json` 已设 `"private": true`；
> 包里不含任何 token / profile / 凭证。

## 本地安装

完整「打包 → 发给同事 → 登录 → 第三方 Agent 使用」

[`docs/agent/tabtin-cli-pack-install-guide.md`](../../docs/agent/tabtin-cli-pack-install-guide.md)

```bash
# 1. 编译 Win/mac 二进制 + 生成 skills/（不依赖 make）
pnpm --filter @tabtin/cli build   # 或: npm run build

# 2. 打包（prepack 校验 binaries/ + skills/）
cd packages/tabtin-cli
npm pack

# 3. 全局安装（postinstall 自动把 Skill 物化到 ~/.agents/skills）
npm i -g ./tabtin-cli-*.tgz

# 4. 验证
tabtin --help
ls ~/.agents/skills   # 应有一批 tabtin-*
```

跳过自动物化：`TABTIN_SKIP_SKILLS_INSTALL=1 npm i -g ./tabtin-cli-*.tgz`。

## 支持的平台（首版）

| `process.platform` | `process.arch` | 二进制文件名 |
|---|---|---|
| `win32` | `x64` | `tabtin-windows-amd64.exe` |
| `win32` | `arm64` | `tabtin-windows-arm64.exe` |
| `darwin` | `x64` | `tabtin-darwin-amd64` |
| `darwin` | `arm64` | `tabtin-darwin-arm64` |

首版只打包 Windows / macOS。Linux 仍会由 `build-binaries.js` 编到
`packages/tabtin-cli-go/dist/`，但不打进本包；后续需要时再补。

`package.json` 的 `os` / `cpu` 字段已限定到上表四种组合——在不支持的平台上
`npm install` 会直接失败并报出原因，而不是装完之后才在运行时才发现打不开。

## `bin/tabtin.js` 做了什么

一个薄 Node 启动器：按 `process.platform` + `process.arch` 从 `binaries/` 选出对应
二进制，`spawnSync` 转发 `argv` / `stdio` / exit code（含信号透传）。找不到匹配平台
或对应二进制文件缺失时，会打印清晰报错后退出。

未设置时注入 `TABTIN_SKILLS_BUNDLE_DIR` 指向包内 `skills/`。

## `postinstall` 做了什么

仅 **`npm i -g`** 时运行：调用 `tabtin skills install --target agents`，把包内全部
`tabtin-*` Skill 写到 `~/.agents/skills`，供 Cursor / Claude / Codex 扫描。
仓库内 `pnpm install`（非全局）不会触发。

## 卸载 vs 清配置 —— 这是两件事，别混

- **`npm uninstall -g @tabtin/cli`**：只删程序本体（launcher + binaries + 包内 skills），
  **保留** `~/.tabtin` 登录态，也**不会**自动删除已物化到 `~/.agents/skills` 的副本。
  清物化 Skill：`tabtin skills remove --yes`（须在卸载 CLI 前执行，或重装后再清）。
- **显式清空本地配置 / 凭证 / 缓存**：

  ```bash
  tabtin config purge --yes
  ```

  删除 `~/.tabtin` 下状态；**不会**触碰 Space 工作目录。

## 目录结构

```
packages/tabtin-cli/
├── package.json              # name=@tabtin/cli, bin, private, postinstall
├── bin/tabtin.js             # Node 启动器
├── scripts/
│   ├── build-binaries.js     # go 交叉编译 → binaries/（无 make）
│   ├── build-binaries.sh     # 转发到 .js
│   ├── generate-skills-bundle.cjs
│   ├── check-binaries.js     # prepack
│   ├── check-skills-bundle.js
│   └── postinstall.js        # npm i -g 时物化 Skill
├── binaries/                 # gitignore；build 本地生成
├── skills/                   # gitignore；generate 本地生成
└── README.md
```

## 为什么不直接发到公共 npm

`binaries/` 里是内部 Go CLI 的编译产物，分发策略尚未定案。当前只支持
`npm pack` 之后本地 / 内网 `npm i -g`；**不要**对这个包跑 `npm publish`。
