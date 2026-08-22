#!/usr/bin/env node
/**
 * Apply official identification colors to approved brand SVGs and regenerate PNGs.
 * Usage: node scripts/apply-brand-colors.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconsDir = join(root, 'icons')
const manifestPath = join(root, 'manifest.json')

const BRAND_COLORS = {
  github: '#181717',
  vercel: '#000000',
  stripe: '#635BFF',
  notion: '#000000',
  supabase: '#3ECF8E',
  neon: '#00E699',
  cloudflare: '#F38020',
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

function colorizeSvg(svg, color) {
  let out = svg.replace(/\sfill="[^"]*"/gi, '').replace(/\sfill='[^']*'/gi, '')
  return out.replace(/<svg\b/, `<svg fill="${color}"`)
}

for (const [key, entry] of Object.entries(manifest.brands)) {
  if (entry.status !== 'approved' || !entry.file) continue
  const color = BRAND_COLORS[key]
  if (!color) {
    console.warn(`skip ${key}: no color mapping`)
    continue
  }
  entry.color = color
  const svgPath = join(iconsDir, entry.file)
  writeFileSync(svgPath, colorizeSvg(readFileSync(svgPath, 'utf8'), color))
  console.log(`colored ${key} → ${color}`)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const raster = spawnSync(process.execPath, [join(root, 'scripts/rasterize-pngs.mjs')], {
  cwd: root,
  encoding: 'utf8',
})
process.stdout.write(raster.stdout || '')
process.stderr.write(raster.stderr || '')
if (raster.status !== 0) process.exit(raster.status ?? 1)
console.log('done')
