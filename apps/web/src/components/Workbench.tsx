'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Workbench shell (docs/03 §7). The five tabs (Plan, Activity, Files, Findings,
 * Usage) are reserved as honest empty states — they light up when the Agent runs
 * (T10b). No fabricated plans, timelines, findings or usage numbers appear here.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/index';

type Tab = 'plan' | 'activity' | 'files' | 'findings' | 'usage';

export function Workbench(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('plan');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'plan', label: t.chat.tabPlan },
    { id: 'activity', label: t.chat.tabActivity },
    { id: 'files', label: t.chat.tabFiles },
    { id: 'findings', label: t.chat.tabFindings },
    { id: 'usage', label: t.chat.tabUsage },
  ];

  return (
    <aside className="workbench" aria-label={t.chat.workbench}>
      <div className="workbench-tabs" role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tab === tb.id}
            className={`workbench-tab${tab === tb.id ? ' active' : ''}`}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="workbench-body" role="tabpanel">
        <div className="card muted stack">
          <strong>{t.common.comingWithAgent}</strong>
          <span>{t.chat.workbenchEmpty}</span>
        </div>
      </div>
    </aside>
  );
}
