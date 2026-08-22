/**
 * desktop-window-helpers — 平台特定窗口操作实现
 *
 * 提供 macOS / Windows 的窗口列表、应用检测、AppleScript 转义等辅助函数。
 * 不依赖 class 实例状态，仅依赖 child_process 和平台判断。
 */

import { execFileSync } from 'node:child_process'
import { createLogger } from '../logger'

const log = createLogger('DesktopWindow')

export interface WindowInfo {
  id: string
  app: string
  title: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  focused: boolean
}

export function listWindowsMac(): WindowInfo[] {
  const script = `
    const se = Application("System Events");
    const procs = se.applicationProcesses.whose({visible: true})();
    const result = [];
    let idx = 0;
    for (const proc of procs) {
      try {
        const appName = proc.name();
        const isFront = proc.frontmost();
        const wins = proc.windows();
        let isFrontFirstWindow = true;
        for (const win of wins) {
          try {
            const pos = win.position();
            const sz = win.size();
            result.push({
              id: String(idx++),
              app: appName,
              title: win.name(),
              position: { x: pos[0], y: pos[1] },
              size: { width: sz[0], height: sz[1] },
              focused: isFront && isFrontFirstWindow,
            });
            isFrontFirstWindow = false;
          } catch(e) { idx++; }
        }
        if (wins.length === 0) {
          result.push({ id: String(idx++), app: appName, title: '', focused: isFront });
        }
      } catch(e) {}
    }
    JSON.stringify(result);
  `.trim()

  try {
    const raw = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
    return JSON.parse(raw)
  } catch (err) {
    log.error('listWindows failed:', err)
    return []
  }
}

export function listWindowsWin(): WindowInfo[] {
  const psScript = `
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WinApi{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hWnd,out RECT lpRect);[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}}';
    $fg = [WinApi]::GetForegroundWindow();
    Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
      $h = $_.MainWindowHandle;
      $o = [ordered]@{ id = [string]$_.Id; app = $_.ProcessName; title = $_.MainWindowTitle; focused = ($h -eq $fg) };
      if ($h -ne [IntPtr]::Zero) {
        $r = New-Object -TypeName 'WinApi+RECT';
        if ([WinApi]::GetWindowRect($h, [ref]$r)) {
          $o['position'] = @{ x = $r.Left; y = $r.Top };
          $o['size'] = @{ width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) };
        }
      }
      [PSCustomObject]$o
    } | ConvertTo-Json -Compress
  `.trim()

  try {
    const raw = execFileSync(
      'powershell', ['-NoProfile', '-Command', psScript],
      { timeout: 5000, encoding: 'utf-8', windowsHide: true },
    ).trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (err) {
    log.error('listWindows failed:', err)
    return []
  }
}

let _python3Available: boolean | null = null

function isPython3Available(): boolean {
  if (_python3Available !== null) return _python3Available
  try {
    execFileSync('python3', ['--version'], { timeout: 2000, encoding: 'utf-8' })
    _python3Available = true
  } catch {
    log.warn('python3 not available on this system — getAppAtPoint (macOS Quartz) disabled')
    _python3Available = false
  }
  return _python3Available
}

/**
 * Query which application owns the topmost window at the given screen coordinate.
 * macOS: CGWindowListCopyWindowInfo (Z-order, no extra permissions).
 * Windows: WindowFromPoint + GetWindowThreadProcessId.
 * Returns null if detection fails (best-effort).
 */
export function getAppAtPoint(screenX: number, screenY: number): string | null {
  try {
    if (process.platform === 'darwin') {
      if (!isPython3Available()) return null
      const pyScript = [
        'import Quartz,json,sys',
        `x,y=${Math.round(screenX)},${Math.round(screenY)}`,
        'opts=Quartz.kCGWindowListOptionOnScreenOnly|Quartz.kCGWindowListExcludeDesktopElements',
        'ws=Quartz.CGWindowListCopyWindowInfo(opts,Quartz.kCGNullWindowID)',
        'r=[w for w in ws if w.get("kCGWindowLayer",-1)==0]',
        'hit=next((w for w in r if x>=w["kCGWindowBounds"]["X"] and x<w["kCGWindowBounds"]["X"]+w["kCGWindowBounds"]["Width"] and y>=w["kCGWindowBounds"]["Y"] and y<w["kCGWindowBounds"]["Y"]+w["kCGWindowBounds"]["Height"]),None)',
        'print(json.dumps({"app":str(hit["kCGWindowOwnerName"]) if hit else None}))',
      ].join(';')
      const raw = execFileSync('python3', ['-c', pyScript], { timeout: 2000, encoding: 'utf-8' }).trim()
      const parsed = JSON.parse(raw)
      return parsed.app ?? null
    }
    if (process.platform === 'win32') {
      const ps = `
        Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Pt{[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(long pt);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);}';
        $packed = [long]${Math.round(screenY)} -shl 32 -bor ([long]${Math.round(screenX)} -band 0xFFFFFFFF);
        $hwnd = [Pt]::WindowFromPoint($packed);
        $pid = [uint32]0;
        [void][Pt]::GetWindowThreadProcessId($hwnd, [ref]$pid);
        if ($pid -gt 0) { (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } else { '' }
      `.trim()
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 2000, encoding: 'utf-8', windowsHide: true }).trim()
      return raw || null
    }
  } catch (err) {
    log.warn('getAppAtPoint failed:', err)
  }
  return null
}

export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
