import {
  setImportAdapter,
  convertBackendToPresentation,
  type ImportAdapter,
  type ImportResult,
} from '@tabtin/tabslide/exports'
import { apiService } from '@/services/api'
import { unwrapEnvelope } from './autosave-utils'
import {
  sanitizeEmbeddedFonts,
  sanitizeThemeFonts,
  normalizeFontEmbeddingMeta,
  injectEmbeddedFonts,
  injectThemeFonts,
  applyRuntimeFontFamilies,
  buildThemeFontsFromPresentationTheme,
  type FontEmbeddingMeta,
} from './slide-font-utils'

const backendImportAdapter: ImportAdapter = {
  async importFromFile(file: File): Promise<ImportResult> {
    try {
      // IPC 代理只支持 JSON 字符串传输，无法传 FormData，故用 base64 编码
      // Django DATA_UPLOAD_MAX_MEMORY_SIZE 已提升到 100MB，足以容纳 base64 膨胀
      const arrayBuffer = await file.arrayBuffer()
      const fileBase64 = typeof Buffer !== 'undefined'
        ? Buffer.from(arrayBuffer).toString('base64')
        : uint8ArrayToBase64(new Uint8Array(arrayBuffer))

      const envelope = await apiService.request<Record<string, unknown>>({
        method: 'POST',
        url: '/tabslide/parse-pptx/',
        data: {
          file_base64: fileBase64,
          file_name: file.name,
        },
      })

      const res = unwrapEnvelope(envelope)

      const embeddedFonts = sanitizeEmbeddedFonts(res.embedded_fonts)
      injectEmbeddedFonts(embeddedFonts)

      const themeFonts = sanitizeThemeFonts(res.theme_fonts)
      injectThemeFonts(themeFonts)

      const presentation = convertBackendToPresentation({
        id: '',
        name: (res.name as string) || file.name.replace(/\.pptx$/i, ''),
        preset: res.preset as string,
        //  canvas 统一：兜底 1280×720（与 html-spec / PPTX EMU 1:1）
        canvas_width: (res.canvas_width as number) || 1280,
        canvas_height: (res.canvas_height as number) || 720,
        page_count: res.page_count as number,
        theme: res.theme as Record<string, unknown>,
        pages: res.pages as any,
      })

      if (Object.keys(themeFonts).length === 0) {
        injectThemeFonts(buildThemeFontsFromPresentationTheme(presentation))
      }

      applyRuntimeFontFamilies({
        embeddedFonts,
        themeFonts: Object.keys(themeFonts).length > 0
          ? themeFonts
          : buildThemeFontsFromPresentationTheme(presentation),
        presentation,
      })

      let totalElements = 0
      for (const page of presentation.pages) {
        totalElements += page.elements.length
      }

      const fontMeta = normalizeFontEmbeddingMeta({ embeddedFonts, themeFonts })
      return {
        success: true,
        presentation,
        stats: {
          totalSlides: presentation.pages.length,
          totalElements,
          unsupportedElements: 0,
          mediaFiles: embeddedFonts.length,
        },
        fontMeta,
      } as ImportResult & { fontMeta: FontEmbeddingMeta }
    } catch (err) {
      console.error('[SlideEditorHost] Backend PPTX import failed:', err)
      return {
        success: false,
        error: (err as Error).message || 'unknown error',
      }
    }
  },
}

/** @internal Exported for testing only */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

let isBackendImportAdapterRegistered = false

export function ensureBackendImportAdapterRegistered() {
  if (isBackendImportAdapterRegistered) return
  setImportAdapter(backendImportAdapter)
  isBackendImportAdapterRegistered = true
}
