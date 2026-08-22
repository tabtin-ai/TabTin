/**
 * 路径前缀 → OSErrorCategory 推断
 *
 * 仅依据路径字面量做判断，不 stat 文件系统。意图是「这条路径属于哪个 macOS TCC
 * 类目 / Windows OneDrive 类目」，结合错误码给 Agent 不同的引导文案。
 *
 * 跨平台准则：
 *   - macOS：~/Library/Mobile Documents/com~apple~CloudDocs → CloudStorage；
 *            /Volumes/<非系统卷> → RemovableVolume；
 *            ~/Documents、~/Desktop、~/Downloads 各自映射；
 *            其他 ~/Library/* 视为 FullDisk（需完全的磁盘访问权限）。
 *   - Windows：%USERPROFILE%\OneDrive\ → CloudStorage；
 *              \\server\share\ 或 X:\ 上 X 是网络盘 → NetworkVolume；
 *              其他映射粗粒度，因 Win32 桌面应用默认无 TCC 拦截。
 *   - Linux：~/Documents 等映射，但 Linux 默认无运行时 TCC，多归 Other。
 */

import os from 'node:os';
import path from 'node:path';
import type { OSErrorCategory } from './types.js';

const home = (): string => {
  try {
    return os.homedir();
  } catch {
    return '';
  }
};

/** 把传入路径展开成绝对、规范化路径（不解析 symlink，避免 stat） */
function normalize(p: string): string {
  if (!p) return '';
  let abs = p;
  if (abs.startsWith('~')) abs = path.join(home(), abs.slice(1));
  return path.normalize(abs);
}

function startsWithDir(target: string, prefix: string): boolean {
  if (!prefix) return false;
  const sep = path.sep;
  const a = target.endsWith(sep) ? target : target + sep;
  const b = prefix.endsWith(sep) ? prefix : prefix + sep;
  return a.startsWith(b);
}

/** macOS：根据路径推断 TCC 类目 */
function classifyDarwinPath(abs: string): OSErrorCategory {
  const h = home();
  const cloud = path.join(h, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const cloudPrefix = path.join(h, 'Library', 'Mobile Documents');
  if (startsWithDir(abs, cloud) || startsWithDir(abs, cloudPrefix)) return 'CloudStorage';

  if (startsWithDir(abs, '/Volumes')) {
    // /Volumes/Macintosh HD 是系统主卷，其余视为可移除卷
    if (abs === '/Volumes' || abs.startsWith('/Volumes/Macintosh HD')) return 'FullDisk';
    return 'RemovableVolume';
  }

  if (startsWithDir(abs, path.join(h, 'Documents'))) return 'Documents';
  if (startsWithDir(abs, path.join(h, 'Desktop'))) return 'Desktop';
  if (startsWithDir(abs, path.join(h, 'Downloads'))) return 'Downloads';

  // ~/Library/* 一般需要 Full Disk Access 才能访问
  if (startsWithDir(abs, path.join(h, 'Library'))) return 'FullDisk';

  // 网络挂载点常见前缀
  if (startsWithDir(abs, '/Network') || startsWithDir(abs, '/net')) return 'NetworkVolume';

  // 系统目录通常需要完全的磁盘访问权限
  if (
    startsWithDir(abs, '/private') ||
    startsWithDir(abs, '/var/db') ||
    startsWithDir(abs, '/Library/Application Support')
  ) {
    return 'FullDisk';
  }

  return 'Other';
}

/** Windows：根据路径推断类目（不依赖宿主 home，避免在 macOS 单测里失效） */
function classifyWin32Path(abs: string): OSErrorCategory {
  // OneDrive：路径中含 \OneDrive\ 或 \OneDrive - <Org>\ 段
  if (/[\\/]onedrive(\s-\s[^\\/]+)?[\\/]/i.test(abs)) return 'CloudStorage';

  // UNC 路径 \\server\share
  if (abs.startsWith('\\\\')) return 'NetworkVolume';

  // 用户目录映射 —— 按路径段名匹配，与跑测试的宿主无关
  if (/[\\/]users[\\/][^\\/]+[\\/]documents([\\/]|$)/i.test(abs)) return 'Documents';
  if (/[\\/]users[\\/][^\\/]+[\\/]desktop([\\/]|$)/i.test(abs)) return 'Desktop';
  if (/[\\/]users[\\/][^\\/]+[\\/]downloads([\\/]|$)/i.test(abs)) return 'Downloads';

  return 'Other';
}

/** Linux：粗粒度，多数 Other */
function classifyLinuxPath(abs: string): OSErrorCategory {
  const h = home();
  if (h) {
    if (abs.startsWith(path.join(h, 'Documents'))) return 'Documents';
    if (abs.startsWith(path.join(h, 'Desktop'))) return 'Desktop';
    if (abs.startsWith(path.join(h, 'Downloads'))) return 'Downloads';
  }
  if (abs.startsWith('/media') || abs.startsWith('/run/media') || abs.startsWith('/mnt')) {
    return 'RemovableVolume';
  }
  return 'Other';
}

/**
 * 主入口：根据 process.platform 派发到对应的分类器。
 * 永远返回一个 OSErrorCategory（默认 Other），不抛错。
 */
export function inferCategoryFromPath(rawPath: string, platform: NodeJS.Platform = process.platform): OSErrorCategory {
  if (!rawPath) return 'Other';
  const abs = normalize(rawPath);
  switch (platform) {
    case 'darwin':
      return classifyDarwinPath(abs);
    case 'win32':
      return classifyWin32Path(abs);
    default:
      return classifyLinuxPath(abs);
  }
}
