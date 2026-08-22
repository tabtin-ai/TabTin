import React from 'react'
import openAIIconUrl from '@/assets/provider-icons/openai.svg?url'

export const OpenAIIcon: React.FC<{ className?: string; strokeWidth?: number }> = ({ className }) => (
  <img src={openAIIconUrl} className={className} alt="" aria-hidden />
)
