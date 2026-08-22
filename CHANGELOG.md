# 版本记录

[English](CHANGELOG.en.md)

记录 TabTin 从首次公开版本开始的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。不回填私有研发历史。

## [Unreleased]

这里只记录经验证、对用户、部署者或贡献者有实际影响的重要变化；不记录内部文档清理，也不回填私有研发历史。

发布时，将已验收条目按 Added、Changed、Deprecated、Removed、Fixed 和 Security 分类，移入对应版本号和日期。

## [1.1.2] - 2026-08-22

首个公开源码快照。版本号与当前线上产品 **1.1.2** 对齐，便于 Issue、安全支持和客户端版本对照。本仓库不回填私有研发历史；下列条目只描述这次公开切片本身。

### Added

- 公开仓库与 GitHub Release：源码快照对应产品 1.1.2。
- Community 本地运行路径：自托管 TabTin Server、桌面客户端，以及 BYOK 模型配置。

### Notes

- 官方托管服务、客户端更新通道和线上后端仍走原有发版流程；本仓库的 tag 不触发生产部署。
- 社区发行不附带官方安装包或自动更新通道。社区构建以仓库内的产品版本字段为准。
