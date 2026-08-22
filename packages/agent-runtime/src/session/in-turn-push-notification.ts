/**
 *  / ：区分 in-turn push 与 idle drain 主 USER。
 *
 * injector 同轮注入会同时带 `message_id` + `triggered_by=push-notification`，
 * 必须双写本地 transcript/blocks，否则切会话丢收敛卡。
 *
 * idle drain 主 USER 只有 `client_event_id`（已由 query-turn-pipeline 落盘），
 * Host 侧不得再按 push 重复写入。
 */
export function isInTurnPushNotificationUser(payload: {
  triggered_by?: string
  message_id?: string
}): boolean {
  return payload.triggered_by === 'push-notification'
    && typeof payload.message_id === 'string'
    && payload.message_id.length > 0
}
