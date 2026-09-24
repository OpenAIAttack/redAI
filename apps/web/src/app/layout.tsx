import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { themeBootstrapScript } from '../theme/ThemeProvider';

export const metadata: Metadata = {
  title: 'redAI',
  description: 'redAI Personal — self-hosted single-owner security workbench.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  // `lang` defaults to vi (SPEC_LOCK ui_language=vi). The theme is applied before
  // paint by an inline script to avoid a flash of the wrong theme.
  return (
    <html lang="vi" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
