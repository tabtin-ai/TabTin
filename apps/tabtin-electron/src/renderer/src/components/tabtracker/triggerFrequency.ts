/**
 * Tracker 触发频率描述 helper（Module F 决策 2：激活前给用户清晰预期）
 *
 * 用途：
 * 1. 详情页 amber 激活条幅里展示"激活后会按 X 频率自动跑"，避免用户误以为"激活=单次"
 * 2. 激活后判断是否高频（< 30 分钟一次），高频时弹 toast 二次提示
 *
 * 设计原则：
 * - 不解析任意 cron 表达式（避免引 cron 库）。只识别 CreateTrackerDialog 输出的
 *   5 档预设（manual / hourly / daily / weekdays / weekly）；其他 cron 一律
 *   降级到用户可理解的“按自定义计划自动执行”+ 不算高频。
 * - 高频阈值 30 分钟一次（约每天 ≥ 48 次）—— 经验值：低于此频率的 Tracker
 *   用户大概率知道自己在干嘛，无需打扰；高于此频率的容易误触（demo 视频常
 *   见的"每分钟跑一次"被错配成生产场景）。
 */

import type { TFunction } from 'i18next'
import { formatAutomationAbsoluteTime } from './scheduledAutomation'

export interface TriggerFrequencyInfo {
  /** 给用户看的一句话频率描述。空字符串表示不显示。 */
  summary: string
  /** 是否属于"高频"（约 < 30 分钟一次）—— 激活时建议弹 toast 二次确认 */
  isHighFrequency: boolean
}

const HIGH_FREQ_THRESHOLD_SECONDS = 30 * 60

function tt(t: TFunction, key: string, defaultValue: string, values?: Record<string, unknown>): string {
  return t(`frequencyHint.${key}`, { defaultValue, ...values }) as string
}

/**
 * 解析 5 档预设 cron。返回 null 表示不在 5 档之内（自定义 cron）。
 *
 * 5 档对应表达式（CreateTrackerDialog presetToTrigger）：
 *   - hourly:   "0 * * * *"
 *   - daily:    "M H * * *"
 *   - weekdays: "M H * * 1-5"
 *   - weekly:   "M H * * 1"
 */
function parsePresetCron(cron: string): { preset: 'hourly' | 'daily' | 'weekdays' | 'weekly'; hh: number; mm: number } | null {
  const trimmed = cron.trim()
  if (!trimmed) return null

  if (trimmed === '0 * * * *') return { preset: 'hourly', hh: 0, mm: 0 }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return null

  const [minPart, hourPart, , , dowPart] = parts
  const mm = Number(minPart)
  const hh = Number(hourPart)
  if (!Number.isFinite(mm) || !Number.isFinite(hh)) return null
  if (mm < 0 || mm > 59 || hh < 0 || hh > 23) return null

  if (dowPart === '*') return { preset: 'daily', hh, mm }
  if (dowPart === '1-5') return { preset: 'weekdays', hh, mm }
  if (dowPart === '1') return { preset: 'weekly', hh, mm }
  return null
}

function formatHHMM(hh: number, mm: number): string {
  const h = String(hh).padStart(2, '0')
  const m = String(mm).padStart(2, '0')
  return `${h}:${m}`
}

export function describeTriggerFrequency(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  t: TFunction,
): TriggerFrequencyInfo {
  const cfg = triggerConfig ?? {}

  switch (triggerType) {
    case 'manual':
      return {
        summary: tt(t, 'manual', '需手动触发，不会自动跑'),
        isHighFrequency: false,
      }

    case 'cron': {
      const cron = typeof cfg.cron_expression === 'string'
        ? cfg.cron_expression
        : typeof cfg.expression === 'string'
          ? cfg.expression
          : ''
      const preset = parsePresetCron(cron)
      if (!preset) {
        return {
          summary: tt(t, 'cronCustom', '按自定义计划自动执行'),
          isHighFrequency: false,
        }
      }
      if (preset.preset === 'hourly') {
        return {
          summary: tt(t, 'cronHourly', '每小时自动执行一次（约每天 24 次）'),
          isHighFrequency: false,
        }
      }
      const at = formatHHMM(preset.hh, preset.mm)
      if (preset.preset === 'daily') {
        return {
          summary: tt(t, 'cronDaily', '每天 {{at}} 自动执行一次', { at }),
          isHighFrequency: false,
        }
      }
      if (preset.preset === 'weekdays') {
        return {
          summary: tt(t, 'cronWeekdays', '每个工作日 {{at}} 自动执行一次', { at }),
          isHighFrequency: false,
        }
      }
      return {
        summary: tt(t, 'cronWeekly', '每周一 {{at}} 自动执行一次', { at }),
        isHighFrequency: false,
      }
    }

    case 'interval': {
      const seconds = typeof cfg.interval_seconds === 'number' ? cfg.interval_seconds : 0
      if (!seconds || seconds <= 0) {
        return {
          summary: tt(t, 'intervalUnknown', '按固定时间间隔自动执行'),
          isHighFrequency: false,
        }
      }
      const dailyCount = Math.round((24 * 3600) / seconds)
      let unit: string
      if (seconds < 60) {
        unit = tt(t, 'unitSeconds', '每 {{n}} 秒一次', { n: seconds })
      } else if (seconds < 3600) {
        unit = tt(t, 'unitMinutes', '约每 {{n}} 分钟一次', { n: Math.round(seconds / 60) })
      } else {
        unit = tt(t, 'unitHours', '约每 {{n}} 小时一次', { n: Math.round(seconds / 3600) })
      }
      return {
        summary: tt(t, 'intervalSummary', '{{unit}}（预计每天约 {{count}} 次）', {
          unit,
          count: dailyCount,
        }),
        isHighFrequency: seconds < HIGH_FREQ_THRESHOLD_SECONDS,
      }
    }

    case 'at': {
      const at = typeof cfg.at === 'string'
        ? formatAutomationAbsoluteTime(cfg.at)
        : ''
      return {
        summary: at
          ? tt(t, 'atOnce', '{{at}} 执行一次', { at })
          : tt(t, 'atUnknown', '在设定时间执行一次'),
        isHighFrequency: false,
      }
    }

    case 'webhook':
      return {
        summary: tt(t, 'webhook', '由 webhook 入站触发，频率取决于上游调用'),
        isHighFrequency: false,
      }

    case 'table_event':
      return {
        summary: tt(t, 'tableEvent', '由表格事件触发（行新增/更新/删除时）'),
        isHighFrequency: false,
      }

    case 'extension_event':
      return {
        summary: tt(t, 'extensionEvent', '由扩展事件触发'),
        isHighFrequency: false,
      }

    case 'tracker_completed':
      return {
        summary: tt(t, 'trackerCompleted', '上游自动化完成时触发'),
        isHighFrequency: false,
      }

    default:
      return {
        summary: '',
        isHighFrequency: false,
      }
  }
}
