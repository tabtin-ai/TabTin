const HIDDEN_SETTINGS_SECTIONS: Readonly<{
  profile: ReadonlySet<string>
  organization: ReadonlySet<string>
  device: ReadonlySet<string>
}> = {
  profile: new Set([
    // 临时隐藏：连接账号依赖底层凭据基建与 Skill 绑定。
    'credentials',
    'credentials-ai',
    'credentials-apps',
    // 第一期不展示个人访问令牌 / CLI 凭据入口。
    'developer',
    // 分身 / 技能库已迁到任务侧栏，设置内不再重复入口。
    'myAgents',
    'skillLibrary',
  ]),
  organization: new Set([
    // 暂时隐藏「应用与扩展」（保留实现，仅从侧栏收起）。
    // 「回收站」保留「资源回收站」；Workspace 回收站由 SPACE_TRASH_UI_ENABLED 控制。
    'appsIntegration',
  ]),
  device: new Set(),
}

export function isSettingsSectionVisible(
  category: 'profile' | 'organization' | 'device',
  section: string,
): boolean {
  return !HIDDEN_SETTINGS_SECTIONS[category].has(section)
}

export function isSettingsRouteVisible(route: {
  category: 'profile' | 'organization' | 'device'
  section: string
}): boolean {
  return isSettingsSectionVisible(route.category, route.section)
}
