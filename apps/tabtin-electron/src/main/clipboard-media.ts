import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { clipboard, nativeImage } from 'electron'

export function copyImageBufferToClipboard(bytes: ArrayBuffer | Uint8Array): void {
  const buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  if (buffer.length === 0) throw new Error('image data is empty')

  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('unsupported image data')
  clipboard.writeImage(image)
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => error ? reject(error) : resolve())
  })
}

export async function copyLocalFileToClipboard(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'darwin') {
    await run('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'set the clipboard to POSIX file (item 1 of argv)',
      '-e', 'end run',
      filePath,
    ])
    return
  }

  if (platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($args[0]); [System.Windows.Forms.Clipboard]::SetFileDropList($files)',
      filePath,
    ])
    return
  }

  clipboard.clear()
  clipboard.writeBuffer('text/uri-list', Buffer.from(`${pathToFileURL(filePath).href}\r\n`))
}
