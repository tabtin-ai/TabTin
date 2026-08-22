---
scene_key: title_generation
display_name: 会话标题生成
description: 用户首条消息持久化后异步生成 ≤20 字会话标题
capability_domain: chat

capability_requirements:
  requires_json_mode: false
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 2000
  max_output_tokens: 100
  latency_class: interactive
  cost_class: cheap

# 旧 chat 全局配置 title_* 5 个字段下线 / 迁移说明（宪法 v0.1 §5.8）：
# - title_temperature → 进 default_params.temperature
# - title_max_tokens → 进 default_params.max_tokens
# - title_max_length → 不再 DB 化；调用方 `TitleGeneratorService._clean_title`
#   保留 `max_length=20` 默认形参，作为业务级软截断长度。20 字是产品约束，
#   非 LLM 模型上限，没必要走 SceneBinding override。
# - title_model_id → 走 LLMSceneBinding(title_generation).primary_model_id
# - title_enabled → 弃用：前端总是触发；不需要后台 toggle
# - title_retry_count → 弃用：调用方 `TitleGeneratorService.generate_title` 内部
#   固定 retry_count=2
default_params:
  temperature: 0.7
  max_tokens: 50
  response_format:
    type: text
  timeout_sec: 30

template_variables:
  - name: messages
    type: "list[dict]"
    required: true
    description: 用户最近 4 条消息
---
