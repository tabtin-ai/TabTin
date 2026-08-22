import { describe, it, expect } from 'vitest'
import {
  buildProductionCsp,
  resolveAssetPublicOrigin,
  DEFAULT_ASSET_PUBLIC_DOMAIN,
  HTML_ARTIFACT_CDN_ORIGINS,
  type ProductionCspEnv,
} from './production-csp'

/**
 * 生产 CSP 白名单回归测试。
 *
 * 缘起 ：TabDoc htmlBlock 的 HTML artifact 用 iframe 加载公共资产域上的文件，
 * 但该域此前只进了 connect-src、没进 frame-src——dev（宽松 CSP）看不出来，
 * 打包态直接白屏。这类"两个白名单没对齐"必须在单测层拦住。
 */

const baseEnv = (over: ProductionCspEnv = {}): ProductionCspEnv => ({
  VITE_API_BASE_URL: 'https://api.example.com/api',
  NODE_ENV: 'production',
  ...over,
})

const directive = (csp: string, name: string): string => {
  const found = csp.split('; ').find((d) => d.startsWith(`${name} `))
  return found ?? ''
}

describe('生产 CSP — frame-src 必须覆盖 htmlBlock artifact 的落点', () => {
  it('公共资产域同时进 connect-src 和 frame-src（ 死锁回归）', () => {
    const csp = buildProductionCsp(baseEnv({ ASSET_PUBLIC_DOMAIN: 'https://assets.example.com' }))
    expect(directive(csp, 'connect-src')).toContain('https://assets.example.com')
    expect(directive(csp, 'frame-src')).toContain('https://assets.example.com')
  })

  it('自建部署配了自定义资产域时，frame-src 跟着走', () => {
    const csp = buildProductionCsp(baseEnv({ ASSET_PUBLIC_DOMAIN: 'https://cdn.example.com' }))
    expect(directive(csp, 'frame-src')).toContain('https://cdn.example.com')
  })

  it('未配资产域时回落默认域，且两个白名单仍一致', () => {
    const csp = buildProductionCsp(baseEnv())
    const fallback = new URL(DEFAULT_ASSET_PUBLIC_DOMAIN).origin
    expect(directive(csp, 'connect-src')).toContain(fallback)
    expect(directive(csp, 'frame-src')).toContain(fallback)
  })

  it('OSS 直连域（未配 CDN 的部署）也在 frame-src 内', () => {
    const csp = buildProductionCsp(baseEnv())
    expect(directive(csp, 'frame-src')).toContain('https://*.aliyuncs.com')
  })

  it('私有 HTML Blob 渲染需要 frame-src blob:', () => {
    const csp = buildProductionCsp(baseEnv())
    expect(directive(csp, 'frame-src').split(' ')).toContain('blob:')
  })

  it('资产域取值优先级：ASSET_PUBLIC_DOMAIN > ALIYUN_OSS_CDN_DOMAIN > VITE_*', () => {
    expect(resolveAssetPublicOrigin({
      ASSET_PUBLIC_DOMAIN: 'https://a.example.com',
      ALIYUN_OSS_CDN_DOMAIN: 'b.example.com',
    })).toBe('https://a.example.com')
    // 裸域名（无协议）补 https
    expect(resolveAssetPublicOrigin({ ALIYUN_OSS_CDN_DOMAIN: 'b.example.com' }))
      .toBe('https://b.example.com')
  })

  it('资产域配成非法值时不产出空白名单项', () => {
    const csp = buildProductionCsp(baseEnv({ ASSET_PUBLIC_DOMAIN: ':::not a url:::' }))
    expect(directive(csp, 'frame-src').split(' ')).not.toContain('')
    expect(resolveAssetPublicOrigin({ ASSET_PUBLIC_DOMAIN: ':::not a url:::' })).toBe('')
  })
})

describe('生产 CSP — HTML 块 CDN（blob 继承壳 CSP）', () => {
  it('script-src / style-src / font-src 含 HTML_ARTIFACT_CDN_ORIGINS，connect-src 不含', () => {
    const csp = buildProductionCsp(baseEnv())
    const connectSrc = directive(csp, 'connect-src')
    for (const origin of HTML_ARTIFACT_CDN_ORIGINS) {
      expect(directive(csp, 'script-src')).toContain(origin)
      expect(directive(csp, 'style-src')).toContain(origin)
      expect(directive(csp, 'font-src')).toContain(origin)
      // 静态 CDN 不进 connect-src，避免为 sourcemap / fetch 扩大主窗口网络出口
      expect(connectSrc.split(' ')).not.toContain(origin)
    }
  })
})

describe('生产 CSP — 既有收紧项不能被削弱', () => {
  it('LAN HTTP API origin 精确进入 connect/img/media，不放开任意 http:', () => {
    const csp = buildProductionCsp(baseEnv({
      VITE_API_BASE_URL: 'http://192.168.8.10:8080/api',
    }))
    for (const name of ['connect-src', 'img-src', 'media-src']) {
      const sources = directive(csp, name).split(' ')
      expect(sources).toContain('http://192.168.8.10:8080')
      expect(sources).not.toContain('http:')
      expect(sources).not.toContain('http://192.168.*')
    }
  })

  it('云端 HTTPS API origin 精确进入 connect/img/media', () => {
    const csp = buildProductionCsp(baseEnv({
      VITE_API_BASE_URL: 'https://tabtin.example.com/api',
    }))
    for (const name of ['connect-src', 'img-src', 'media-src']) {
      expect(directive(csp, name).split(' ')).toContain('https://tabtin.example.com')
    }
  })

  it('保留 unsafe-eval（Monaco）与 unsafe-inline（htmlBlock blob 继承壳 CSP，）', () => {
    const csp = buildProductionCsp(baseEnv())
    const scriptSrc = directive(csp, 'script-src')
    expect(scriptSrc).toContain("'self'")
    expect(scriptSrc).toContain("'unsafe-eval'")
    // blob:/srcdoc iframe 继承壳 CSP；用户 HTML 的 onclick / <script> 需要它。
    // 无此条时打包态「看得见样式但点不动」，dev（index.html 含 unsafe-inline）看不出来。
    expect(scriptSrc).toContain("'unsafe-inline'")
  })

  it('object-src / base-uri / form-action 保持收紧', () => {
    const csp = buildProductionCsp(baseEnv())
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('不含任何 localhost / 内网地址', () => {
    const csp = buildProductionCsp(baseEnv())
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|192\.168\./)
  })

  it('API origin 推导出 wss 对端', () => {
    const csp = buildProductionCsp(baseEnv({ VITE_API_BASE_URL: 'https://api.example.com/api' }))
    expect(directive(csp, 'connect-src')).toContain('wss://api.example.com')
  })

  it('生产构建缺 API 域名时直接抛错，不发宽泛策略的包', () => {
    expect(() => buildProductionCsp({ NODE_ENV: 'production' })).toThrow(/未设置/)
    expect(() => buildProductionCsp({
      NODE_ENV: 'production',
      VITE_API_BASE_URL: 'file:///tmp/not-an-api',
    })).toThrow(/未设置/)
  })

  it('非生产模式缺 API 域名时回退宽泛策略并告警', () => {
    const warnings: string[] = []
    const csp = buildProductionCsp({ NODE_ENV: 'development' }, (m) => warnings.push(m))
    expect(directive(csp, 'connect-src')).toContain('https:')
    expect(warnings).toHaveLength(1)
  })

  it('CSP_EXTRA_FRAME_SRC 扩展点生效（自建部署逃生门）', () => {
    const csp = buildProductionCsp(baseEnv({ CSP_EXTRA_FRAME_SRC: 'https://x.test https://y.test' }))
    expect(directive(csp, 'frame-src')).toContain('https://x.test')
    expect(directive(csp, 'frame-src')).toContain('https://y.test')
  })
})
