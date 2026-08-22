/**
 * 本地文件预览 / 产物卡片的格式副标题 i18n。
 * registry 与 RichFile 共用同一套 key（chat:card.openFile.format.*）。
 */

export const LOCAL_FILE_FORMAT_LABEL_FALLBACKS = {
  xlsx: 'Spreadsheet · XLSX',
  csv: 'Data · CSV',
  doc: 'Document · DOC',
  docx: 'Document · DOCX',
  pdf: 'Document · PDF',
  json: 'Data · JSON',
  txt: 'Document · TXT',
  pptx: 'Presentation · PPTX',
  markdown: 'Document · Markdown',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  file: 'File',
} as const

export type LocalFileFormatLabelKey = keyof typeof LOCAL_FILE_FORMAT_LABEL_FALLBACKS

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string

export function isLocalFileFormatLabelKey(value: string): value is LocalFileFormatLabelKey {
  return value in LOCAL_FILE_FORMAT_LABEL_FALLBACKS
}

export function translateLocalFileFormatLabel(
  fileType: string | null | undefined,
  t: TranslateFn,
  fallback?: string,
): string {
  const key: LocalFileFormatLabelKey =
    fileType && isLocalFileFormatLabelKey(fileType) ? fileType : 'file'
  return t(`card.openFile.format.${key}`, {
    defaultValue: fallback ?? LOCAL_FILE_FORMAT_LABEL_FALLBACKS[key],
  })
}
