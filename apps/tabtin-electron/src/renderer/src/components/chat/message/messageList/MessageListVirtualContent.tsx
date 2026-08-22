import React from 'react'

export interface MessageListVirtualContentProps {
  contentRef: (node: HTMLDivElement | null) => void
  bottomMarkerRef: (node: HTMLDivElement | null) => void
  topOverlay?: React.ReactNode
  totalSize: number
  offsetTop: number
  contentPadding: string
  trailingPlaceholderHeight?: number
  bottomSpacerHeight: number
  trailingPlaceholder?: React.ReactNode
  afterContent?: React.ReactNode
  children: React.ReactNode
}

export function MessageListVirtualContent({
  contentRef,
  bottomMarkerRef,
  topOverlay,
  totalSize,
  offsetTop,
  contentPadding,
  trailingPlaceholderHeight = 0,
  bottomSpacerHeight,
  trailingPlaceholder,
  afterContent,
  children,
}: MessageListVirtualContentProps) {
  return (
    <div ref={contentRef} className="relative">
      {topOverlay}

      <div
        style={{
          minHeight: totalSize + trailingPlaceholderHeight,
          boxSizing: 'border-box',
          position: 'relative',
          // border-box 让 paddingTop 计入 minHeight：正常时总高仍是 totalSize，
          // 只有末尾可见窗口真实高度超过剩余预算时才向下撑开。
          paddingTop: offsetTop,
        }}
      >
        <div className={contentPadding}>
          {/* 可见虚拟窗口必须参与文档流：末条消息在图片、Markdown 或流式正文
              完成布局后可能高于虚拟器的上一帧估算。若窗口绝对定位在固定 height
              容器里，溢出的正文不会推开底部 spacer，滚到底时仍会被 Composer 遮住。 */}
          {children}
        </div>
        {trailingPlaceholder}
      </div>
      {afterContent}
      <div aria-hidden data-testid="message-list-bottom-spacer" style={{ height: bottomSpacerHeight }} />
      <div
        ref={bottomMarkerRef}
        aria-hidden
        data-testid="message-list-bottom-marker"
        className="pointer-events-none h-px -mb-px opacity-0"
      />
    </div>
  )
}
