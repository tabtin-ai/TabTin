/**
 * Wave 4 视角 1+2 P0 自修 + 三视角 Review 视角 2 P1 发现 2 自修：
 * Agent 后台 view 自动登录"成功 + 失败"双状态 Toast。
 *
 * 业务（PRD Story 5 + PD-9 产品诚实度兜底）：
 *   - **失败路径**（主进程发 ``credential-vault:agent-autofill-failed``）：
 *     凭据 reveal/fill/submit 任一步失败 → error toast，提示用户检查凭据；
 *   - **成功路径**（主进程发 ``credential-vault:agent-autofill-succeeded``）：
 *     Agent 用 user 保存的密码完成自动登录 → info toast，让用户知道
 *     "Agent 刚刚用了哪个账号登了哪个站"。
 *
 * 为什么成功路径也必须 toast（PD-9 兜底）：
 *   PD-9 拍板"本期不做敏感网站名单 + 单匹配自动 fill+submit"，意味着 Agent
 *   可以在不可见的后台 view 上用用户保存的密码登录任何网站（包括银行 /
 *   支付 / 邮箱）。如果**完全静默**，用户体感是"TabTin 擅自动我账户"——
 *   产品信任崩盘。这条 toast 不挡 Agent 行动，但不让动作隐形。
 *
 * 不做的事（划界）：
 *   - 不**展示密码**——payload 本身不含密码字段；
 *   - 不**展示完整 username** —— 已经在主进程脱敏成 ``maskedUsername``；
 *   - 不**自动跳转设置页**——只 toast，避免打断用户当前操作；
 *   - 不**重试** —— Agent 自己通过 RunSession observation 决定下一步动作。
 *
 * 文案策略（与 PRD Story 5 对齐）：
 *   - 成功：``agentAutofillSuccess.*``
 *   - credential-unavailable（凭据失效）：最常见，提示用户去设置页更新
 *   - fill-failed（域名不匹配 / DOM 异常）：罕见，提示是技术问题
 *   - submit-failed（fill 成了但找不到 submit 按钮）：Wave 4 真·真 Review 视角 3
 *     P1 发现 1 自修——shadow DOM、自定义按钮等场景下出现，告诉用户密码已填
 *     入但需手动点击登录
 *   - reveal-fn-not-configured：开发期意外，用 console.warn 兜底（不打扰用户）
 *
 * **Wave 4 真·真 Review 视角 2 P2 发现 4 自修**：
 *   命名空间从 ``settings`` 迁到 ``crawl`` —— 本组件物理位于 ``crawl/`` 目录而非
 *   设置页，旧的 ``useTranslation('settings')`` 让 Wave 5 设置页重构时容易把
 *   ``agentAutofillFailed`` / ``agentAutofillSuccess`` 段当成 panel 文案误删。
 *
 * **Wave 5b S1 文案统一**：
 *   浏览器登录态与网站密码归到「设置 → 设备 → 浏览器」；i18n key 不变，
 *   已发布版本可无缝切换文案。
 *
 * **Wave 4 真·真 Review 视角 2 P1 发现 3 自修**：
 *   多 Agent 协作场景下用户必须能区分"是哪个 Agent 在动"。主进程通过 spaceId
 *   字段透传到 emitter payload；renderer 端用 ``useSpaceStore`` 反查
 *   space.name —— 反查失败时降级回原文案"Agent 已...""。
 *
 * 不在 SavePasswordBar 里做这一条，因为：
 *   - SavePasswordBar 是**采集**入口（用户主动登录后弹）；
 *   - 本 Toast 是**消费**反馈（Agent 自动登录成功 / 失败弹）——语义独立，
 *     独立组件便于 Wave 5 替换为更丰富的"凭据健康度看板"。
 */
import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui/toast'

import { useSpaceStore } from '@tabtin/app-shell'

interface AgentAutofillFailedPayload {
  tabId: string
  code: string
  credentialId?: string
  domain?: string
  detail?: string
  spaceId?: string
}

interface AgentAutofillSucceededPayload {
  tabId: string
  domain: string
  maskedUsername: string
  credentialId: string
  spaceId?: string
}

/**
 * 反查 spaceId 对应的 Space 名字。
 *
 * Wave 4 三视角 Review 视角 2 P1 发现 3 自修：
 *   ``useSpaceStore`` 里 Space.name 就是用户创建 Space 时取的展示名。
 *
 * 反查失败（spaceId 缺、Space 不在 store、刚启动 store 还没 hydrate）→ 返回 null
 * 让调用方降级到原文案（不带名字）。
 */
function resolveAgentName(spaceId: string | undefined): string | null {
  if (!spaceId) return null
  try {
    const spaces = useSpaceStore.getState().spaces
    const space = spaces.find((s) => s.id === spaceId)
    return space?.name?.trim() || null
  } catch {
    return null
  }
}

export const AgentAutofillFailedToast: React.FC = () => {
  // Wave 4 真·真 Review 视角 2 P2 发现 4 自修：crawl namespace（与文件位置对齐）
  const { t } = useTranslation('crawl')

  useEffect(() => {
    const credentialVault = window.tabtin?.credentialVault
    if (!credentialVault) return undefined

    const unsubs: Array<() => void> = []

    if (credentialVault.onAgentAutofillFailed) {
      const unsub = credentialVault.onAgentAutofillFailed((payload: AgentAutofillFailedPayload) => {
        const domainText = payload.domain || 'unknown'
        const agentName = resolveAgentName(payload.spaceId)
        let title = t('agentAutofillFailed.title', '自动登录失败')
        // 默认 generic 文案——根据 code + agentName 二维选键
        let description: string
        if (payload.code === 'credential-unavailable') {
          title = t('agentAutofillFailed.titleCredential', '凭据可能已失效')
          description = agentName
            ? t('agentAutofillFailed.descCredentialWithAgent', {
                defaultValue: '{{agentName}} 自动登录 {{domain}} 时凭据失效，请前往「设置 → 设备 → 浏览器」更新密码',
                agentName,
                domain: domainText,
              })
            : t('agentAutofillFailed.descCredential', {
                defaultValue: '{{domain}} 的密码可能已过期或被禁用，请前往「设置 → 设备 → 浏览器」更新',
                domain: domainText,
              })
        } else if (payload.code === 'fill-failed' || payload.code === 'submit-failed') {
          title = t('agentAutofillFailed.titleFill', '自动填充未完成')
          description = agentName
            ? t('agentAutofillFailed.descFillWithAgent', {
                defaultValue: '{{agentName}} 自动填充 {{domain}} 的登录表单失败，可能是表单结构异常，请尝试手动登录',
                agentName,
                domain: domainText,
              })
            : t('agentAutofillFailed.descFill', {
                defaultValue: '{{domain}} 的登录表单结构异常，已通知 Agent 暂停。请尝试手动登录',
                domain: domainText,
              })
        } else if (payload.code === 'reveal-fn-not-configured') {
          // 开发期意外，不打扰用户
          console.warn('[AgentAutofillFailedToast] reveal-fn-not-configured:', payload)
          return
        } else {
          description = agentName
            ? t('agentAutofillFailed.descGenericWithAgent', {
                defaultValue: '{{agentName}} 自动登录 {{domain}} 失败，请前往「设置 → 设备 → 浏览器」检查凭据',
                agentName,
                domain: domainText,
              })
            : t('agentAutofillFailed.descGeneric', {
                defaultValue: '{{domain}} 自动登录失败，请前往「设置 → 设备 → 浏览器」检查凭据',
                domain: domainText,
              })
        }

        toast.error(title, {
          description,
          duration: 5000,
        })
      })
      unsubs.push(unsub)
    }

    if (credentialVault.onAgentAutofillSucceeded) {
      const unsub = credentialVault.onAgentAutofillSucceeded((payload: AgentAutofillSucceededPayload) => {
        const agentName = resolveAgentName(payload.spaceId)
        // info toast：3s 自动消失（比 error 的 5s 短，不打扰）
        toast.info(
          t('agentAutofillSuccess.title', 'Agent 已自动登录'),
          {
            description: agentName
              ? t('agentAutofillSuccess.descriptionWithAgent', {
                  defaultValue: '{{agentName}} 已用 {{username}} 自动登录 {{domain}}',
                  agentName,
                  domain: payload.domain,
                  username: payload.maskedUsername,
                })
              : t('agentAutofillSuccess.description', {
                  defaultValue: 'Agent 已用 {{username}} 自动登录 {{domain}}',
                  domain: payload.domain,
                  username: payload.maskedUsername,
                }),
            duration: 3000,
          },
        )
      })
      unsubs.push(unsub)
    }

    return () => {
      for (const u of unsubs) {
        try {
          u?.()
        } catch (err) {
          console.warn('[AgentAutofillFailedToast] unsubscribe failed:', err)
        }
      }
    }
  }, [t])

  return null
}
