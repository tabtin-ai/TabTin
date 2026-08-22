/**
 * W4.5 第二波 B3 · `isStreamEventId` 跨语言契约 SSOT
 * =====================================================
 *
 * **业务目标**
 * ------------
 * Redis Stream ID（`<digits>-<digits>`，譬如 `1702000000000-0`）是 backend
 * `_handle_resume` 真正用于 replay 的 cursor 形态。其他 ID 形态（譬如老
 * `evt_<uuid>`、心跳临时 ID）写到 localStorage 等于污染 cursor，下次冷启动
 * 续传会被 backend `_handle_resume` 走 replay=0 沉默路径——用户完全感知不到
 * "续传无效"。
 *
 * 4 端（TS daemon / Python Django / Swift iOS / Kotlin Android）持久化层
 * 必须对**同一个字符串**给出**完全相同**的"该不该写"判定——否则任一端走
 * 偏，跨进程 / 跨设备 catchup 立刻 break。
 *
 * **规则 SSOT**
 * -------------
 * 1. 必须命中正则 `^[0-9]+-[0-9]+$`（**严格 ASCII-only**，不接受 `０`/`٠`
 *    等 Unicode digit 等价物）
 * 2. 空字符串拒绝
 * 3. 非字符串类型拒绝
 *
 * **跨语言对齐要点**
 * ------------------
 * - TS：`/^\d+$/` 默认是 ASCII-only（`\d` 不开 `u` flag 时只匹配 `[0-9]`）✓
 * - Python：`str.isdigit()` 会接受全角数字 / 阿拉伯-印度数字 → **分歧**
 *   解法：改用 `all(c in "0123456789" for c in s)` 或 `re.match(r"^\d+$", s, re.ASCII)`
 * - Swift：`Character.isNumber` 接受 Unicode 数字 → 分歧
 *   解法：`c.isASCII && c.isNumber`（Swift 的 `isNumber` 单字符匹配仍 OK
 *   只要先 `.isASCII` 卡 ASCII-only）
 * - Kotlin：`Char.isDigit()` 接受 Unicode 数字 → 分歧
 *   解法：`c in '0'..'9'`
 *
 * **fixture**
 * -----------
 * `packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json`
 * —— 10+ case，含 unicode 分歧防御。4 端 replay 必须 byte-by-byte 一致。
 *
 * **4 端落地状态（W4.5 B3 完成）**
 * ----------------------------------
 * - TS daemon：✅ import `@tabtin/agent-wire` SSOT（本文件）
 * - TS Renderer：⚠️ `apps/tabtin-electron/src/renderer/src/services/wsLastEventIdPersistence.ts`
 *   内有等价内联副本（W4c R5-P0-1 引入），TS 测试 `wave45-isStreamEventId-contract.test.ts`
 *   含"副本契约校验"防漂移。W7 清理 Wave 可让 Renderer 直接
 *   `import { isStreamEventId } from '@tabtin/agent-wire'` 收口为单一实现。
 * - Python Django：✅ `apps/tabtin_django/apps/services/common/ws/protocol.py::is_stream_event_id`
 *   W4.5 B3 已修紧为 `frozenset("0123456789")` + `all(c in ...)`，原先
 *   `parts[0].isdigit()` 实现已退役。Python 测试
 *   `test_wave45_isStreamEventId_cross_language.py` 19 case 全 PASS。
 * - Swift iOS：✅ 占位 `packages/wire-codegen/generated/swift/StreamEventIdValidator.swift`
 *   （W5 vendor in 后由 LastEventIdPersistence + WebSocketService.lastEventIdPerTopic
 *   双使用点调用）
 * - Kotlin Android：✅ 占位 `packages/wire-codegen/generated/kotlin/StreamEventIdValidator.kt`
 *   （W6 同上双使用点）
 */

/**
 * 判断给定字符串是否为 Redis Stream ID 形态（`<digits>-<digits>`，严格 ASCII）。
 *
 * 4 端等价语义；fixture 见 cross-lang-fixtures/wave45-isStreamEventId.json。
 */
export function isStreamEventId(eventId: unknown): boolean {
  if (typeof eventId !== 'string' || eventId.length === 0) {
    return false;
  }
  const parts = eventId.split('-');
  if (parts.length !== 2) {
    return false;
  }
  // ASCII-only 严格数字 —— `/^\d+$/` 不带 u flag 时 \d 仅匹配 [0-9]，
  // 与 backend 应当对齐的 `all(c in '0123456789' for c in s)` 等价。
  return /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
}
