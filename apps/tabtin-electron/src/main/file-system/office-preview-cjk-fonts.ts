import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

/**
 * LibreOffice 高保真预览把 PPT 栅格成 PNG。中文 PPT 常指定微软雅黑，
 * 本机没有这款字体时，LO 会用西文替代，中文变成空心方框。
 * 换字体替换表或种子目录后必须升这个版本，否则会继续命中旧的方框缓存。
 */
export const LIBREOFFICE_CJK_PREVIEW_CACHE_VERSION = 'lo-cjk-subst-v1'

const MISSING_CJK_TYPEFACES = [
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  '微软雅黑',
  '微软雅黑 UI',
  'SimSun',
  'NSimSun',
  '宋体',
  '新宋体',
  'SimHei',
  '黑体',
  'DengXian',
  '等线',
  'KaiTi',
  '楷体',
  'FangSong',
  '仿宋',
  'Source Han Sans CN',
  'Source Han Sans SC',
  'Noto Sans SC',
  'Noto Sans CJK SC',
]

type CjkFallbackCandidate = {
  name: string
  files: string[]
}

const CJK_FALLBACK_CANDIDATES: CjkFallbackCandidate[] = [
  {
    name: 'Hiragino Sans GB',
    files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'],
  },
  {
    name: 'Songti SC',
    files: ['/System/Library/Fonts/Supplemental/Songti.ttc'],
  },
  {
    name: 'Heiti SC',
    files: [
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/System/Library/Fonts/STHeiti Light.ttc',
    ],
  },
  {
    name: 'Arial Unicode MS',
    files: ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf'],
  },
  {
    name: 'Microsoft YaHei',
    files: [
      'C:\\Windows\\Fonts\\msyh.ttc',
      'C:\\Windows\\Fonts\\msyh.ttf',
    ],
  },
  {
    name: 'Microsoft YaHei UI',
    files: [
      'C:\\Windows\\Fonts\\msyh.ttc',
      'C:\\Windows\\Fonts\\msyhl.ttc',
    ],
  },
  {
    name: 'Noto Sans CJK SC',
    files: [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    ],
  },
]

export type CjkFallbackFont = {
  name: string
  files: string[]
}

function existingFiles(files: string[]): string[] {
  return files.filter(file => {
    try {
      return fs.existsSync(file)
    } catch {
      return false
    }
  })
}

export function resolveCjkFallbackFont(
  candidates: CjkFallbackCandidate[] = CJK_FALLBACK_CANDIDATES,
): CjkFallbackFont | null {
  for (const candidate of candidates) {
    const files = existingFiles(candidate.files)
    if (files.length > 0) return { name: candidate.name, files }
  }
  return null
}

export function buildLibreOfficeFontSubstitutionXcu(
  fallbackName: string,
  missingTypefaces: string[] = MISSING_CJK_TYPEFACES,
): string {
  const pairs = missingTypefaces
    .filter(typeface => typeface.toLowerCase() !== fallbackName.toLowerCase())
    .map((typeface, index) => `  <item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs">
    <node oor:name="cjk${index}" oor:op="fuse">
      <prop oor:name="ReplaceFont" oor:op="fuse"><value>${escapeXml(typeface)}</value></prop>
      <prop oor:name="SubstituteFont" oor:op="fuse"><value>${escapeXml(fallbackName)}</value></prop>
      <prop oor:name="Always" oor:op="fuse"><value>true</value></prop>
      <prop oor:name="OnScreenOnly" oor:op="fuse"><value>false</value></prop>
    </node>
  </item>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop></item>
${pairs}
</oor:items>
`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function linkFontFile(source: string, fontsDir: string): Promise<void> {
  const dest = path.join(fontsDir, path.basename(source))
  try {
    await fsPromises.symlink(source, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return
    await fsPromises.copyFile(source, dest)
  }
}

export async function writeLibreOfficeCjkFallbackProfile(
  profileDir: string,
  fallback: CjkFallbackFont | null = resolveCjkFallbackFont(),
): Promise<CjkFallbackFont | null> {
  if (!fallback) return null

  const userDir = path.join(profileDir, 'user')
  const fontsDir = path.join(userDir, 'fonts')
  await fsPromises.mkdir(fontsDir, { recursive: true })
  for (const file of fallback.files) {
    await linkFontFile(file, fontsDir)
  }
  await fsPromises.writeFile(
    path.join(userDir, 'registrymodifications.xcu'),
    buildLibreOfficeFontSubstitutionXcu(fallback.name),
    'utf-8',
  )
  return fallback
}
