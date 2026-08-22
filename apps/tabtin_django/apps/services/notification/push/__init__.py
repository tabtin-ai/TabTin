"""移动端远程推送。

链路：事件源（agent.stream.done / PendingInteraction 创建）→ Celery task
（notification/tasks.py）→ PushDispatchService（在线抑制 / 偏好 / 去重）→
PushProvider（原生 APNs HTTP/2）→ iPhone。

配置（环境变量，见 tabtin/settings.py APNS_* 块）：
  - APNS_TEAM_ID / APNS_KEY_ID
  - APNS_PRIVATE_KEY 或 APNS_PRIVATE_KEY_PATH（**禁止入库**）
  - APNS_BUNDLE_ID（默认 com.tabtin.mobile）

任一凭据缺省时推送整体关闭（is_push_enabled() == False），
所有链路静默降级为只走既有 WS 实时通道。
"""
