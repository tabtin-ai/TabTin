export interface StorageDirectoryEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

export interface StorageFileSystemPort {
  homeDirectory(): string
  readText(path: string): Promise<string>
  writePrivateText(path: string, contents: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  readDirectory(path: string): Promise<StorageDirectoryEntry[]>
  removeTree(path: string): Promise<void>
  isProcessRunning(pid: number): boolean
}
