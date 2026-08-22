/**
 * 生成 shaping（morph）点云的跨端基准 fixture。
 *
 * iOS / Android 的移植版单测对着这份数字断言，确保三端画的是同一个形，
 * 而不是三份「看起来差不多」的实现。改了 painter 或 shaping 预设就重跑：
 *
 *   node packages/agent-orb/scripts/emit-morph-fixture.mjs
 *
 * 产物：packages/agent-orb/fixtures/morph-shaping-64.json（唯一真源）
 *
 * 两个消费方的同步方式不同，别记混：
 *   - Android：test resources 下有一份物理拷贝，本脚本会**自动刷新**，无需手动 copy。
 *   - iOS：把点位内联成了 Swift 字面量（不走 bundle resource，以免动 pbxproj 的资源链路），
 *     本脚本无法自动改。重跑后请执行下面这条来检出漂移——它读的就是上面这份真源：
 *
 *       swiftc -O -o /tmp/verify-shaping-cloud \
 *         apps/tabtin-ios/scripts/verify-shaping-cloud.swift \
 *         apps/tabtin-ios/Tabtin/Features/Conversation/MediaImageShapingCloud.swift \
 *         && /tmp/verify-shaping-cloud
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { buildOrbFrame, resolveOrbDotInk, resolveOrbPreset } = await import(
  resolve(here, '../dist/index.js')
)

const PRESET_SIZE = 64
const TEXTURE = 'shaping'

/**
 * ⚠️ 单位：这里的元素是**相位**，脚本会再乘 `preset.speed` 才喂给 painter
 * （见下方 `t: t * preset.speed`）。所以 `SAMPLE_TS` 里写 x，实际采的是 `x × 2.405`。
 * 消费方断言时要用 fixture 里的 `tScaled`，不是 `t`。
 *
 * 采样点选取理由（括号内为实际 tScaled）：
 *   0    (0)      圆的静止段起点
 *   1.443(3.47)   三角段的静止区
 *   1.9  (4.57)   变形中段
 *   2.3  (5.53)   CYCLE 边界
 *   4.6  (11.06)  第二个边界
 *   6.9  (16.59)  整轮之后，验证取模不漂
 *
 * 已知未覆盖：Electron 在减弱动效下钉的静帧是 **tScaled = 1.443**（`0.6 × speed`），
 * 对应这里的相位 `0.6`，当前没采。风险低——`dots(t)` 是确定性纯函数，6 个采样点已跨越
 * 全部三段形状与 hold/blend 两种区段，1.443 落在其间。要补就往数组里加 `0.6`，
 * 然后照文件头的说明处理 iOS 内联字面量（Android 拷贝会自动刷新）。
 */
const SAMPLE_TS = [0, 1.443, 1.9, 2.3, 4.6, 6.9]

const round6 = (v) => Number(v.toFixed(6))

const preset = resolveOrbPreset(TEXTURE, PRESET_SIZE)
const frames = SAMPLE_TS.map((t) => {
  const frame = buildOrbFrame({
    mode: preset.mode,
    size: PRESET_SIZE,
    t: t * preset.speed,
    dark: false,
    opts: { ...preset.opts },
  })
  return {
    t,
    tScaled: round6(t * preset.speed),
    dots: frame.dots.map((d) => ({ x: round6(d.x), y: round6(d.y), r: round6(d.r) })),
  }
})

const probe = buildOrbFrame({
  mode: preset.mode, size: PRESET_SIZE, t: 0, dark: false, opts: { ...preset.opts },
})
const inkLight = resolveOrbDotInk({ dark: false }, probe.dots[0].ink, 1)
const inkDark = resolveOrbDotInk({ dark: true }, probe.dots[0].ink, 1)

const out = {
  $comment:
    '由 packages/agent-orb/scripts/emit-morph-fixture.mjs 生成，勿手改。三端点云一致性基准。',
  texture: TEXTURE,
  mode: preset.mode,
  presetSize: PRESET_SIZE,
  speed: preset.speed,
  opts: preset.opts,
  dotCount: probe.dots.length,
  ink: probe.dots[0].ink,
  color: { light: inkLight, dark: inkDark },
  frames,
}

const payload = `${JSON.stringify(out, null, 2)}\n`

const outPath = resolve(here, '../fixtures/morph-shaping-64.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, payload)
console.log(`wrote ${outPath}`)
console.log(`  dots=${out.dotCount} speed=${out.speed} frames=${frames.length}`)
console.log(`  light=${JSON.stringify(inkLight)} dark=${JSON.stringify(inkDark)}`)

// 物理拷贝一律由本脚本重写，避免「改了 painter 却忘了同步，移动端继续对着旧基准绿」。
const MIRRORS = ['../../../apps/tabtin-android/app/src/test/resources/morph-shaping-64.json']
for (const rel of MIRRORS) {
  const mirrorPath = resolve(here, rel)
  mkdirSync(dirname(mirrorPath), { recursive: true })
  writeFileSync(mirrorPath, payload)
  console.log(`mirrored ${mirrorPath}`)
}
console.log('iOS 用内联字面量，不在镜像范围内——重跑后请照文件头说明跑一次 verify-shaping-cloud.swift')
