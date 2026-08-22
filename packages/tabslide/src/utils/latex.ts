import { mathjax } from '@mathjax/src/mjs/mathjax.js'
import { TeX } from '@mathjax/src/mjs/input/tex.js'
import { SVG } from '@mathjax/src/mjs/output/svg.js'
import { liteAdaptor } from '@mathjax/src/mjs/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js'
import '@mathjax/src/mjs/input/tex/action/ActionConfiguration.js'
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/mjs/input/tex/amscd/AmsCdConfiguration.js'
import '@mathjax/src/mjs/input/tex/autoload/AutoloadConfiguration.js'
import '@mathjax/src/mjs/input/tex/base/BaseConfiguration.js'
import '@mathjax/src/mjs/input/tex/bbm/BbmConfiguration.js'
import '@mathjax/src/mjs/input/tex/bboldx/BboldxConfiguration.js'
import '@mathjax/src/mjs/input/tex/bbox/BboxConfiguration.js'
import '@mathjax/src/mjs/input/tex/begingroup/BegingroupConfiguration.js'
import '@mathjax/src/mjs/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import '@mathjax/src/mjs/input/tex/braket/BraketConfiguration.js'
import '@mathjax/src/mjs/input/tex/bussproofs/BussproofsConfiguration.js'
import '@mathjax/src/mjs/input/tex/cancel/CancelConfiguration.js'
import '@mathjax/src/mjs/input/tex/cases/CasesConfiguration.js'
import '@mathjax/src/mjs/input/tex/centernot/CenternotConfiguration.js'
import '@mathjax/src/mjs/input/tex/color/ColorConfiguration.js'
import '@mathjax/src/mjs/input/tex/colortbl/ColortblConfiguration.js'
import '@mathjax/src/mjs/input/tex/colorv2/ColorV2Configuration.js'
import '@mathjax/src/mjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/mjs/input/tex/dsfont/DsfontConfiguration.js'
import '@mathjax/src/mjs/input/tex/empheq/EmpheqConfiguration.js'
import '@mathjax/src/mjs/input/tex/enclose/EncloseConfiguration.js'
import '@mathjax/src/mjs/input/tex/extpfeil/ExtpfeilConfiguration.js'
import '@mathjax/src/mjs/input/tex/gensymb/GensymbConfiguration.js'
import '@mathjax/src/mjs/input/tex/html/HtmlConfiguration.js'
import '@mathjax/src/mjs/input/tex/mathtools/MathtoolsConfiguration.js'
import '@mathjax/src/mjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/mjs/input/tex/noerrors/NoErrorsConfiguration.js'
import '@mathjax/src/mjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import '@mathjax/src/mjs/input/tex/physics/PhysicsConfiguration.js'
import '@mathjax/src/mjs/input/tex/require/RequireConfiguration.js'
import '@mathjax/src/mjs/input/tex/setoptions/SetOptionsConfiguration.js'
import '@mathjax/src/mjs/input/tex/tagformat/TagFormatConfiguration.js'
import '@mathjax/src/mjs/input/tex/texhtml/TexHtmlConfiguration.js'
import '@mathjax/src/mjs/input/tex/textcomp/TextcompConfiguration.js'
import '@mathjax/src/mjs/input/tex/textmacros/TextMacrosConfiguration.js'
import '@mathjax/src/mjs/input/tex/unicode/UnicodeConfiguration.js'
import '@mathjax/src/mjs/input/tex/units/UnitsConfiguration.js'
import '@mathjax/src/mjs/input/tex/upgreek/UpgreekConfiguration.js'
import '@mathjax/src/mjs/input/tex/verb/VerbConfiguration.js'
import {
  type LatexRenderOptions,
  type LatexSvgRenderResult,
  parseViewBox,
  patchSvgRoot,
  sanitizeSvgUnsafe,
} from './latex-shared'

export * from './latex-shared'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const TEX_PACKAGES = [
  'base',
  'action',
  'ams',
  'amscd',
  'autoload',
  'bbm',
  'bboldx',
  'bbox',
  'begingroup',
  'boldsymbol',
  'braket',
  'bussproofs',
  'cancel',
  'cases',
  'centernot',
  'color',
  'colortbl',
  'colorv2',
  'configmacros',
  'dsfont',
  'empheq',
  'enclose',
  'extpfeil',
  'gensymb',
  'html',
  'mathtools',
  'mhchem',
  'newcommand',
  'noerrors',
  'noundefined',
  'physics',
  'require',
  'setoptions',
  'tagformat',
  'texhtml',
  'textcomp',
  'textmacros',
  'unicode',
  'units',
  'upgreek',
  'verb',
] as const

const tex = new TeX({ packages: [...TEX_PACKAGES] })
const svgOutput = new SVG({ fontCache: 'none' })
const mjDoc = mathjax.document('', { InputJax: tex, OutputJax: svgOutput })

function normalizeAndExtract(
  rawSvg: string,
  color?: string,
): LatexSvgRenderResult {
  const cleaned = sanitizeSvgUnsafe(rawSvg)

  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    const vb =
      cleaned.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1]
      || cleaned.match(/viewBox\s*=\s*'([^']+)'/i)?.[1]
    const nums = vb
      ? vb
          .split(/[\s,]+/)
          .map((n) => parseFloat(n))
          .filter((n) => Number.isFinite(n))
      : []
    const viewBox: [number, number] = nums.length === 4 && nums[2] > 0 && nums[3] > 0
      ? [nums[2], nums[3]]
      : [100, 32]
    const viewBoxAttr = nums.length === 4 && nums[2] > 0 && nums[3] > 0
      ? `${nums[0]} ${nums[1]} ${nums[2]} ${nums[3]}`
      : `0 0 ${viewBox[0]} ${viewBox[1]}`

    let svg = patchSvgRoot(cleaned, {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: viewBoxAttr,
      preserveAspectRatio: 'xMidYMid meet',
      ...(color ? { style: `color:${color}` } : {}),
    })
    svg = patchSvgRoot(svg, { width: `${viewBox[0]}`, height: `${viewBox[1]}` })
    return { svg, viewBox }
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(cleaned, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  if (!svgEl) {
    throw new Error('LaTeX SVG 解析失败')
  }

  svgEl.querySelectorAll('script,foreignObject').forEach((node) => node.remove())

  const walker = doc.createTreeWalker(svgEl, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Element
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.toLowerCase()
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name)
        continue
      }
      if ((name === 'href' || name === 'xlink:href') && value.startsWith('javascript:')) {
        node.removeAttribute(attr.name)
      }
    }
  }

  const viewBoxInfo = parseViewBox(svgEl)
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svgEl.setAttribute('viewBox', viewBoxInfo.viewBox)
  svgEl.setAttribute('width', `${viewBoxInfo.width}`)
  svgEl.setAttribute('height', `${viewBoxInfo.height}`)
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  if (color) {
    const currentStyle = svgEl.getAttribute('style') || ''
    svgEl.setAttribute('style', `${currentStyle}${currentStyle ? ';' : ''}color:${color}`)
  }

  const firstPath = svgEl.querySelector('path')
  const path = firstPath?.getAttribute('d') || undefined

  const serialized = new XMLSerializer().serializeToString(svgEl)
  return {
    svg: serialized,
    viewBox: [viewBoxInfo.width, viewBoxInfo.height],
    path,
  }
}

export function renderLatexToSvg(
  latex: string,
  options: LatexRenderOptions = {},
): LatexSvgRenderResult {
  const source = latex.trim()
  if (!source) {
    throw new Error('公式不能为空')
  }

  const display = options.display ?? true
  const node = mjDoc.convert(source, {
    display,
    em: 16,
    ex: 8,
    containerWidth: 80 * 16,
  })

  const rawSvg = adaptor.outerHTML(node)
  return normalizeAndExtract(rawSvg, options.color)
}
