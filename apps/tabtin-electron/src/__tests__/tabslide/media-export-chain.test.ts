import { describe, expect, it } from 'vitest'
import JSZip from '../../../../../packages/tabslide/node_modules/jszip'
import { exportToPPTXBlob } from '../../../../../packages/tabslide/src/exports/pptx'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const MEDIA_META_PREFIX = 'TABSLIDE_MEDIA_V1:'

function decodeMediaMeta(raw: string): Record<string, unknown> {
  const base64 = raw.slice(MEDIA_META_PREFIX.length)
  const json = Buffer.from(base64, 'base64').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

describe('TabSlide Media Export Chain', () => {
  it('带参数的媒体 data URL（video/audio/poster）应可正常嵌入导出', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-media-export-1',
      name: 'media-export',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'slide-1',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [
            {
              id: 'video-1',
              type: 'video',
              x: 120,
              y: 100,
              width: 640,
              height: 360,
              rotate: 0,
              opacity: 1,
              locked: false,
              src: 'data:video/mp4;codecs=avc1;base64,AAAA',
              poster: `data:image/png;charset=utf-8;base64,${TINY_PNG_BASE64}`,
              autoplay: true,
            },
            {
              id: 'audio-1',
              type: 'audio',
              x: 140,
              y: 520,
              width: 180,
              height: 52,
              rotate: 0,
              opacity: 1,
              locked: false,
              src: 'data:audio/mpeg;charset=utf-8;base64,SUQzAA==',
              color: '#123456',
              fixedRatio: true,
              loop: true,
              autoplay: true,
            },
          ],
        },
      ],
    }

    const blob = await exportToPPTXBlob(presentation)
    const zip = await JSZip.loadAsync(blob)

    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    expect(slideXml).toBeTruthy()
    expect(slideXml).toContain('<a:videoFile')

    const doc = new DOMParser().parseFromString(slideXml || '', 'application/xml')
    const pics = Array.from(doc.getElementsByTagNameNS(NS_P, 'pic'))
    const mediaMetas = pics
      .filter((pic) => pic.getElementsByTagNameNS(NS_A, 'videoFile').length > 0)
      .map((pic) => pic.getElementsByTagNameNS(NS_P, 'cNvPr')[0]?.getAttribute('descr') || '')
      .filter((descr) => descr.startsWith(MEDIA_META_PREFIX))
      .map((descr) => decodeMediaMeta(descr))

    expect(mediaMetas.length).toBeGreaterThanOrEqual(2)
    expect(
      mediaMetas.some((meta) => meta.type === 'video' && meta.autoplay === true),
    ).toBe(true)
    expect(
      mediaMetas.some((meta) =>
        meta.type === 'audio'
        && meta.autoplay === true
        && meta.loop === true
        && meta.fixedRatio === true
        && meta.color === '#123456'),
    ).toBe(true)

    const relsXml = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string')
    expect(relsXml).toBeTruthy()
    expect(relsXml).toContain('/relationships/video')
    expect(relsXml).toContain('/relationships/audio')

    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/'))
    expect(mediaFiles.some((name) => name.endsWith('.mp4'))).toBe(true)
    expect(mediaFiles.some((name) => name.endsWith('.mp3'))).toBe(true)
    expect(mediaFiles.some((name) => name.endsWith('.png'))).toBe(true)
  })
})
