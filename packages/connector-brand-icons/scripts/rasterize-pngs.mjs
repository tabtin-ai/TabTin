#!/usr/bin/env node
/** Rasterize icons/*.svg → icons/*.png (transparent) via @resvg/resvg-js. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')

for (const file of readdirSync(iconsDir).filter(f => f.endsWith('.svg'))) {
  const svg = readFileSync(join(iconsDir, file))
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 128 },
    background: 'rgba(0,0,0,0)',
  })
  const png = resvg.render().asPng()
  const out = join(iconsDir, file.replace(/\.svg$/i, '.png'))
  writeFileSync(out, png)
  console.log('wrote', out)
}
