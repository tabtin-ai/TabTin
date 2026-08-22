import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import type { DetectedBrowser, BrowserProfile } from './extractors/types'
import { createLogger } from '../logger'

const log = createLogger('BrowserDetector')

const HOME = homedir()
const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')

interface PlatformPaths {
  appPath: string
  profilesDir: string
  cookieFile: string
}

interface BrowserConfig {
  name: DetectedBrowser['name']
  displayName: string
  mac?: PlatformPaths
  win?: PlatformPaths
}

const BROWSER_CONFIGS: BrowserConfig[] = [
  {
    name: 'chrome',
    displayName: 'Google Chrome',
    mac: {
      appPath: '/Applications/Google Chrome.app',
      profilesDir: join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
      cookieFile: 'Cookies',
    },
    win: {
      appPath: join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      profilesDir: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
      cookieFile: 'Cookies',
    },
  },
  {
    name: 'edge',
    displayName: 'Microsoft Edge',
    mac: {
      appPath: '/Applications/Microsoft Edge.app',
      profilesDir: join(HOME, 'Library', 'Application Support', 'Microsoft Edge'),
      cookieFile: 'Cookies',
    },
    win: {
      appPath: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      profilesDir: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
      cookieFile: 'Cookies',
    },
  },
  {
    name: 'firefox',
    displayName: 'Mozilla Firefox',
    mac: {
      appPath: '/Applications/Firefox.app',
      profilesDir: join(HOME, 'Library', 'Application Support', 'Firefox', 'Profiles'),
      cookieFile: 'cookies.sqlite',
    },
    win: {
      appPath: join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
      profilesDir: join(HOME, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
      cookieFile: 'cookies.sqlite',
    },
  },
  {
    name: 'safari' as DetectedBrowser['name'],
    displayName: 'Safari',
    mac: {
      appPath: '/Applications/Safari.app',
      profilesDir: join(HOME, 'Library', 'Cookies'),
      cookieFile: 'Cookies.binarycookies',
    },
  },
]

function getVersionMac(appPath: string): string | undefined {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist')
    if (!existsSync(plistPath)) return undefined
    const output = execSync(
      `defaults read "${join(appPath, 'Contents', 'Info')}" CFBundleShortVersionString`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

function getVersionWin(exePath: string): string | undefined {
  try {
    if (!existsSync(exePath)) return undefined
    const ps = `(Get-Item '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    ).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

function getVersion(paths: PlatformPaths): string | undefined {
  if (IS_MAC) return getVersionMac(paths.appPath)
  if (IS_WIN) return getVersionWin(paths.appPath)
  return undefined
}

function isInstalled(paths: PlatformPaths): boolean {
  if (IS_WIN) {
    return existsSync(paths.appPath) || existsSync(paths.profilesDir)
  }
  return existsSync(paths.appPath)
}

function detectChromiumProfiles(profilesDir: string, cookieFile: string): BrowserProfile[] {
  if (!existsSync(profilesDir)) return []
  const profiles: BrowserProfile[] = []

  const defaultCookies = join(profilesDir, 'Default', cookieFile)
  if (existsSync(defaultCookies)) {
    profiles.push({
      name: 'Default',
      path: join(profilesDir, 'Default'),
      isDefault: true,
    })
  }

  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^Profile \d+$/.test(entry.name)) continue
      const cookiePath = join(profilesDir, entry.name, cookieFile)
      if (existsSync(cookiePath)) {
        profiles.push({
          name: entry.name,
          path: join(profilesDir, entry.name),
          isDefault: false,
        })
      }
    }
  } catch {
    // ignore read errors
  }

  return profiles
}

function detectFirefoxProfiles(profilesDir: string, cookieFile: string): BrowserProfile[] {
  if (!existsSync(profilesDir)) return []
  const profiles: BrowserProfile[] = []

  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const cookiePath = join(profilesDir, entry.name, cookieFile)
      if (existsSync(cookiePath)) {
        profiles.push({
          name: entry.name,
          path: join(profilesDir, entry.name),
          isDefault: entry.name.includes('default'),
        })
      }
    }
  } catch {
    // ignore read errors
  }

  return profiles
}

export function detectInstalledBrowsers(): DetectedBrowser[] {
  if (!IS_MAC && !IS_WIN) {
    log.warn('不支持的平台', { platform: process.platform })
    return []
  }

  const results: DetectedBrowser[] = []

  for (const config of BROWSER_CONFIGS) {
    const platformPaths = IS_MAC ? config.mac : config.win
    if (!platformPaths) continue

    const installed = isInstalled(platformPaths)
    const browser: DetectedBrowser = {
      name: config.name,
      displayName: config.displayName,
      installed,
      version: installed ? getVersion(platformPaths) : undefined,
      profiles: [],
    }

    if (installed) {
      if (config.name === 'safari') {
        const cookiePath = join(platformPaths.profilesDir, platformPaths.cookieFile)
        if (existsSync(cookiePath)) {
          browser.profiles = [{
            name: 'Default',
            path: platformPaths.profilesDir,
            isDefault: true,
          }]
        }
      } else if (config.name === 'firefox') {
        browser.profiles = detectFirefoxProfiles(platformPaths.profilesDir, platformPaths.cookieFile)
      } else {
        browser.profiles = detectChromiumProfiles(platformPaths.profilesDir, platformPaths.cookieFile)
      }
    }

    results.push(browser)
  }

  return results
}
