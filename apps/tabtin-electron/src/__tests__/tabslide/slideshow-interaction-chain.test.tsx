import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import SlideShow from '../../../../../packages/tabslide/src/components/SlideShow'
import type {
  SlidePresentation,
  PPTTextElement,
  PPTVideoElement,
  PPTLineElement,
  PPTAnimation,
} from '../../../../../packages/tabslide/src/types/slides'

function makeTextElement(id: string, content: string, x: number, y: number): PPTTextElement {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 360,
    height: 80,
    rotate: 0,
    opacity: 1,
    locked: false,
    content: `<p>${content}</p>`,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  }
}

function makeVideoElement(id: string): PPTVideoElement {
  return {
    id,
    type: 'video',
    x: 100,
    y: 180,
    width: 420,
    height: 236,
    rotate: 0,
    opacity: 1,
    locked: false,
    src: 'data:video/mp4;base64,AAAA',
    autoplay: false,
    ext: 'mp4',
  }
}

function makeLineElement(id: string): PPTLineElement {
  return {
    id,
    type: 'line',
    x: 120,
    y: 260,
    width: 320,
    height: 120,
    opacity: 1,
    locked: false,
    start: [0, 0],
    end: [320, 10],
    style: 'solid',
    color: '#222222',
    lineWidth: 2,
    points: ['', ''],
  }
}

function makePresentation(params?: {
  page1Animations?: PPTAnimation[]
  withVideo?: boolean
}): SlidePresentation {
  const withVideo = params?.withVideo ?? false
  const page1Animations = params?.page1Animations ?? []

  return {
    id: 'slideshow-interaction-test',
    name: 'SlideShow Interaction Test',
    preset: '16:9',
    canvasWidth: 1280,
    canvasHeight: 720,
    pages: [
      {
        id: 'page-1',
        elements: [
          makeTextElement('text-page-1', '第一页', 120, 80),
          ...(withVideo ? [makeVideoElement('video-page-1')] : []),
          makeTextElement('text-animated', '动画元素', 120, 460),
        ],
        animations: page1Animations,
      },
      {
        id: 'page-2',
        elements: [makeTextElement('text-page-2', '第二页', 120, 80)],
        animations: [],
      },
    ],
  }
}

describe('TabSlide SlideShow Interaction Chain', () => {
  it('元素 web 超链接点击应打开新窗口且不触发 nextStep 翻页', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-element-web-link-test',
      name: 'SlideShow Element Web Link Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [
            {
              ...makeTextElement('text-link', '第一页带链接', 120, 80),
              link: {
                type: 'web',
                target: 'example.com/path',
              },
            },
          ],
          animations: [],
        },
        {
          id: 'page-2',
          elements: [makeTextElement('text-page-2', '第二页', 120, 80)],
          animations: [],
        },
      ],
    }

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      const { container } = render(
        <SlideShow
          presentation={presentation}
          fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
        />,
      )

      await waitFor(() => {
        expect(screen.queryByText('第一页带链接')).not.toBeNull()
      })

      const linkElement = container.querySelector(
        '[data-slideshow-element-id="text-link"]',
      ) as HTMLDivElement | null
      expect(linkElement).not.toBeNull()
      if (!linkElement) return

      fireEvent.click(linkElement)

      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer',
      )
      expect(screen.queryByText('第一页带链接')).not.toBeNull()
      expect(screen.queryByText('第二页')).toBeNull()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('元素 slide 超链接点击应跳转到目标页', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-element-slide-link-test',
      name: 'SlideShow Element Slide Link Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [
            {
              ...makeTextElement('text-link', '点击跳转第二页', 120, 80),
              link: {
                type: 'slide',
                target: 'page-2',
              },
            },
          ],
          animations: [],
        },
        {
          id: 'page-2',
          elements: [makeTextElement('text-page-2', '第二页目标', 120, 80)],
          animations: [],
        },
      ],
    }

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('点击跳转第二页')).not.toBeNull()
    })

    const linkElement = container.querySelector(
      '[data-slideshow-element-id="text-link"]',
    ) as HTMLDivElement | null
    expect(linkElement).not.toBeNull()
    if (!linkElement) return

    fireEvent.click(linkElement)

    await waitFor(() => {
      expect(screen.queryByText('第二页目标')).not.toBeNull()
    })
    expect(screen.queryByText('点击跳转第二页')).toBeNull()
  })

  it('富文本 a 链接点击不应触发 nextStep 翻页', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-rich-text-link-test',
      name: 'SlideShow Rich Text Link Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [
            {
              ...makeTextElement('text-link', '富文本链接', 120, 80),
              content: '<p><a href="https://example.org/docs">点击文本链接</a></p>',
            },
          ],
          animations: [],
        },
        {
          id: 'page-2',
          elements: [makeTextElement('text-page-2', '第二页', 120, 80)],
          animations: [],
        },
      ],
    }

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      render(
        <SlideShow
          presentation={presentation}
          fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
        />,
      )

      await waitFor(() => {
        expect(screen.queryByText('点击文本链接')).not.toBeNull()
      })

      fireEvent.click(screen.getByText('点击文本链接'))

      expect(openSpy).toHaveBeenCalledWith(
        'https://example.org/docs',
        '_blank',
        'noopener,noreferrer',
      )
      expect(screen.queryByText('第二页')).toBeNull()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('点击视频控件不应触发 nextStep 翻页', async () => {
    const presentation = makePresentation({ withVideo: true })

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('第一页')).not.toBeNull()
    })

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    if (!video) return

    fireEvent.click(video)

    expect(screen.queryByText('第一页')).not.toBeNull()
    expect(screen.queryByText('第二页')).toBeNull()
  })

  it('入场动画触发后应正常渲染，不应出现 Hook 顺序错误', async () => {
    const presentation = makePresentation({
      page1Animations: [
        {
          id: 'anim-in-1',
          elId: 'text-animated',
          type: 'in',
          effect: 'fadeIn',
          duration: 200,
          trigger: 'click',
        },
      ],
      withVideo: false,
    })

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      render(
        <SlideShow
          presentation={presentation}
          fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
        />,
      )

      await waitFor(() => {
        expect(screen.queryByText('第一页')).not.toBeNull()
      })

      expect(screen.queryByText('动画元素')).toBeNull()

      fireEvent.click(document.body)

      await waitFor(() => {
        expect(screen.queryByText('动画元素')).not.toBeNull()
      })

      const hasHookOrderError = consoleErrorSpy.mock.calls.some((call) => {
        const firstArg = typeof call[0] === 'string' ? call[0] : ''
        return (
          firstArg.includes('Rendered more hooks than during the previous render') ||
          firstArg.includes('change in the order of Hooks')
        )
      })
      expect(hasHookOrderError).toBe(false)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('元素静态层应保留自身 opacity/rotate，动画应在独立层执行', async () => {
    const animatedElement = {
      ...makeTextElement('text-animated', '动画元素', 120, 460),
      rotate: 24,
      opacity: 0.35,
    }

    const presentation: SlidePresentation = {
      id: 'slideshow-animation-layer-test',
      name: 'SlideShow Animation Layer Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [makeTextElement('text-page-1', '第一页', 120, 80), animatedElement],
          animations: [
            {
              id: 'anim-in-zoom',
              elId: 'text-animated',
              type: 'in',
              effect: 'zoomIn',
              duration: 200,
              trigger: 'click',
            },
          ],
        },
      ],
    }

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('第一页')).not.toBeNull()
    })

    fireEvent.click(document.body)

    await waitFor(() => {
      expect(screen.queryByText('动画元素')).not.toBeNull()
    })

    const staticLayer = container.querySelector(
      '[data-slideshow-element-id="text-animated"][data-slideshow-element-layer="static"]',
    ) as HTMLDivElement | null
    expect(staticLayer).not.toBeNull()
    if (!staticLayer) return

    expect(staticLayer.style.opacity).toBe('0.35')
    expect(staticLayer.style.transform).toContain('rotate(24deg)')
    expect(staticLayer.style.animationName).toBe('')

    const animationLayer = staticLayer.querySelector(
      '[data-slideshow-element-layer="animation-primary"]',
    ) as HTMLDivElement | null
    expect(animationLayer).not.toBeNull()
    expect(animationLayer?.style.animationName.toLowerCase()).toBe('tabslide-zoommovein')
  })

  it('同元素 in + attention 并发时应在主动画层与强调层分别执行', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-dual-layer-animation-test',
      name: 'SlideShow Dual Layer Animation Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [makeTextElement('text-1', '并发动画元素', 120, 80)],
          animations: [
            {
              id: 'anim-in',
              elId: 'text-1',
              type: 'in',
              effect: 'zoomIn',
              duration: 300,
              trigger: 'click',
            },
            {
              id: 'anim-attention',
              elId: 'text-1',
              type: 'attention',
              effect: 'pulse',
              duration: 300,
              trigger: 'meantime',
            },
          ],
        },
      ],
    }

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('并发动画元素')).toBeNull()
    })

    fireEvent.click(document.body)

    await waitFor(() => {
      expect(screen.queryByText('并发动画元素')).not.toBeNull()
    })

    const primaryLayer = container.querySelector(
      '[data-slideshow-element-id="text-1"] [data-slideshow-element-layer="animation-primary"]',
    ) as HTMLDivElement | null
    expect(primaryLayer).not.toBeNull()
    if (!primaryLayer) return

    const attentionLayer = primaryLayer.querySelector(
      '[data-slideshow-element-layer="animation-attention"]',
    ) as HTMLDivElement | null
    expect(attentionLayer).not.toBeNull()

    expect(primaryLayer.style.animationName.toLowerCase()).toBe('tabslide-zoommovein')
    expect(attentionLayer?.style.animationName.toLowerCase()).toBe('tabslide-attentionpulse')
  })

  it('翻页过渡不应覆盖页面缩放层（缩放与过渡应分层）', async () => {
    const presentation = makePresentation()
    presentation.pages[1]!.turningMode = 'scale'

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('第一页')).not.toBeNull()
    })

    fireEvent.click(document.body)

    await waitFor(() => {
      expect(screen.queryByText('第二页')).not.toBeNull()
    })

    const scaleLayer = container.querySelector(
      '[data-slideshow-page-layer="scale"]',
    ) as HTMLDivElement | null
    expect(scaleLayer).not.toBeNull()
    expect(scaleLayer?.style.transform).toContain('scale(')

    const transitionLayers = Array.from(
      container.querySelectorAll('[data-slideshow-page-layer="transition"]'),
    ) as HTMLDivElement[]
    expect(transitionLayers.length).toBeGreaterThan(0)
    const hasAnimatedTransitionLayer = transitionLayers.some((layer) =>
      layer.style.animation.includes('tabslide-'),
    )
    expect(hasAnimatedTransitionLayer).toBe(true)
  })

  it('方向动画应注入方向变量，避免同类效果表现一致', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-direction-animation-test',
      name: 'SlideShow Direction Animation Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [makeTextElement('text-1', '方向动画元素', 120, 80)],
          animations: [
            {
              id: 'anim-fade-left',
              elId: 'text-1',
              type: 'in',
              effect: 'fadeInLeft',
              duration: 200,
              trigger: 'click',
            },
          ],
        },
      ],
    }

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('方向动画元素')).toBeNull()
    })

    fireEvent.click(document.body)

    await waitFor(() => {
      expect(screen.queryByText('方向动画元素')).not.toBeNull()
    })

    const animationLayer = container.querySelector(
      '[data-slideshow-element-id="text-1"] [data-slideshow-element-layer="animation-primary"]',
    ) as HTMLDivElement | null
    expect(animationLayer).not.toBeNull()
    if (!animationLayer) return

    expect(animationLayer.style.animationName.toLowerCase()).toBe('tabslide-fademovein')
    expect(animationLayer.style.getPropertyValue('--ts-x')).toBe('-24%')
    expect(animationLayer.style.getPropertyValue('--ts-y')).toBe('0%')
  })

  it('B8-01 回归: 视频聚焦时按空格不应触发 nextStep 翻页', async () => {
    const presentation = makePresentation({ withVideo: true })

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('第一页')).not.toBeNull()
    })

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    if (!video) return

    Object.defineProperty(document, 'activeElement', { get: () => video, configurable: true })
    try {
      fireEvent.keyDown(window, { key: ' ' })

      expect(screen.queryByText('第一页')).not.toBeNull()
      expect(screen.queryByText('第二页')).toBeNull()
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (document as Record<string, unknown>)['activeElement']
    }
  })

  it('非媒体元素聚焦时按空格仍应触发 nextStep 翻页', async () => {
    const presentation = makePresentation({ withVideo: true })

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('第一页')).not.toBeNull()
    })

    fireEvent.keyDown(window, { key: ' ' })

    await waitFor(() => {
      expect(screen.queryByText('第二页')).not.toBeNull()
    })
  })

  it('线条元素放映时应优先使用 line.height，避免复杂线条被裁切', async () => {
    const presentation: SlidePresentation = {
      id: 'slideshow-line-height-test',
      name: 'SlideShow Line Height Test',
      preset: '16:9',
      canvasWidth: 1280,
      canvasHeight: 720,
      pages: [
        {
          id: 'page-1',
          elements: [makeLineElement('line-1')],
          animations: [],
        },
      ],
    }

    const { container } = render(
      <SlideShow
        presentation={presentation}
        fullscreenOptions={{ onEnterFullscreen: vi.fn(), onExitFullscreen: vi.fn() }}
      />,
    )

    await waitFor(() => {
      const staticLayer = container.querySelector(
        '[data-slideshow-element-id="line-1"][data-slideshow-element-layer="static"]',
      ) as HTMLDivElement | null
      expect(staticLayer).not.toBeNull()
    })

    const staticLayer = container.querySelector(
      '[data-slideshow-element-id="line-1"][data-slideshow-element-layer="static"]',
    ) as HTMLDivElement | null
    expect(staticLayer).not.toBeNull()
    expect(staticLayer?.style.height).toBe('120px')
  })
})
