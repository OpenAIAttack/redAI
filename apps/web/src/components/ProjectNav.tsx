'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '../i18n/index';

/** Sub-navigation tabs for a project (overview / files / settings). */
export function ProjectNav({ projectId }: { projectId: string }): JSX.Element {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/p/${projectId}`;
  const tabs: Array<{ href: string; label: string }> = [
    { href: base, label: t.nav.overview },
    { href: `${base}/files`, label: t.nav.files },
    { href: `${base}/settings`, label: t.nav.projectSettings },
  ];
  return (
    <div className="workbench-tabs" style={{ borderBottom: '1px solid var(--border)' }}>
      {tabs.map((tab) => {
        const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`workbench-tab${active ? ' active' : ''}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
