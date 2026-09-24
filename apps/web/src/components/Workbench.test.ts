// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Workbench } from './Workbench';
import { I18nProvider } from '../i18n/index';

/**
 * The Workbench is an honest, labelled empty shell (T10b lights it up). It must
 * render all five tabs and an explicit "coming with the Agent" state — never
 * fabricated plan/activity/findings/usage data.
 */
afterEach(() => cleanup());

function renderWorkbench() {
  return render(createElement(I18nProvider, { children: createElement(Workbench) }));
}

describe('Workbench shell', () => {
  it('renders all five Workbench tabs (vi default)', () => {
    renderWorkbench();
    for (const label of ['Kế hoạch', 'Hoạt động', 'Tệp', 'Phát hiện', 'Sử dụng']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  it('shows an honest empty state, not fabricated data', () => {
    renderWorkbench();
    expect(screen.getByText(/Sẽ có cùng Agent/)).toBeTruthy();
  });

  it('switches the selected tab on click', () => {
    renderWorkbench();
    const activity = screen.getByRole('tab', { name: 'Hoạt động' });
    fireEvent.click(activity);
    expect(activity.getAttribute('aria-selected')).toBe('true');
  });
});
