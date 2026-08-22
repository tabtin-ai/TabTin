// Electron Platform Adapter
export interface ElectronAdapter {
  // Window management
  createWindow(options?: WindowOptions): Promise<void>
  closeWindow(): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>

  // File operations
  showSaveDialog(options?: SaveDialogOptions): Promise<string | undefined>
  showOpenDialog(options?: OpenDialogOptions): Promise<string[] | undefined>

  // System integration
  setAppUserModelId(id: string): void
  quit(): void

  // Menu operations
  setApplicationMenu(template?: MenuTemplate): void
}

export interface WindowOptions {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  frame?: boolean
  titleBarStyle?: 'default' | 'hidden' | 'hiddenInset'
}

export interface SaveDialogOptions {
  defaultPath?: string
  filters?: FileFilter[]
}

export interface OpenDialogOptions {
  filters?: FileFilter[]
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface MenuTemplate {
  label: string
  submenu?: MenuTemplate[]
  click?: () => void
  accelerator?: string
}
