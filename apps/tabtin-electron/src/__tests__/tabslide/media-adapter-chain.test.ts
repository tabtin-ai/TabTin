import { describe, expect, it } from 'vitest'
import {
  convertBackendPage,
  convertPagesToBackend,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import type {
  Slide,
  PPTVideoElement,
  PPTAudioElement,
} from '../../../../../packages/tabslide/src/types/slides'

describe('TabSlide Media Adapter Chain', () => {
  it('convertBackendPage 应正确还原 video/audio 元素语义', () => {
    const page = convertBackendPage({
      id: 'backend-page-media',
      elements: [
        {
          id: 'video-1',
          type: 'video',
          x: 120,
          y: 80,
          width: 640,
          height: 360,
          rotate: 15,
          zIndex: 0,
          props: {
            src: 'https://cdn.example.com/video.mp4',
            poster: 'https://cdn.example.com/poster.png',
            autoplay: true,
            ext: 'mp4',
          },
        },
        {
          id: 'audio-1',
          type: 'audio',
          x: 80,
          y: 500,
          width: 180,
          height: 48,
          rotate: 0,
          zIndex: 1,
          props: {
            src: 'https://cdn.example.com/audio.mp3',
            color: '#123456',
            fixedRatio: true,
            loop: true,
            autoplay: false,
            ext: 'mp3',
          },
        },
      ],
      background: { type: 'color', value: '#ffffff' },
      notes: '',
    })

    expect(page.elements).toHaveLength(2)
    const video = page.elements[0] as PPTVideoElement
    const audio = page.elements[1] as PPTAudioElement

    expect(video.type).toBe('video')
    expect(video.src).toBe('https://cdn.example.com/video.mp4')
    expect(video.poster).toBe('https://cdn.example.com/poster.png')
    expect(video.autoplay).toBe(true)
    expect(video.ext).toBe('mp4')

    expect(audio.type).toBe('audio')
    expect(audio.src).toBe('https://cdn.example.com/audio.mp3')
    expect(audio.color).toBe('#123456')
    expect(audio.fixedRatio).toBe(true)
    expect(audio.loop).toBe(true)
    expect(audio.autoplay).toBe(false)
    expect(audio.ext).toBe('mp3')
  })

  it('convertPagesToBackend 应完整透传 video/audio props', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [
        {
          id: 'video-a',
          type: 'video',
          x: 100,
          y: 120,
          width: 640,
          height: 360,
          rotate: 8,
          opacity: 0.9,
          locked: false,
          src: 'data:video/mp4;base64,AAAA',
          poster: 'data:image/png;base64,BBBB',
          autoplay: true,
          ext: 'mp4',
        },
        {
          id: 'audio-a',
          type: 'audio',
          x: 180,
          y: 540,
          width: 160,
          height: 48,
          rotate: 0,
          opacity: 1,
          locked: false,
          src: 'data:audio/mpeg;base64,CCCC',
          color: '#654321',
          fixedRatio: true,
          loop: true,
          autoplay: true,
          ext: 'mp3',
        },
      ],
      background: { type: 'solid', color: '#ffffff' },
      remark: '',
    }

    const backendPages = convertPagesToBackend([page])
    expect(backendPages).toHaveLength(1)
    const elements = backendPages[0]?.elements || []
    expect(elements).toHaveLength(2)

    const beVideo = elements[0]
    const beAudio = elements[1]
    expect(beVideo?.type).toBe('video')
    expect(beVideo?.props?.src).toBe('data:video/mp4;base64,AAAA')
    expect(beVideo?.props?.poster).toBe('data:image/png;base64,BBBB')
    expect(beVideo?.props?.autoplay).toBe(true)
    expect(beVideo?.props?.ext).toBe('mp4')

    expect(beAudio?.type).toBe('audio')
    expect(beAudio?.props?.src).toBe('data:audio/mpeg;base64,CCCC')
    expect(beAudio?.props?.color).toBe('#654321')
    expect(beAudio?.props?.fixedRatio).toBe(true)
    expect(beAudio?.props?.loop).toBe(true)
    expect(beAudio?.props?.autoplay).toBe(true)
    expect(beAudio?.props?.ext).toBe('mp3')
  })
})

