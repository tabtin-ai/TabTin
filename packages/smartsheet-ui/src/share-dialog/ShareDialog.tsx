/**
 * ShareDialog — TabDoc / TabData 共用的两段式分享对话框。
 *
 * PRD §五块 2 + 宪法清单 C：
 *   - 顶部：CollaboratorsSection（owner 单独 + 协作者邀请/管理）
 *   - 分隔
 *   - 底部：PublicLinkSection（公开链接开关 + 范围 + 权限 + 密码 + 链接）
 *
 * 调用方负责按资源类型传 resourceType / resourceId / organizationId 等；
 * canManage 由调用方计算（owner / admin）。
 *
 * 本期不订阅 NotificationStore 做实时降级——那是 Wave 4 的 F6 任务。
 */

import * as React from 'react';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../components/sheet';
import { Button } from '../components/button';
import { ScrollArea } from '../components/scroll-area';
import { CollaboratorsSection } from './CollaboratorsSection';
import { PublicLinkSection } from './PublicLinkSection';
import type { ShareDialogProps } from './types';

export const ShareDialog: React.FC<ShareDialogProps> = ({
  open,
  onOpenChange,
  container,
  resourceType,
  resourceId,
  resourceTitle,
  organizationId,
  shareUrlPrefix,
  canManage,
  t: tProp,
}) => {
  // Fallback：调用方未传 t 时，从 react-i18next 取 common namespace
  const { t: tCommon } = useTranslation('common');
  const t =
    tProp ??
    ((key: string, opts?: Record<string, unknown>) =>
      String(tCommon(key as any, opts as any)));

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        container={container}
        className="pointer-events-auto flex w-[min(420px,100vw)] max-w-full flex-col overflow-hidden p-0 shadow-2xl data-[state=open]:!animate-none data-[state=closed]:!animate-none !transition-none sm:max-w-[420px]"
        onFocusOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="flex items-center gap-2 pr-8 text-body">
            <Share2 className="h-4 w-4 text-muted-foreground" />
            {t('share.dialog.title', {
              defaultValue: '分享《{{title}}》',
              title:
                resourceTitle ||
                t('share.dialog.untitled', { defaultValue: '未命名' }),
            })}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {resourceType === 'file'
              ? t('share.dialog.fileDescription', {
                  defaultValue: '管理可查看和下载此文件的成员。',
                })
              : t('share.dialog.description', {
                  defaultValue: '管理协作者和公开链接。',
                })}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-4 px-4 py-4">
            <CollaboratorsSection
              resourceType={resourceType}
              resourceId={resourceId}
              organizationId={organizationId}
              canManage={canManage}
              t={t}
            />

            {/* ：静态文件只向指定成员授予查看/下载权限，不提供公开链接 */}
            {resourceType !== 'file' && (
              <PublicLinkSection
                resourceType={resourceType}
                resourceId={resourceId}
                organizationId={organizationId}
                shareUrlPrefix={shareUrlPrefix}
                canManage={canManage}
                t={t}
              />
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="shrink-0 border-t border-border/40 px-4 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('share.dialog.close', { defaultValue: '关闭' })}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
