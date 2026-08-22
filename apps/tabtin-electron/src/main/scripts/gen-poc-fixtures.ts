/**
 * gen-poc-fixtures — POC 测试样本 PDF 生成器
 *
 * 用 jspdf（项目已有依赖 4.1.0）生成本地 PDF 解析 POC 所需的 3+2 类样本：
 *   1. text-only.pdf       —— 10 页纯文本 Lorem ipsum（典型用户场景：论文、合同、邮件导出）
 *   2. scanned-fake.pdf    —— 3 页模拟扫描件（只嵌入图像 XObject，无 Tj 操作符 → 无文本层）
 *   3. mixed.pdf           —— 5 页混合（文本页与纯图像页交替，模拟部分 OCR 成功的扫描件）
 *   4. text-only-100p.pdf  —— 100 页性能基线样本
 *   5. text-only-500p.pdf  —— 500 页压力测试样本
 *
 * 关键技术点：
 *   - jspdf 不显式调用 doc.text() 的页面不会产生文本层（只有 Do/cm 操作符）—— 这是
 *     "真实扫描件"在 pdfjs 解析侧的同等表现（pdfjs.getTextContent 返回空 items），
 *     满足 POC Q3 的识别能力验证需求。
 *   - 生成的 500p 样本体积约 700KB，远小于云端 10MB 异步阈值，性能测试场景代表性足够。
 *
 * 执行：
 *   pnpm exec tsx apps/tabtin-electron/src/main/scripts/gen-poc-fixtures.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsPDF } from 'jspdf'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))

const OUT_DIR = resolve(__dirname, '../../../fixtures/poc-pdfs')
mkdirSync(OUT_DIR, { recursive: true })

const SCANNED_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100">
  <rect width="800" height="1100" fill="#f5f5f0"/>
  <text x="60" y="60" font-family="serif" font-size="26" fill="#222">合同文本（扫描件）</text>
  <text x="60" y="120" font-family="serif" font-size="18" fill="#333">甲方与乙方就本地 PDF 解析 POC 事宜订立如下条款。</text>
  <text x="60" y="160" font-family="serif" font-size="18" fill="#333">第一条 目标。验证可行性，识别扫描件能力。</text>
  <text x="60" y="200" font-family="serif" font-size="18" fill="#333">第二条 交付。POC 脚本 + 样本 + 报告。</text>
  <text x="60" y="240" font-family="serif" font-size="18" fill="#333">第三条 验收。10 页 &lt; 1s，扫描件 &lt; 50 字符/页。</text>
  <text x="60" y="300" font-family="serif" font-size="16" fill="#555">Signed: TabTin / 2026-04-17</text>
  <line x1="60" y1="1050" x2="740" y2="1050" stroke="#888" stroke-width="1"/>
</svg>
`

async function buildScannedPageJpeg(): Promise<string> {
  const buf = await sharp(Buffer.from(SCANNED_SVG))
    .jpeg({ quality: 70 })
    .toBuffer()
  return 'data:image/jpeg;base64,' + buf.toString('base64')
}

const LOREM_PARAS = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  '合同编号 TT-2026-0417。本协议由甲乙双方于本日订立，就本地 PDF 解析 POC 事宜达成如下共识：甲方负责提供样本文件，乙方负责实现 pdfjs-dist 主进程集成与扫描件识别能力，并按里程碑交付可量化的性能基线数据。',
  '第一条 目标。验证在 Electron 主进程（Node 运行时）通过 pdfjs-dist 提取 PDF 文本层的技术可行性，并识别无文本层的扫描件。第二条 交付。POC 脚本、测试样本、性能基线表格与推荐集成方案。第三条 验收。10 页 PDF 解析 < 1s，内存峰值 < 200MB。',
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow. Waltz, bad nymph, for quick jigs vex.',
]

function addTextPage(doc: jsPDF, pageLabel: string, paragraphs: number = 5): void {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)

  doc.setFontSize(16)
  doc.text(`${pageLabel}`, 20, 20)
  doc.setFontSize(12)

  let y = 35
  const lineHeight = 6
  const maxWidth = 170
  for (let i = 0; i < paragraphs; i++) {
    const para = LOREM_PARAS[i % LOREM_PARAS.length]
    const lines = doc.splitTextToSize(para, maxWidth) as string[]
    for (const line of lines) {
      if (y > 280) break
      doc.text(line, 20, y)
      y += lineHeight
    }
    y += lineHeight / 2
  }
}

function addImageOnlyPage(doc: jsPDF, dataUrl: string): void {
  doc.addImage(dataUrl, 'JPEG', 10, 10, 190, 277)
}

function genTextOnly(pages: number, filename: string): void {
  const doc = new jsPDF()
  for (let i = 1; i <= pages; i++) {
    if (i > 1) doc.addPage()
    addTextPage(doc, `第 ${i} 页 — 纯文本样本`, 5)
  }
  const buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const outPath = resolve(OUT_DIR, filename)
  writeFileSync(outPath, buffer)
  const sizeKB = (buffer.length / 1024).toFixed(1)
  console.log(`✓ ${filename} 已生成（${pages} 页, ${sizeKB} KB）`)
}

async function genScannedFake(): Promise<void> {
  const dataUrl = await buildScannedPageJpeg()
  const doc = new jsPDF()
  for (let i = 1; i <= 3; i++) {
    if (i > 1) doc.addPage()
    addImageOnlyPage(doc, dataUrl)
  }
  const buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const outPath = resolve(OUT_DIR, 'scanned-fake.pdf')
  writeFileSync(outPath, buffer)
  console.log(`✓ scanned-fake.pdf 已生成（3 页纯图像, ${(buffer.length / 1024).toFixed(1)} KB）`)
}

async function genMixed(): Promise<void> {
  const dataUrl = await buildScannedPageJpeg()
  const doc = new jsPDF()
  for (let i = 1; i <= 5; i++) {
    if (i > 1) doc.addPage()
    if (i % 2 === 1) {
      addTextPage(doc, `第 ${i} 页 — 文本内容`, 4)
    } else {
      addImageOnlyPage(doc, dataUrl)
    }
  }
  const buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const outPath = resolve(OUT_DIR, 'mixed.pdf')
  writeFileSync(outPath, buffer)
  console.log(`✓ mixed.pdf 已生成（5 页混合：文/图/文/图/文, ${(buffer.length / 1024).toFixed(1)} KB）`)
}

async function genMostlyScanned(): Promise<void> {
  const dataUrl = await buildScannedPageJpeg()
  const doc = new jsPDF()
  for (let i = 1; i <= 10; i++) {
    if (i > 1) doc.addPage()
    if (i === 5) {
      doc.setFontSize(10)
      doc.text('封面第 5 页 — 少量 OCR 文本：发票号 INV-2026-0417 金额 ￥8800.00', 20, 20)
    } else {
      addImageOnlyPage(doc, dataUrl)
    }
  }
  const buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const outPath = resolve(OUT_DIR, 'mostly-scanned.pdf')
  writeFileSync(outPath, buffer)
  console.log(
    `✓ mostly-scanned.pdf 已生成（10 页 = 9 扫描 + 1 文本短句, ${(buffer.length / 1024).toFixed(1)} KB）`,
  )
}

async function genEncrypted(): Promise<void> {
  const doc = new jsPDF({
    encryption: {
      userPassword: 'poc-user-pwd',
      ownerPassword: 'poc-owner-pwd',
      userPermissions: ['print'],
    },
  })
  doc.setFontSize(14)
  doc.text('加密 PDF — 这段内容应被密码保护，未解锁不可提取。', 20, 40)
  const buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const outPath = resolve(OUT_DIR, 'encrypted.pdf')
  writeFileSync(outPath, buffer)
  console.log(`✓ encrypted.pdf 已生成（1 页 + user/owner password, ${(buffer.length / 1024).toFixed(1)} KB）`)
}

function genCorrupted(): void {
  const doc = new jsPDF()
  doc.setFontSize(14)
  doc.text('这个 PDF 结尾会被故意截断，模拟网络下载中断 / 磁盘损坏场景。', 20, 40)
  let buffer = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  buffer = buffer.subarray(0, Math.floor(buffer.length * 0.6))
  const outPath = resolve(OUT_DIR, 'corrupted.pdf')
  writeFileSync(outPath, buffer)
  console.log(`✓ corrupted.pdf 已生成（截断到 60%, ${(buffer.length / 1024).toFixed(1)} KB）`)
}

async function main(): Promise<void> {
  console.log(`[gen-poc-fixtures] 输出目录: ${OUT_DIR}\n`)
  genTextOnly(10, 'text-only.pdf')
  await genScannedFake()
  await genMixed()
  await genMostlyScanned()
  await genEncrypted()
  genCorrupted()
  genTextOnly(100, 'text-only-100p.pdf')
  genTextOnly(500, 'text-only-500p.pdf')
  console.log('\n✓ 所有样本生成完毕。')
}

void main()
