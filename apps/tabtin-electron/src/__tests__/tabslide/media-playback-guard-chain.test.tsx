import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import ElementRenderer from '../../../../../packages/tabslide/src/components/elements/ElementRenderer'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import type { PPTAudioElement, PPTVideoElement } from '../../../../../packages/tabslide/src/types/slides'

const makeVideo = (): PPTVideoElement => ({
  id: 'video-guard-1',
  type: 'video',
  x: 120,
  y: 100,
  width: 640,
  height: 360,
  rotate: 0,
  opacity: 1,
  locked: false,
  src: 'data:video/mp4;base64,AAAA',
  poster: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  autoplay: true,
  ext: 'mp4',
})

const makeAudio = (): PPTAudioElement => ({
  id: 'audio-guard-1',
  type: 'audio',
  x: 140,
  y: 520,
  width: 180,
  height: 52,
  rotate: 0,
  opacity: 1,
  locked: false,
  src: 'data:audio/mpeg;base64,SUQzAA==',
  color: '#123456',
  fixedRatio: true,
  loop: true,
  autoplay: true,
  ext: 'mp3',
})

describe('TabSlide Media Playback Guard Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('视频自动播放失败后应静音重试并提示“已静音自动播放”', async () => {
    const video = makeVideo()
    const { container } = render(
      <ElementRenderer
        element={video}
        editingElementId={null}
      />,
    )

    const videoEl = container.querySelector('video') as HTMLVideoElement | null
    expect(videoEl).not.toBeNull()
    if (!videoEl) return

    const playMock = vi.fn()
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockResolvedValue(undefined)
    Object.defineProperty(videoEl, 'play', {
      configurable: true,
      writable: true,
      value: playMock,
    })

    fireEvent.canPlay(videoEl)

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(2)
      expect(videoEl.muted).toBe(true)
    })

    expect(container.textContent || '').toContain('已静音自动播放')
  })

  it('音频自动播放失败时应给出“点击播放”重试入口', async () => {
    const audio = makeAudio()
    const { container, getByText } = render(
      <ElementRenderer
        element={audio}
        editingElementId={null}
      />,
    )

    const audioEl = container.querySelector('audio') as HTMLAudioElement | null
    expect(audioEl).not.toBeNull()
    if (!audioEl) return

    const playMock = vi.fn()
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockResolvedValue(undefined)
    Object.defineProperty(audioEl, 'play', {
      configurable: true,
      writable: true,
      value: playMock,
    })

    fireEvent.canPlay(audioEl)

    await waitFor(() => {
      expect(container.textContent || '').toContain('自动播放受限')
    })

    fireEvent.click(getByText('点击播放'))

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(2)
      expect(container.textContent || '').not.toContain('自动播放受限')
    })
  })
})

