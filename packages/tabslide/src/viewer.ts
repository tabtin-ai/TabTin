/**
 * 浏览器安全的只读预览入口。
 *
 * 这个子入口刻意只暴露 Web 预览所需的最小能力，
 * 避免消费者通过主入口把视频导出 / design-engine 等
 * 非浏览器安全依赖一并打进 bundle。
 */

export { default as SlideRenderer } from './components/SlideRenderer'

export {
  convertBackendToPresentation,
  convertBackendPage,
  convertBackendElement,
} from './exports/backend-adapter'

export type {
  BackendProjectDetail,
  BackendSlidePage,
  BackendSlideElement,
} from './exports/backend-adapter'

export type {
  Slide,
  SlideTheme,
  SlidePresentation,
} from './types/slides'
