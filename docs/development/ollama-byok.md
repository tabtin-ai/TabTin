# 导入已安装的 Ollama 模型

[English](ollama-byok.en.md)

Community 版本可以通过现有 OpenAI 兼容 BYOK 接入 Ollama。模型权重保留在
Ollama 中，TabTin 只保存连接和模型配置，不复制权重，也不要求购买云端 Qwen
API 套餐。

## 导入配置

完成本地账号和组织创建后，在 Django 运行环境执行以下管理命令。组织 ID 应从
本地实例获取；不要提交真实账号 ID、凭据或数据库转储。

```sh
python manage.py import_ollama_model \
  --organization-id YOUR_ORGANIZATION_ID \
  --model qwen3:8b \
  --base-url http://localhost:11434/v1 \
  --context-window 4096 --max-output-tokens 2048 \
  --dry-run
```

去掉 `--dry-run` 才会保存。加上 `--set-default` 会显式设为该组织的默认模型；
不加则保留原有默认值。个人组织使用所有者的个人 BYOK 连接，团队使用组织
连接；需要配置多个组织时，分别执行。

Docker Desktop 的容器访问宿主机 Ollama 时，地址应改为
`http://host.docker.internal:11434/v1`。Compose 示例：

```sh
docker compose exec django python manage.py import_ollama_model \
  --organization-id YOUR_ORGANIZATION_ID --model qwen3:8b \
  --base-url http://host.docker.internal:11434/v1 --set-default
```

Django 镜像需包含该命令；旧源码快照的镜像需重新构建。确保服务监听地址和
端口能被 Django 访问。模型名使用实际安装的完整名称，包含标签。命令通过
`/api/show` 检查模型，不会下载缺失的模型，也不会对该本地元数据请求使用继承
的 HTTP 代理。端点需要鉴权时，在命令环境设置 `OLLAMA_API_KEY`；否则使用
非秘密占位值 `ollama`。

如果 OpenAI 端点因较大上下文占用显存而加载失败，可先创建专用别名，复用已有
权重：

```text
# Modelfile.tabtin
FROM qwen3:8b
PARAMETER num_ctx 4096
```

```sh
ollama create qwen3-tabtin:8b -f Modelfile.tabtin
# 导入时使用 --model qwen3-tabtin:8b --context-window 4096
```

仅修改 TabTin 的上下文字段，不会改变 Ollama 实际服务的上下文。
参见 [Ollama 上下文配置](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)。

重复执行会保留现有模型配置，避免创建重复连接。已有连接被禁用或指向不同
端点时会拒绝导入；另一套 Ollama 服务应使用不同的 `--provider-key`。模型
配置可在“设置 → 模型配置”中编辑。命令复用 BYOK 创建和权限检查，以组织
所有者身份执行。

## 能力与验收

命令读取 Ollama 声明的 `tools` 和 `vision` 能力，不继承云端 OpenAI 的默认
工具或视觉能力。`qwen3:8b` 通常不支持视觉。`--context-window` 应填写**实际
运行的上下文**，默认保守使用 4096，不直接使用模型理论容量；确保 Ollama
实际提供至少该容量。`--max-output-tokens` 必须小于上下文容量。

刷新 TabTin 模型列表，选择 **Ollama / qwen3:8b**（或实际导入的别名），检查：

1. 测试连接后，执行一次真实生成。
2. 流式输出。
3. 工具调用，以及回传工具结果后的继续回答。

测试连接通过不能证明生成或 Agent 行为正常。硬件和具体模型影响延迟、工具
调用质量。将权重保存在有足够空间的磁盘；导入不会迁移模型文件。

小上下文模型不满足所有辅助场景的最小上下文和输出预算要求。导入不会绕过
场景能力检查，也不代表支持所有长文档流程。

### 设置正常但聊天显示“无模型”

设置页的连接列表与聊天使用的模型目录分别加载。外部管理命令导入模型后，
已打开的客户端可能仍保留先前的空目录。先刷新聊天模型目录，或重新加载
客户端，再新建任务并选择实际导入的模型；不需要重复创建连接。
若仍无法选择，检查 `/services/llm/catalog?use_case=chat` 的请求结果和客户端
`ChatModel` 日志，确认当前组织目录包含该模型且路由启用。

### 本地客户端验收记录

2026-10-13：使用已安装 Qwen3 8B 的 4096 上下文别名，用户确认刷新目录后
Electron 新任务可以选择模型，并提供了发送 `hi` 后收到实际回复的截图。
这补充了后端代理测试的客户端对话验证；不代表所有 Agent 工具、长文档或
多轮任务均已通过验收。

参考：[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、
[Ollama 模型信息](https://docs.ollama.com/api/show)、
[Docker Desktop 宿主机访问](https://docs.docker.com/desktop/features/networking/networking-how-tos/)。
