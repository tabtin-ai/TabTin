# 发版说明

[English](RELEASING.en.md)

TabTin 只有一条产品版本线。公开仓的 tag 用来标明「这份源码对应哪个产品号」，不替代官方发版流水线。

```
产品版本 1.1.2
├── 官方：现有客户端 / 更新通道 / 线上后端
└── 社区：公开仓 tag v1.1.2 = 这份源码对应产品 1.1.2
```

## 版本合同

- 公开稳定版本只用 `vMAJOR.MINOR.PATCH`，例如 `v1.1.2`。
- 预发布可用 `v1.1.3-rc.1` 这种带 `-` 的 tag；GitHub Release 标为 pre-release，不标 latest。
- 不要另开 `v0.1.0` 社区线，也不要再开 `desktop-v…` 第二条线。
- 不要回填 `v1.0.0` … `v1.1.1`。公开历史从第一枚公开 tag 开始。
- 产品号以桌面 `apps/tabtin-electron/package.json#version` 为准；根目录 `package.json`、Android `versionName`、iOS `MARKETING_VERSION` 必须写同一个号。各内部 package 可保持自己的包版本。

## 谁能发版

只有维护者可以推正式 tag、创建 GitHub Release。外部贡献者不要打 tag。

## 发一版

1. 确认公开 tree 就是该产品号的开源切片（或文档已写明删了什么）。对不上就等下一版，不要先打 tag。
2. 把 `[Unreleased]` 里已验收的条目移到 `CHANGELOG.md` / `CHANGELOG.en.md` 的 `## [X.Y.Z] - YYYY-MM-DD`。
3. 把产品版本字段改成 `X.Y.Z`，经 PR 合进 `main`。
4. 在该 commit 上打 annotated tag，只推 tag：

   ```bash
   git tag -a vX.Y.Z -m "TabTin X.Y.Z"
   git push origin vX.Y.Z
   ```

5. 用 tag 创建 GitHub Release。正文写社区说明：能跑什么、和官方差什么。不要把官方安装包流程接到这个 tag 上。

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md --latest
   ```

   预发布去掉 `--latest`，加上 `--prerelease`。

官方发 `1.1.3` 后，再更新公开快照并打 `v1.1.3`。有可验收的用户可见变化再发下一版即可。

## 不要做

- 用公开仓 tag 触发官方生产部署。
- 在还没合 changelog、版本字段还没对齐时打 tag。
- 用 `workflow_dispatch` 直接发正式版（当前也没有这套 workflow）。
- 为社区 Docker / 安装包另起一套版本号。社区构建如果以后要做，跟同一条 `vX.Y.Z`。
