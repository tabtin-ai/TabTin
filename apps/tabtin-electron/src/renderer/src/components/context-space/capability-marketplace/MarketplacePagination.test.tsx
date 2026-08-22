import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number; total?: number }) => {
      if (key.endsWith('pageInfo'))
        return `${values?.current} / ${values?.total}`;
      if (key.endsWith('previous')) return '上一页';
      if (key.endsWith('next')) return '下一页';
      if (key.endsWith('label')) return '分页';
      return key;
    },
  }),
}));

import {
  MarketplacePagination,
  paginateMarketplaceItems,
} from './MarketplacePagination';

describe('MarketplacePagination', () => {
  it('每页固定展示 12 项并可前后翻页', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: String(index + 1),
    }));

    render(
      <MarketplacePagination
        items={items}
        getKey={(item) => item.id}
        renderItem={(item) => <span>项目 {item.id}</span>}
      />,
    );

    expect(screen.getAllByText(/^项目 /)).toHaveLength(12);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getAllByText(/^项目 /)).toHaveLength(12);
    expect(screen.getByText('项目 13')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getAllByText(/^项目 /)).toHaveLength(1);
    expect(screen.getByText('项目 25')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('不足一页时不显示分页控件，并把越界页夹回有效范围', () => {
    expect(paginateMarketplaceItems([1, 2, 3], 99)).toEqual([1, 2, 3]);

    render(
      <MarketplacePagination
        items={[{ id: 'only' }]}
        getKey={(item) => item.id}
        renderItem={(item) => <span>{item.id}</span>}
      />,
    );

    expect(screen.queryByRole('navigation', { name: '分页' })).toBeNull();
  });
});
