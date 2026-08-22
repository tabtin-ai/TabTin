/**
 * Agent-facing 时间渲染 —— 把绝对时间戳换算成「用户设备本地时区 + 显式 offset」。
 *
 * 为什么需要它（这是一个反复踩的坑）：
 * 给 LLM 一个孤立的 UTC ISO 串（`2026-05-30T23:33:24.748Z`）会让它误判新旧——
 * 它不会可靠地做时区减法，而是把"带 Z、日期还写着昨天"的串模式匹配成"归档/旧
 * 的"。一旦显示的日期跟当下语境（用户、文件 mtime 全是本地今天）对不上，Agent
 * 判断「这是多久之前」必然出错。
 *
 * 解法：凡是给 Agent 看的时间，统一过这个函数，渲染成 `2026-05-31 07:33 (UTC+8)`
 * ——本地日期对得上"今天"、offset 显式标注消除歧义、跨 host（Electron 本机 /
 * Daemon 远端）都按**用户设备时区**而非 host 时区渲染。
 *
 * 设计取向：
 * - 时区来源是「用户设备」（IANA 名，譬如 `Asia/Shanghai`），由客户端采集后透传，
 *   不在任何一层硬编码 UTC / 固定 offset。
 * - tz 缺失 / 非法 → 回退 UTC（显式标注 `(UTC+0)`），安全降级而非崩。
 * - offset 在渲染时刻按 tz 实时计算（自动处理夏令时），不预存。
 * - 精度到分钟：current_datetime 每轮注入，秒级会打破前缀缓存（同分钟 byte-identical）。
 */

/** 校验 IANA 时区名是否被当前运行时支持；非法 / 缺失统一回退到 `UTC`。 */
function normalizeTimeZone(timeZone?: string | null): string {
  if (!timeZone || typeof timeZone !== 'string') return 'UTC';
  try {
    // 非法 tz 会让 Intl 构造抛 RangeError —— 用它当校验。
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** offset 分钟 → `UTC+8` / `UTC-5` / `UTC+5:30` / `UTC+0`。 */
function formatOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC+0';
  const sign = offsetMinutes > 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 把 ISO 时间戳渲染成「用户本地 + 显式 offset」的可读形态（分钟精度）。
 *
 * @param iso       ISO 8601 时间戳（带或不带 `Z` 均可）。空 / 非法时安全返回。
 * @param timeZone  用户设备 IANA 时区名（譬如 `Asia/Shanghai`）。缺省 / 非法 → UTC。
 * @returns 譬如 `2026-05-31 07:33 (UTC+8)`；`iso` 为空返回 `''`；不可解析时原样返回。
 *
 * @example
 * formatAgentDatetime('2026-05-30T23:33:24.748Z', 'Asia/Shanghai') // '2026-05-31 07:33 (UTC+8)'
 * formatAgentDatetime('2026-05-30T23:33:24.748Z')                  // '2026-05-30 23:33 (UTC+0)'
 */
export function formatAgentDatetime(
  iso: string | null | undefined,
  timeZone?: string | null,
): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);

  const tz = normalizeTimeZone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);

    const part: Record<string, string> = {};
    for (const p of parts) part[p.type] = p.value;

    // hour12:false 在部分运行时会把午夜渲染成 '24' —— 归一到 '00'。
    let hour = parseInt(part.hour, 10);
    if (hour === 24) hour = 0;
    const hh = String(hour).padStart(2, '0');

    const wall = `${part.year}-${part.month}-${part.day} ${hh}:${part.minute}`;

    // offset = (把 tz 本地墙钟当成 UTC 的时刻) - (真实 UTC 时刻)。经典且不依赖
    // `timeZoneName: 'longOffset'`（旧运行时不一定支持）的 offset 计算法。
    const asIfUtc = Date.UTC(
      Number(part.year),
      Number(part.month) - 1,
      Number(part.day),
      hour,
      Number(part.minute),
      Number(part.second),
    );
    const offsetMinutes = Math.round((asIfUtc - date.getTime()) / 60000);

    return `${wall} (${formatOffsetLabel(offsetMinutes)})`;
  } catch {
    // 兜底：Intl 路径异常时退回 UTC 分钟精度（不暴露原始 Z 串的误导性日期歧义）。
    const isoUtc = date.toISOString();
    return `${isoUtc.slice(0, 10)} ${isoUtc.slice(11, 16)} (UTC+0)`;
  }
}
