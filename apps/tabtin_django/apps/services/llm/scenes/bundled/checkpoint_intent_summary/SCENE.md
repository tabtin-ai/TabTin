---
scene_key: checkpoint_intent_summary
display_name: Checkpoint 意图摘要
description: 用一句话（15-30 字）总结 checkpoint 时刻的用户意图
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 4000
  max_output_tokens: 100
  latency_class: batch
  cost_class: cheap

default_params:
  temperature: 0.3
  max_tokens: 60
  response_format:
    type: text
  timeout_sec: 25

template_variables:
  - name: user_prompt
    type: str
    required: true
    description: 用户意图描述
  - name: impact_desc
    type: str
    required: false
    description: 变更范围描述
---

## 触发场景

Celery 任务，任务完成时触发。
