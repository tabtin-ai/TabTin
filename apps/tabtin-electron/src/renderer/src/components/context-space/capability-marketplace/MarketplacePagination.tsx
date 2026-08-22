import { Fragment, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@components/ui';
import { cn } from '@utils/cn';

export const MARKETPLACE_PAGE_SIZE = 12;

export function paginateMarketplaceItems<T>(
  items: readonly T[],
  page: number,
  pageSize = MARKETPLACE_PAGE_SIZE,
): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

interface MarketplacePaginationProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  gridClassName?: string;
  pageSize?: number;
  ariaLabel?: string;
}

/**
 * 能力市场的本地分页容器。调用方用 React key 表达筛选上下文；
 * 搜索、切货架或切工作区时组件自然重建并回到第一页。
 */
export function MarketplacePagination<T>({
  items,
  getKey,
  renderItem,
  gridClassName,
  pageSize = MARKETPLACE_PAGE_SIZE,
  ariaLabel,
}: MarketplacePaginationProps<T>) {
  const { t } = useTranslation('context');
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = paginateMarketplaceItems(items, currentPage, pageSize);

  return (
    <>
      <div
        className={cn(
          'grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]',
          gridClassName,
        )}
      >
        {pageItems.map((item) => (
          <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
        ))}
      </div>

      {totalPages > 1 ? (
        <nav
          className="mt-5 flex items-center justify-center gap-2"
          aria-label={ariaLabel ?? t('skills.marketplace.pagination.label')}
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md"
            disabled={currentPage === 1}
            aria-label={t('skills.marketplace.pagination.previous')}
            onClick={() =>
              setPage((current) =>
                Math.max(1, Math.min(current, totalPages) - 1),
              )
            }
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span
            className="min-w-16 text-center text-body tabular-nums text-muted-foreground/80"
            aria-live="polite"
          >
            {t('skills.marketplace.pagination.pageInfo', {
              current: currentPage,
              total: totalPages,
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md"
            disabled={currentPage === totalPages}
            aria-label={t('skills.marketplace.pagination.next')}
            onClick={() =>
              setPage((current) =>
                Math.min(totalPages, Math.min(current, totalPages) + 1),
              )
            }
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </nav>
      ) : null}
    </>
  );
}
