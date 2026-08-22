---
scene_key: tool_risk_classify
display_name: AI 工具风险分类
description: 在工具决策时同步判断该工具调用是否安全（safe / confidence / reason，JSON）
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 4000
  max_output_tokens: 300
  latency_class: interactive
  cost_class: cheap

default_params:
  temperature: 0.0
  max_tokens: 256
  response_format:
    type: json_object
  timeout_sec: 15

template_variables:
  - name: tool_name
    type: str
    required: true
    description: 工具名称
  - name: args_summary
    type: str
    required: true
    description: 工具参数摘要
  - name: context_summary
    type: str
    required: false
    description: 最近对话上下文摘要
---

## 触发场景

每次工具决策返回 ASK 时同步阻塞调用。

## fail-closed 行为

调用任何错误 → 业务侧返回 ASK（不放行工具）。
