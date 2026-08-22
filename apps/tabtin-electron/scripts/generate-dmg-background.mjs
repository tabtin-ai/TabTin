#!/usr/bin/env node

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(scriptDir, '../build/dmg/background.png')
const width = 720
const height = 520

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="720" y2="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#F8FAFC"/>
    </linearGradient>
  </defs>

  <rect width="720" height="520" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="719" height="519" stroke="#E5E7EB"/>

  <text x="360" y="116" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif" font-size="72" font-weight="650" fill="#171717">TabTin</text>
  <text x="360" y="158" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="6" fill="#7C8491">AI WORKSPACE</text>

  <line x1="120" y1="342" x2="600" y2="342" stroke="#EDF0F3"/>

  <text x="360" y="410" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif" font-size="23" font-weight="500" fill="#20242A">
    拖动 <tspan font-weight="750">TabTin</tspan> 图标到 <tspan font-weight="750">Applications</tspan> 文件夹
  </text>
  <text x="360" y="440" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif" font-size="18" font-weight="450" fill="#A0A7B2">完成安装后即可从启动台或 Dock 打开</text>
</svg>`

await mkdir(dirname(outPath), { recursive: true })
await sharp(Buffer.from(svg)).png().toFile(outPath)
console.log(outPath)
