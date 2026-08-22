import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimeSelect } from './TimeSelect';

describe('TimeSelect', () => {
  it('keeps the time trigger compact and centers dropdown values', async () => {
    Element.prototype.scrollIntoView = () => undefined;
    render(<TimeSelect value="03:23" onChange={() => undefined} />);

    const hourTrigger = screen.getByRole('combobox', { name: '小时' });
    expect(hourTrigger.className).toContain('w-14');

    fireEvent.click(hourTrigger);

    const selectedHour = await screen.findByRole('option', { name: '03' });
    expect(selectedHour.className).toContain('justify-center');
    expect(selectedHour.className).toContain('px-2');
  });
});
