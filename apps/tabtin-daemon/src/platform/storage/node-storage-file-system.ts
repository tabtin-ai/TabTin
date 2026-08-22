import os from 'node:os'
import { promises as fs } from 'node:fs'
import { rm } from 'node:fs/promises'

import type {
  StorageDirectoryEntry,
  StorageFileSystemPort,
} from '../../base/storage/storage-file-system.js'

export class NodeStorageFileSystem implements StorageFileSystemPort {
  homeDirectory(): string {
    return os.homedir()
  }

  readText(path: string): Promise<string> {
    return fs.readFile(path, 'utf-8')
  }

  async writePrivateText(path: string, contents: string): Promise<void> {
    await fs.writeFile(path, contents, { mode: 0o600 })
  }

  rename(from: string, to: string): Promise<void> {
    return fs.rename(from, to)
  }

  async readDirectory(path: string): Promise<StorageDirectoryEntry[]> {
    return fs.readdir(path, { withFileTypes: true })
  }

  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
