/**
 * ShareDialog 公共类型 — 对齐 PRD §四 D1-D11 + §五块 1.2 后端契约。
 */

/** ：TabFiles 与文档/表格共用协作者邀请；公开链接仅 doc/table */
export type ResourceType = 'doc' | 'table' | 'file';

/** D2: 资源协作者权限词汇（与 DocumentPermission / TablePermission 一致） */
export type CollaboratorPermission = 'viewer' | 'editor' | 'admin';

/** D2: 公开链接权限词汇（与 *Share.permission 一致） */
export type ShareLinkPermission = 'view' | 'comment' | 'edit';

/** D6: 公开链接「可见范围」前端语义；hook 内部按 resourceType 翻译成后端 share_type */
export type ShareScope = 'public' | 'organization';

export interface UserBrief {
  user_id: string;
  nickname: string;
  avatar?: string | null;
  email: string;
}

export interface CollaboratorOut extends UserBrief {
  permission: CollaboratorPermission | string;
  created_at?: string | null;
}

/** PRD §五块 1.2 SkippedItem.reason — 三种已枚举值 */
export type SkippedReason = 'not_in_organization' | 'is_owner' | 'self' | string;

export interface SkippedItem {
  user_id: string;
  reason: SkippedReason;
}

export interface InviteResult {
  notified: number;
  skipped: SkippedItem[];
}

/** 公开链接对象（与 packages/tabdoc-ui/src/ShareSettingsPanel ShareSettings 对齐 + 通用化） */
export interface ShareSettings {
  share_id: string;
  share_type: string; // 'public' | 'organization'（doc）或 'data' | 'organization'（table）
  permission: string;
  has_password: boolean;
  expire_at?: string | null;
  allow_download?: boolean;
  /** 仅 doc 有 */
  allow_copy?: boolean;
  /** 仅 doc 有，table 总是空 */
  organization_id?: string;
  visit_count: number;
  is_active?: boolean;
  created_at?: string | null;
}

/** 成员搜索返回的最小 user shape（区别于 CollaboratorOut，只有公开能看的字段） */
export interface SearchedUser {
  id: string;
  nickname: string;
  /** @username 主页标识，用于重名区分；无则为空串 */
  username: string;
  avatar: string;
}

/** ShareDialog 主组件 props — 对齐宪法清单 C */
export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
  resourceType: ResourceType;
  resourceId: string;
  resourceTitle: string;
  organizationId: string;
  /** 公开分享链接的 URL 前缀，例如 'https://app.example.com/shared/docs/'。
   *  调用方必须传入公网 Web 前缀；缺省时不会生成可复制链接。 */
  shareUrlPrefix?: string;
  /** D10: owner / admin = true；viewer / editor = false（控制邀请/移除/链接开关） */
  canManage: boolean;
  /**
   * react-i18next 的 t 函数；调用方应保证传入的 t 能解析 `share.dialog.*` keys
   * （TabTin 当前约定将这些 keys 放在 `common` namespace 下）。
   * 缺省时 ShareDialog 内部 fallback 到 useTranslation('common').t。
   */
  t?: (key: string, opts?: Record<string, unknown>) => string;
}
