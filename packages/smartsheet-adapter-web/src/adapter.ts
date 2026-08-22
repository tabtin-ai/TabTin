// Web Platform Adapter
export interface WebAdapter {
  // Storage operations
  saveToLocalStorage(key: string, data: any): void
  loadFromLocalStorage(key: string): any
  removeFromLocalStorage(key: string): void

  // File operations
  downloadFile(data: string, filename: string, type?: string): void
  uploadFile(): Promise<File | null>

  // Browser-specific
  openInNewTab(url: string): void
  copyToClipboard(text: string): Promise<void>
  getWindowSize(): { width: number; height: number }
}

export class WebPlatformAdapter implements WebAdapter {
  saveToLocalStorage(key: string, data: any): void {
    try {
      localStorage.setItem(key, JSON.stringify(data))
    } catch (error) {
      console.warn('Failed to save to localStorage:', error)
    }
  }

  loadFromLocalStorage(key: string): any {
    try {
      const item = localStorage.getItem(key)
      return item ? JSON.parse(item) : null
    } catch (error) {
      console.warn('Failed to load from localStorage:', error)
      return null
    }
  }

  removeFromLocalStorage(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch (error) {
      console.warn('Failed to remove from localStorage:', error)
    }
  }

  downloadFile(data: string, filename: string, type = 'text/plain'): void {
    const blob = new Blob([data], { type })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    URL.revokeObjectURL(url)
  }

  async uploadFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.style.display = 'none'

      input.onchange = (event) => {
        const file = (event.target as HTMLInputElement).files?.[0] || null
        document.body.removeChild(input)
        resolve(file)
      }

      input.oncancel = () => {
        document.body.removeChild(input)
        resolve(null)
      }

      document.body.appendChild(input)
      input.click()
    })
  }

  openInNewTab(url: string): void {
    window.open(url, '_blank')
  }

  async copyToClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
    } catch (error) {
      console.warn('Failed to copy to clipboard:', error)
      throw error
    }
  }

  getWindowSize(): { width: number; height: number } {
    return {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }
}
