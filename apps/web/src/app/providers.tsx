'use client';

import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n/index';
import { ThemeProvider } from '../theme/ThemeProvider';

/** Client provider tree shared by every route (theme + i18n). */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>{children}</I18nProvider>
    </ThemeProvider>
  );
}
