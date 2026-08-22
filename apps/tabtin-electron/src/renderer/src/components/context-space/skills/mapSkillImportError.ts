/**
 * 把导入失败的技术错误映射成用户可读文案。
 * 匹配后端 SkillServiceError / HTTP 兜底句；未知错误走通用提示，避免裸英文 HTTP。
 */
export function mapSkillImportError(
  raw: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const message = raw instanceof Error
    ? raw.message
    : typeof raw === 'string'
      ? raw
      : ''
  const lower = message.toLowerCase()

  if (
    /skill\.md/.test(lower)
    && (/未找到|找不到|missing|not found|no skill|必须包含|required/.test(lower) || /无法导入/.test(message))
  ) {
    return t('skills.importDialog.errors.noSkillMd', {
      defaultValue: '未找到有效的 SKILL.md，请确认选对了 Skill 目录',
    })
  }
  if (/frontmatter|---/.test(lower) || /缺少 name|missing name|name 字段/.test(lower)) {
    return t('skills.importDialog.errors.invalidFrontmatter', {
      defaultValue: 'SKILL.md 开头的说明信息不完整或格式不对，请检查名称与描述',
    })
  }
  if (/kebab-case|标识符|identifier|slug|name 必须/.test(lower)) {
    return t('skills.importDialog.errors.invalidName', {
      defaultValue: 'Skill 名称不符合规范，请使用英文小写字母、数字和连字符（如 weekly-report）',
    })
  }
  if (/20\s*mb|too large|过大|超限|bundle/.test(lower)) {
    return t('skills.importDialog.errors.tooLarge', {
      defaultValue: '文件过大（单包上限 20MB），请精简后再导入',
    })
  }
  if (/限流|rate.?limit|429/.test(lower)) {
    return t('skills.importDialog.errors.rateLimited', {
      defaultValue: '下载被限流，请稍后再试',
    })
  }
  if (
    /request timeout|absolute timeout|socket hang up|etimedout|econnreset|econnrefused|network error|fetch failed|failed to fetch|curl\s*28|connection was reset|recv failure|expected flush|从 github 拉取|网络中断/.test(lower)
  ) {
    return t('skills.importDialog.errors.networkTimeout', {
      defaultValue: '导入超时或网络中断。请检查网络或代理后重试；也可改用本地文件夹导入',
    })
  }
  if (
    /不是有效的 skill 源|无法克隆 skill 源|不要粘贴浏览器标题|repository ['"]?[^'"]+['"]? does not exist|failed to clone/.test(lower)
  ) {
    return t('skills.importDialog.errors.invalidNpmSource', {
      defaultValue: 'Skill 源无法识别。请填写 owner/repo 或完整 GitHub URL，不要粘贴浏览器标题或 npx 命令前缀',
    })
  }
  if (/404|not found/.test(lower) && /http|url|下载|download/.test(lower)) {
    return t('skills.importDialog.errors.urlNotFound', {
      defaultValue: '链接无效或资源不存在，请检查 URL',
    })
  }
  if (/403|forbidden|401|unauthorized/.test(lower)) {
    return t('skills.importDialog.errors.urlForbidden', {
      defaultValue: '没有权限下载该资源，请确认链接可公开访问',
    })
  }
  if (/skills api error|bad request|internal server/.test(lower)) {
    return t('skills.importDialog.errors.generic', {
      defaultValue: '导入失败，请检查 SKILL.md 格式与文件大小后重试',
    })
  }
  if (message.trim()) {
    // 已是中文人话（后端多数 SkillServiceError）则原样展示；否则兜底。
    if (/[\u4e00-\u9fff]/.test(message) && !/Skills API error/i.test(message)) {
      return message
    }
  }
  return t('skills.importDialog.errors.generic', {
    defaultValue: '导入失败，请检查 SKILL.md 格式与文件大小后重试',
  })
}
