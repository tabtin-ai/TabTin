/**
 * Tin 激活规则匹配器
 *
 * 判断当前页面上下文是否匹配 Tin 的 activation_rules。
 */

import { logger } from '../utils/logger'
import type { ActivationRule } from './types'

const TAG = 'ActivationMatcher'

export interface PageContext {
  url: string
  title: string
  language?: string
}

export function matchActivationRules(
  rules: ActivationRule[],
  context: PageContext,
  matchMode: 'any' | 'all' = 'any'
): boolean {
  try {
    if (!rules || rules.length === 0) return false
    const results = rules.map((rule) => matchSingleRule(rule, context))
    return matchMode === 'all' ? results.every(Boolean) : results.some(Boolean)
  } catch (err) {
    logger.error(TAG, 'evaluateActivation error:', err)
    return false
  }
}

export function matchSingleRule(rule: ActivationRule, context: PageContext): boolean {
  switch (rule.type) {
    case 'url_pattern':
      return matchUrlPatterns(rule.patterns || [], context.url)
    case 'page_language':
      return matchLanguage(rule.languages || [], context.language)
    case 'always':
      return true
    case 'title_url_match':
      return matchKeywords(rule.keywords || [], `${context.title} ${context.url}`)
    case 'page_content':
      logger.warn(
        TAG,
        'ActivationRule type "page_content" is deprecated and does NOT match page body content. ' +
          'It falls back to title+url keyword matching (same as "title_url_match"). ' +
          'Migrate your Tin definition to use "title_url_match" instead.',
      )
      return matchKeywords(rule.keywords || [], `${context.title} ${context.url}`)
    default:
      return false
  }
}

const MAX_URL_LENGTH = 4096

export function matchUrlPatterns(patterns: string[], url: string): boolean {
  if (!url || patterns.length === 0) return false
  const safeUrl = url.length > MAX_URL_LENGTH ? url.slice(0, MAX_URL_LENGTH) : url

  return patterns.some((pattern) => {
    const regex = globToRegex(pattern)
    return regex.test(safeUrl)
  })
}

const MAX_PATTERN_LENGTH = 500

/**
 * 将 Chrome Extension 风格的 URL 模式转换为正则。
 * 支持 *:// 匹配任何协议、*.domain 匹配子域名、/* 匹配路径。
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    logger.warn(TAG, `Pattern too long (${pattern.length}), truncating to ${MAX_PATTERN_LENGTH}`)
    pattern = pattern.slice(0, MAX_PATTERN_LENGTH)
  }

  const PLACEHOLDER = '\x00'
  let regexStr = pattern.replace(/\*/g, PLACEHOLDER)
  regexStr = regexStr.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  regexStr = regexStr.replace(new RegExp(PLACEHOLDER, 'g'), '.*')

  // 合并连续 .* 防止 ReDoS 回溯爆炸
  regexStr = regexStr.replace(/(\.\*)+/g, '.*')

  // *:// -> match http(s)/ftp
  regexStr = regexStr.replace(/^\.\*:\/\//, '(https?|ftp)://')

  // *.example.com -> (.*\\.)?example\\.com (match both root and subdomains)
  regexStr = regexStr.replace(/\.\*\\\./, '(.*\\.)?')

  // SD-030: *example.com (no dot after *) must also enforce subdomain boundary.
  // Without this, *://*example.com/* matches evil-example.com.
  // Only applies when .* after :// is followed by a domain-like string (word chars + escaped dot).
  regexStr = regexStr.replace(/(:\/\/)\.\*(?=[a-zA-Z0-9][a-zA-Z0-9-]*\\\.)/g, '$1(.*\\.)?')

  return new RegExp(`^${regexStr}$`, 'i')
}

export function matchLanguage(languages: string[], pageLanguage?: string): boolean {
  if (!pageLanguage || languages.length === 0) return false

  const pageLang = pageLanguage.toLowerCase()
  return languages.some((lang) => {
    const l = lang.toLowerCase()
    return pageLang === l || pageLang.startsWith(l + '-')
  })
}

export function matchKeywords(keywords: string[], text: string): boolean {
  if (!text || keywords.length === 0) return false
  const lowerText = text.toLowerCase()
  return keywords.some((kw) => lowerText.includes(kw.toLowerCase()))
}
