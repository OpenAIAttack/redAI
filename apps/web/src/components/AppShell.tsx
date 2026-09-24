'use client';

/**
 * The authenticated app shell: collapsible sidebar (projects + nav) and a topbar
 * with connection status, theme + language toggles and sign-out. The Workbench
 * open/close affordance lives inside the chat route; here the shell owns global
 * navigation only.
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useI18n, type Locale } from '../i18n/index';
import { useTheme } from '../theme/ThemeProvider';
import { useSession } from './SessionProvider';
import { logout, listProjects } from '../lib/endpoints';
import { useAsync } from '../lib/useAsync';
import type { Project } from '../lib/types';

function Sidebar({ open }: { open: boolean }): JSX.Element {
  const { t } = useI18n();
  const pathname = usePathname();
  const projects = useAsync<{ items: Project[] }>(() => listProjects(), []);

  const isActive = (href: string): boolean =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <nav className={`sidebar${open ? ' drawer-open' : ''}`} aria-label={t.nav.projects}>
      <Link href="/" className="btn btn-primary" style={{ justifyContent: 'center' }}>
        {t.nav.newChat}
      </Link>
      <div className="section-title">{t.nav.projects}</div>
      {projects.loading ? (
        <div className="muted" role="status">
          {t.common.loading}
        </div>
      ) : projects.error ? (
        <div className="faint">{t.common.errorGeneric}</div>
      ) : projects.data && projects.data.items.length > 0 ? (
        projects.data.items.map((p) => (
          <Link
            key={p.id}
            href={`/p/${p.id}`}
            className={isActive(`/p/${p.id}`) ? 'active' : ''}
            title={p.name}
          >
            {p.is_inbox ? `📥 ${t.nav.inbox}` : p.name}
          </Link>
        ))
      ) : (
        <div className="faint">{t.home.noProjects}</div>
      )}
      <div className="section-title">{t.nav.settings}</div>
      <Link href="/workers" className={isActive('/workers') ? 'active' : ''}>
        {t.nav.workers}
      </Link>
      <Link href="/settings" className={isActive('/settings') ? 'active' : ''}>
        {t.nav.settings}
      </Link>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggle } = useTheme();
  const session = useSession();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const onSignOut = async (): Promise<void> => {
    try {
      await logout();
    } catch {
      // Even if the network call fails, the client should return to login.
    }
    router.replace('/login');
  };

  return (
    <div className="shell">
      <Sidebar open={drawerOpen} />
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button
              className="btn"
              aria-label={t.nav.expandSidebar}
              onClick={() => setDrawerOpen((o) => !o)}
            >
              ☰
            </button>
            <strong>{t.common.appName}</strong>
            <span className="badge" title={session.username}>
              {session.username}
            </span>
          </div>
          <div className="row">
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label={t.settings.language}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              <option value="vi">VI</option>
              <option value="en">EN</option>
            </select>
            <button className="btn" onClick={toggle} aria-label={t.settings.theme}>
              {theme === 'dark' ? '🌙' : '☀️'}
            </button>
            <button className="btn" onClick={onSignOut}>
              {t.common.signOut}
            </button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
