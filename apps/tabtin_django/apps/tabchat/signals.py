"""TabChat 跨 App 自定义 signal。

未来 mention 统计、未读异步脚本、AI 摘要生成等场景都可以监听同一个 signal，
不需要侵入 MessageService。第一个消费者是 `apps.services.jinbao`（Echo Bot）。
"""

from __future__ import annotations

import django.dispatch

# 消息创建完成（已写库 + Centrifugo 已推送）后发射。
#
# 关键字参数：
#   message       — Message 实例
#   conversation  — Conversation 实例（避免接收方重复查库）
#   sender_id     — 发送者 user_id（冗余，方便接收方）
#
# 时序保证：dispatch 通过 `transaction.on_commit` 注册，因此 handler 看到 message
# 时数据已写库；与 `_broadcast` 同为 on_commit callback、互不嵌套，handler 异常
# 不会影响主 publish 链路。
#
# 接收方应当：
#   - 不在 handler 内做重活——立即 enqueue 异步任务返回
#   - 异常自行捕获——signal 不应影响发送流程（dispatch 侧 _safe_send 也兜底）
message_created = django.dispatch.Signal()
