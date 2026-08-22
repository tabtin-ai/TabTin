---
scene_key: checkpoint_decision_summary
display_name: Checkpoint 决策摘要
description: 一次生成 checkpoint 意图、决策与未决项的 composite JSON
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 500
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.3
  max_tokens: 300
  response_format:
    type: json_object
  timeout_sec: 25

template_variables:
  - name: user_prompt
    type: str
    required: true
    description: 用户意图
  - name: files
    type: "list[dict]"
    required: false
    description: 文件变更列表
  - name: resources
    type: "list[dict]"
    required: false
    description: 资源变更列表
  - name: basic_outcome
    type: str
    required: false
    description: 基础结果描述
---

## 触发场景

Checkpoint 创建后的唯一 composite 摘要执行。该场景作为
`checkpoint_summary` execution 的 canonical usage attribution；
`checkpoint_intent_summary` 产品分类继续保留，但不再产生独立 Provider 调用。
