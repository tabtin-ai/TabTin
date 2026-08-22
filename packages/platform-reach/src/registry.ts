/**
 * AdapterRegistry — 平台适配器注册表
 *
 * 按平台 id 注册/查找，并支持从 URL 反查适配器（用户丢一个链接进来时选路用）。
 */
import type { PlatformAdapter } from './adapter'
import type { Verb } from './types'

/** 从 URL 取 hostname，失败返回空串（宽容处理裸域名 / 非法输入）。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    // 容错：可能传进来的是裸 hostname
    return url.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? ''
  }
}

/** host 是否属于某个平台域名（同域或子域）。 */
function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase()
  return host === d || host.endsWith('.' + d)
}

export class AdapterRegistry {
  private byId = new Map<string, PlatformAdapter>()

  register(adapter: PlatformAdapter): void {
    if (this.byId.has(adapter.id)) {
      throw new Error(`[platform-reach] duplicate adapter id: ${adapter.id}`)
    }
    this.byId.set(adapter.id, adapter)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  get(id: string): PlatformAdapter | undefined {
    return this.byId.get(id)
  }

  list(): PlatformAdapter[] {
    return [...this.byId.values()]
  }

  /** 从任意 URL 反查归属平台适配器。 */
  resolveByUrl(url: string): PlatformAdapter | undefined {
    const host = hostnameOf(url)
    if (!host) return undefined
    return this.list().find((a) => a.domains.some((d) => hostMatchesDomain(host, d)))
  }

  /** 某平台是否支持某动词。 */
  supports(id: string, verb: Verb): boolean {
    const a = this.byId.get(id)
    return !!a && a.capabilities.includes(verb) && !!a.verbs[verb]
  }
}

export { hostnameOf, hostMatchesDomain }
