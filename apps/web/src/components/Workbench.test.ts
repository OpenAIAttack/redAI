// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Workbench } from './Workbench';
import { I18nProvider } from '../i18n/index';

/**
 * The Workbench reflects only REAL run state (T10b). With no data every tab shows
 * an honest empty state; when real budget/plan/activity arrive the panels render
 * them — never fabricated numbers.
 */
afterEach(() => cleanup());

function renderWorkbench(props: Parameters<typeof Workbench>[0] = {}) {
  return render(createElement(I18nProvider, { children: createElement(Workbench, props) }));
}

describe('Workbench', () => {
  it('renders all five Workbench tabs (vi default)', () => {
    renderWorkbench();
    for (const label of ['Kế hoạch', 'Hoạt động', 'Tệp', 'Phát hiện', 'Sử dụng']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  it('shows honest empty states with no run data', () => {
    renderWorkbench();
    // Activity is the default tab and is empty until events arrive.
    expect(screen.getByText(/Chưa có hoạt động/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Kế hoạch' }));
    expect(screen.getByText(/Chưa có kế hoạch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Sử dụng' }));
    expect(screen.getByText(/Chưa có dữ liệu sử dụng/)).toBeTruthy();
  });

  it('renders real activity entries when provided', () => {
    renderWorkbench({
      activity: [
        {
          eventId: '12',
          type: 'run.state_changed',
          createdAt: 'now',
          label: 'Run queued → running',
        },
      ],
    });
    expect(screen.getByText('Run queued → running')).toBeTruthy();
    expect(screen.getByText('#12')).toBeTruthy();
  });

  it('renders real usage from a budget update, formatted from micro-USD', () => {
    renderWorkbench({
      budget: { observed: '1500000', reserved: '0', limit: '5000000' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Sử dụng' }));
    expect(screen.getByText(/\$1\.5000/)).toBeTruthy();
    expect(screen.getByText(/\$5\.0000/)).toBeTruthy();
  });

  it('switches the selected tab on click', () => {
    renderWorkbench();
    const plan = screen.getByRole('tab', { name: 'Kế hoạch' });
    fireEvent.click(plan);
    expect(plan.getAttribute('aria-selected')).toBe('true');
  });
});
