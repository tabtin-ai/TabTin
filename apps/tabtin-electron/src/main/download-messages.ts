/**
 * 下载模块主进程消息常量
 *
 * 集中管理主进程侧的所有面向用户的文本。
 * 当前为中文默认值，未来接入 i18n 时只需替换此文件的取值逻辑。
 */

import { StreamErrorCode } from '@shared/types/download'

export const DOWNLOAD_MESSAGES = {
  invalidId: '无效的下载 ID',
  streamServiceUnavailable: '流下载服务不可用',
  notFound: '下载项不存在',
  notFoundOrCompleted: '下载项不存在或已完成',
  cannotResume: '此下载不支持恢复',
  inProgress: '下载进行中，无法重试',
  missingUrl: '无法重试：缺少下载 URL',
  windowUnavailable: '主窗口不可用',
  targetDestroyed: '目标页面已关闭',
  pathUnsafe: '路径不合法',
  fileMissing: '文件已被移动或删除',
  unsupportedProtocol: '不支持的下载协议',
  invalidUrl: '无效的下载 URL',
  completedTitle: '下载完成',
  failedTitle: '下载失败',
  dangerousButtons: ['继续下载', '取消'] as const,
  dangerousTitle: '安全提示',
  dangerousMessage: (name: string) => `"${name}" 可能包含可执行代码`,
  dangerousDetail: '此类型的文件可能会损害您的计算机。确认要继续下载吗？',
  streamCompleted: '视频下载完成',
  streamErrors: {
    [StreamErrorCode.ENCRYPTED_STREAM]: '该视频受版权保护（DRM），暂不支持下载',
    [StreamErrorCode.LIVE_STREAM]: '直播流不支持下载，请等待直播结束后重试',
    [StreamErrorCode.NO_SEGMENTS]: '未找到可下载的视频分片',
    [StreamErrorCode.NO_QUALITY_MATCH]: '未找到匹配的画质选项',
    [StreamErrorCode.SEGMENT_FAILED]: '视频下载失败，部分内容无法获取（可能是网站限制）',
    [StreamErrorCode.DOWNLOAD_TIMEOUT]: '下载超时，请检查网络连接后重试',
    [StreamErrorCode.HTTP_ERROR]: '该网站阻止了下载请求',
    [StreamErrorCode.DOWNLOAD_ABORTED]: '下载已取消',
    [StreamErrorCode.MERGE_FAILED]: '视频合并失败，请重试',
    [StreamErrorCode.NETWORK_ERROR]: '网络连接失败，请检查网络后重试',
    [StreamErrorCode.PARSE_ERROR]: '视频地址格式无法识别，可能不是有效的 m3u8 文件',
  },
} as const
