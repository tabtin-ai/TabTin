---
scene_key: commit_message_generation
display_name: Commit 信息生成
description: 根据已暂存 diff 摘要生成一条 Conventional Commit 提交信息
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 150
  latency_class: interactive
  cost_class: cheap

default_params:
  max_tokens: 80
  response_format:
    type: text
  timeout_sec: 30
  use_model_default_sampling: true

template_variables:
  - name: files
    type: "list[str]"
    required: true
    description: 已暂存变更文件路径列表
  - name: diff_excerpt
    type: str
    required: true
    description: 截断后的 staged diff 正文
  - name: truncated
    type: bool
    required: false
    description: diff 是否因长度限制被截断
---
