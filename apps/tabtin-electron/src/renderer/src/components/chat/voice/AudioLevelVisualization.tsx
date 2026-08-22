/**
 * AudioLevelVisualization — 录音音量柱状条可视化
 *
 * 复刻 iOS AudioLevelVisualization.swift。
 * compact 模式用于工具栏胶囊（8 根小柱子），默认模式 30 根。
 */
/* eslint-disable tabtin/no-chat-design-violations -- 录音红是动作色 */

import React, { memo } from 'react'

interface AudioLevelVisualizationProps {
  levels: number[]
  compact?: boolean
}

const BAR_COUNT_DEFAULT = 30
const BAR_COUNT_COMPACT = 8

export const AudioLevelVisualization: React.FC<AudioLevelVisualizationProps> = memo(({
  levels,
  compact = false,
}) => {
  const barCount = compact ? BAR_COUNT_COMPACT : BAR_COUNT_DEFAULT
  const displayLevels = levels.length >= barCount
    ? levels.slice(-barCount)
    : [...Array(barCount - levels.length).fill(0.05), ...levels]

  if (compact) {
    return (
      <div
        className="flex items-center justify-center gap-[1.5px] h-4"
        role="img"
        aria-label="Audio level"
      >
        {displayLevels.map((level, i) => (
          <div
            key={i}
            className="w-[2px] rounded-[1px] bg-red-400/80 transition-[height] duration-75 ease-out"
            style={{ height: `${Math.max(2, level * 14)}px` }}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="flex items-center justify-center gap-[2px] h-11"
      role="img"
      aria-label="Audio level"
    >
      {displayLevels.map((level, i) => (
        <div
          key={i}
          className="w-[3px] rounded-[1.5px] bg-accent/60 transition-[height] duration-100 ease-out"
          style={{ height: `${Math.max(3, level * 40)}px` }}
        />
      ))}
    </div>
  )
})

AudioLevelVisualization.displayName = 'AudioLevelVisualization'
