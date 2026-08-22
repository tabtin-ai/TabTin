/**
 * AskUserPanel — ask 三件套（W4 R3 / 2026-05-11）UI 路由根。
 *
 * 历史：
 *   - W7 / A5 D6：物理拆 3 个 Panel（AskChoicePanel / AskFormPanel /
 *     RequestApprovalPanel）+ AskUserRequestState discriminated union by kind。
 *   - W4：一度合一为单 `ask_user` 工具 + 单 panel。
 *   - R3 复盘：恢复三件套并存。`ask_user`（替代 ask_choice）/ `ask_form` /
 *     `request_approval` 三类工具，UI 路由按 state.kind 分发到对应子 panel。
 *     AskChoicePanel 不再独立——其能力由本文件内嵌 `ChoicePanel` 实现，
 *     保留 W4 改进：OTHER_OPTION_ID + option.preview + q.header chip + 多选
 *     + 正向措辞。
 *
 * 字段 owner：
 *   - state.kind === 'choice' → questions[]
 *   - state.kind === 'form'   → fields[] / addons / formMode
 *   - state.kind === 'approval' → rationale / riskLevel / details
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Check, Circle } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { AskUserAnswer, AskUserQuestion } from '@tabtin/chat-client'
import type {
  AskUserRequestState,
  AskUserRequestStateChoice,
} from '../../../stores/chat/shared/types'
import { AskFormPanel } from './AskFormPanel'
import { RequestApprovalPanel } from '../approval/RequestApprovalPanel'
import {
  CARD_RADIUS,
  BORDER,
  TEXT,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'

export interface AskUserPanelProps {
  state: AskUserRequestState
  spaceId?: string | null
  isSubmitting?: boolean
  disabled?: boolean
  /** kind === 'choice' 提交回调（兼容 ask_user 工具的 answers[] 协议） */
  onChoiceSubmit: (answers: AskUserAnswer[]) => void
  /** kind === 'form' fields 模式提交回调 */
  onFormFieldsSubmit?: (fieldValues: Record<string, unknown>) => void
  /** kind === 'form' text_fallback 模式提交回调 */
  onFormTextSubmit?: (text: string) => void
  /** kind === 'approval' 提交回调 */
  onApprovalSubmit?: (approved: boolean) => void
  onSkip?: () => void
}

const OTHER_OPTION_ID = '__other__'

const LoginWallDevicePanel = React.lazy(async () => ({
  default: (await import('./LoginWallDevicePanel')).LoginWallDevicePanel,
}))

const isOtherOption = (id: string): boolean => id === OTHER_OPTION_ID

/**
 * Choice 子面板（内嵌实现，替代曾经的独立 AskChoicePanel.tsx）。
 *
 * W4 改进保留：
 *   - 自动 Other 选项（用户选 Other → 弹自由文本）
 *   - q.header chip + opt.description + opt.preview <pre> 渲染
 *   - 多选（allow_multiple）+ submitError 红条 + onSkip / disabled
 */
const ChoicePanel: React.FC<{
  state: AskUserRequestStateChoice
  isSubmitting: boolean
  disabled: boolean
  onSubmit: (answers: AskUserAnswer[]) => void
  onSkip?: () => void
}> = ({ state, isSubmitting, disabled, onSubmit, onSkip }) => {
  const { t } = useTranslation('chat')
  const questions = state.questions
  const title = state.title
  const submitError = state.submitError

  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {}
    for (const q of questions) {
      initial[q.id] = []
    }
    return initial
  })

  const [freeTexts, setFreeTexts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const q of questions) {
      initial[q.id] = ''
    }
    return initial
  })

  const toggleOption = useCallback(
    (questionId: string, optionId: string, allowMultiple: boolean) => {
      setSelections(prev => {
        const current = prev[questionId] || []
        if (allowMultiple) {
          const next = current.includes(optionId)
            ? current.filter(id => id !== optionId)
            : [...current, optionId]
          return { ...prev, [questionId]: next }
        }
        return { ...prev, [questionId]: current.includes(optionId) ? [] : [optionId] }
      })
    },
    [],
  )

  const updateFreeText = useCallback((questionId: string, text: string) => {
    setFreeTexts(prev => ({ ...prev, [questionId]: text }))
  }, [])

  const canSubmit = questions.length > 0 && questions.every((q: AskUserQuestion) => {
    const selected = selections[q.id] || []
    const text = freeTexts[q.id] || ''
    const otherSelected = selected.some(isOtherOption)
    if (otherSelected) {
      return text.trim().length > 0
    }
    return selected.length > 0
  })

  const handleSubmit = useCallback(() => {
    const answers: AskUserAnswer[] = questions.map((q: AskUserQuestion) => {
      const selected = selections[q.id] || []
      const text = freeTexts[q.id]?.trim() || undefined
      return {
        question_id: q.id,
        selected_options: selected,
        free_text: text,
      }
    })
    onSubmit(answers)
  }, [questions, selections, freeTexts, onSubmit])

  return (
    <div
      data-testid="ask-user-choice-panel"
      className={cn(
        CARD_RADIUS,
        // 与 ApprovalPanel 同用实底 bg-background：composer 灰托盘
        // (chat-composer-backplate) 半透明时，BG.card(bg-muted/10) 会透出灰雾，
        // 整卡看起来像盖了一层蒙层。
        'flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background',
        'max-h-[60vh]',
        BORDER.active,
      )}
    >
      {submitError ? (
        <div
          className={cn(
            'mx-3 mt-3 flex-shrink-0 rounded-md border px-2.5 py-2',
            'border-destructive/30 text-destructive',
            TEXT.meta,
          )}
        >
          {submitError}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-shrink-0 items-center gap-2 px-3 pt-3">
        <HelpCircle className={cn(ICON_SIZE.lg, 'text-accent flex-shrink-0')} />
        <span
          className={cn(
            TEXT.header,
            TEXT_COLOR.secondary,
            'min-w-0 flex-1 break-words [overflow-wrap:anywhere]',
          )}
        >
          {title || t('askUser.title', '请回答以下问题')}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {questions.map((q: AskUserQuestion) => {
          const selected = selections[q.id] || []
          const SelectIcon = q.allow_multiple ? Check : Circle
          const otherSelected = selected.some(isOtherOption)
          return (
            <div key={q.id} className="space-y-1.5">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                {q.header ? (
                  <span
                    className={cn(
                      'inline-flex items-center px-1.5 py-0.5 rounded font-medium',
                      TEXT.meta,
                      'bg-accent/10 text-accent flex-shrink-0',
                    )}
                  >
                    {q.header}
                  </span>
                ) : null}
                <p
                  className={cn(
                    TEXT.body,
                    'font-medium text-foreground min-w-0 flex-1 break-words [overflow-wrap:anywhere]',
                  )}
                >
                  {q.prompt}
                  {q.allow_multiple && (
                    <span
                      className={cn(
                        'ml-1.5 inline-flex px-1.5 py-0.5 rounded font-normal',
                        TEXT.meta,
                        'bg-accent/10 text-accent',
                      )}
                    >
                      {t('askUser.multiSelectHint', '可多选')}
                    </span>
                  )}
                </p>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(q.options ?? []).map((opt) => {
                  const isSelected = selected.includes(opt.id)
                  const customOther = q.other_option
                  const optionLabel = isOtherOption(opt.id)
                    ? (customOther?.label ?? t('askUser.otherOptionLabel', '其他'))
                    : opt.label
                  const optionDescription = isOtherOption(opt.id)
                    ? (customOther?.description
                      ?? t('askUser.otherOptionDescription', '填写上述选项之外的自定义回答'))
                    : opt.description
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => toggleOption(q.id, opt.id, !!q.allow_multiple)}
                      disabled={isSubmitting}
                      className={cn(
                        'min-w-0 rounded-md px-2.5 py-1.5 border text-left transition-all',
                        isSelected
                          ? 'border-accent/30 bg-accent/10 text-accent font-medium'
                          : cn(
                              BORDER.default,
                              'bg-muted/10',
                              TEXT_COLOR.muted,
                              'hover:bg-muted/30 hover:border-border/60',
                            ),
                        isSubmitting && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      <span className="flex min-w-0 items-start gap-1">
                        {isSelected && (
                          <SelectIcon className={cn(ICON_SIZE.md, 'mt-0.5 flex-shrink-0')} />
                        )}
                        <span
                          className={cn(
                            TEXT.meta,
                            'min-w-0 flex-1 font-medium break-words [overflow-wrap:anywhere]',
                          )}
                        >
                          {optionLabel}
                        </span>
                      </span>
                      {optionDescription && (
                        <span
                          className={cn(
                            'mt-0.5 block min-w-0 break-words [overflow-wrap:anywhere]',
                            TEXT.meta,
                            'text-muted-foreground/75',
                          )}
                        >
                          {optionDescription}
                        </span>
                      )}
                      {opt.preview && (
                        <pre
                          className={cn(
                            'mt-1 max-h-32 overflow-auto rounded-sm border border-border/40 bg-background/60 px-2 py-1.5',
                            TEXT.meta,
                            'whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                          )}
                        >
                          {opt.preview}
                        </pre>
                      )}
                    </button>
                  )
                })}
              </div>
              {otherSelected && (
                <input
                  type="text"
                  value={freeTexts[q.id] || ''}
                  onChange={(e) => updateFreeText(q.id, e.target.value)}
                  disabled={isSubmitting}
                  placeholder={t('askUser.freeTextPlaceholder', '输入自定义回答...')}
                  className={cn(
                    'w-full rounded-md border bg-background px-2.5 py-1.5',
                    TEXT.body,
                    BORDER.default,
                    'placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent/40',
                    isSubmitting && 'opacity-60 cursor-not-allowed',
                  )}
                />
              )}
            </div>
          )
        })}
      </div>

      <div
        className={cn(
          'flex flex-shrink-0 items-center justify-between gap-2 border-t px-3 py-2',
          BORDER.subtle,
        )}
      >
        {onSkip ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7 px-3', TEXT.body, 'text-muted-foreground')}
            onClick={onSkip}
            disabled={isSubmitting || disabled}
          >
            {t('askUser.skip', '跳过')}
          </Button>
        ) : (
          <div />
        )}
        <Button
          variant="default"
          size="sm"
          className={cn('h-7 px-4', TEXT.body)}
          onClick={handleSubmit}
          disabled={isSubmitting || !canSubmit || disabled}
        >
          {isSubmitting
            ? t('askUser.submitting', '提交中...')
            : disabled
              ? t('input.wsDisconnected', { defaultValue: '连接已断开' })
              : t('askUser.submit', '提交回答')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Project 成员只读态（决策 Q5，）：非 execution owner 只看到
 * 「正在等待 Owner 处理」，不渲染问题选项 / 表单字段 / 审批理由等具体内容。
 * 与 ApprovalPanel 的 !canResolve 分支同一产品语义。
 */
const TeamSpaceReadonlyCard: React.FC<{ ownerName?: string }> = ({ ownerName }) => {
  const { t } = useTranslation('chat')
  const ownerLabel = ownerName?.trim() || t('approval.executionOwnerFallback', { defaultValue: 'Owner' })
  return (
    <div
      data-testid="ask-user-panel-readonly"
      className={cn(
        CARD_RADIUS,
        'flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background p-3 space-y-2',
        BORDER.active,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <HelpCircle className={cn(ICON_SIZE.lg, 'text-accent flex-shrink-0')} />
        <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'min-w-0 flex-1 break-words [overflow-wrap:anywhere]')}>
          {t('askUser.teamSpaceReadonlyWaiting', {
            owner: ownerLabel,
            defaultValue: 'Agent 发起了需要处理的请求，正在等待 {{owner}} 处理。',
          })}
        </span>
      </div>
      <p className={cn(TEXT.meta, 'text-muted-foreground/60')}>
        {t('askUser.teamSpaceReadonlyHint', { defaultValue: '处理完成后 Agent 会继续执行，结果将同步到这里。' })}
      </p>
    </div>
  )
}

/**
 * AskUserPanel —— 顶层路由按 state.kind 分发到 ChoicePanel / AskFormPanel /
 * RequestApprovalPanel 三家子组件。每家子组件 owns 自己的字段与提交语义。
 */
export const AskUserPanel: React.FC<AskUserPanelProps> = ({
  state,
  spaceId = null,
  isSubmitting = false,
  disabled = false,
  onChoiceSubmit,
  onFormFieldsSubmit,
  onFormTextSubmit,
  onApprovalSubmit,
  onSkip,
}) => {
  if (state.canResolve === false) {
    return <TeamSpaceReadonlyCard ownerName={state.teamSpaceExecution?.executionOwnerDisplayName} />
  }

  if (state.kind === 'choice') {
    if (state.contextHint?.kind === 'login_wall' && spaceId) {
      return (
        <React.Suspense fallback={null}>
          <LoginWallDevicePanel
            spaceId={spaceId}
            threadId={state.threadId}
            domain={state.contextHint.domain}
            tabId={state.contextHint.tabId}
            questions={state.questions}
            onRelayComplete={onChoiceSubmit}
            onSkip={onSkip}
          >
            <ChoicePanel
              state={state}
              isSubmitting={isSubmitting}
              disabled={disabled}
              onSubmit={onChoiceSubmit}
              onSkip={onSkip}
            />
          </LoginWallDevicePanel>
        </React.Suspense>
      )
    }
    return (
      <ChoicePanel
        state={state}
        isSubmitting={isSubmitting}
        disabled={disabled}
        onSubmit={onChoiceSubmit}
        onSkip={onSkip}
      />
    )
  }

  if (state.kind === 'form') {
    return (
      <AskFormPanel
        title={state.title}
        fields={state.fields}
        addons={state.addons}
        formMode={state.formMode}
        onFieldsSubmit={onFormFieldsSubmit}
        onTextSubmit={onFormTextSubmit}
        onSkip={onSkip}
        isSubmitting={isSubmitting}
        disabled={disabled}
        submitError={state.submitError}
      />
    )
  }

  // kind === 'approval'
  if (!onApprovalSubmit) {
    console.error('[AskUserPanel] kind=approval but onApprovalSubmit not provided')
    return null
  }

  return (
    <RequestApprovalPanel
      rationale={state.rationale}
      riskLevel={state.riskLevel}
      title={state.title}
      details={state.details}
      submitLabel={state.submitLabel}
      declineLabel={state.declineLabel}
      onApprovalSubmit={onApprovalSubmit}
      isSubmitting={isSubmitting}
      disabled={disabled}
      submitError={state.submitError}
    />
  )
}
