"""
AI 能力统一宪法 v0.1 — 共享运行时基础设施

8 个 capability 入口共用的 5 个模块：
- scene_call_context: SceneCallContext 装配
- model_resolver: ModelResolver（路线 B 强制 scope='global'）
- billing_precheck: BillingPrecheck
- result_validator: ResultValidator
- usage_recorder: LLMUsageFact + BillingUsageEvent 写入
"""
