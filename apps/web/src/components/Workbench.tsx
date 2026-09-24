'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Workbench (docs/03 §7), wired to live run state in T10b.
 *
 * The five tabs light up from REAL run events only — there are no fabricated
 * plans, timelines, findings or usage numbers. Until an event arrives each tab
 * shows an honest empty state:
 *   - Plan:     from `plan.updated` events (revision + step count).
 *   - Activity: an ordered log of the real events received for the run.
 *   - Files:    unchanged from T10a (managed on the Files & notes screen).
 *   - Findings: empty (the findings API lands in a later milestone).
 *   - Usage:    from `budget.updated` events and the run's budget limit.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/index';
import type { ActivityEntry } from '../lib/realtime/chatState';
import type { RunState } from '../lib/types';

type Tab = 'plan' | 'activity' | 'files' | 'findings' | 'usage';

export interface WorkbenchProps {
  runState?: RunState | null;
  budget?: { observed: string; reserved: string; limit: string } | null;
  plan?: { revision: number; stepCount: number } | null;
  activity?: ActivityEntry[];
}

function microUsd(value: string): string {
  // Integer micro-USD string → a plain USD amount, no locale surprises.
  const micros = Number(value);
  if (!Number.isFinite(micros)) return value;
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function Workbench(props: WorkbenchProps): JSX.Element {
  const { runState = null, budget = null, plan = null, activity = [] } = props;
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('activity');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'plan', label: t.chat.tabPlan },
    { id: 'activity', label: t.chat.tabActivity },
    { id: 'files', label: t.chat.tabFiles },
    { id: 'findings', label: t.chat.tabFindings },
    { id: 'usage', label: t.chat.tabUsage },
  ];

  const emptyCard = (msg: string): JSX.Element => <div className="card muted">{msg}</div>;

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
        {tab === 'plan' &&
          (plan ? (
            <div className="card stack">
              <span className="section-title">{t.chat.tabPlan}</span>
              <span>
                {t.chat.planRevision}: {plan.revision} · {t.chat.planSteps}: {plan.stepCount}
              </span>
            </div>
          ) : (
            emptyCard(t.chat.planEmpty)
          ))}

        {tab === 'activity' &&
          (activity.length > 0 ? (
            <div className="stack">
              {activity.map((a) => (
                <div
                  key={a.eventId}
                  className="card row"
                  style={{ justifyContent: 'space-between' }}
                >
                  <span>{a.label}</span>
                  <span className="faint" title={a.createdAt}>
                    #{a.eventId}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            emptyCard(t.chat.activityEmpty)
          ))}

        {tab === 'files' && emptyCard(t.chat.filesHint)}

        {tab === 'findings' && emptyCard(t.chat.findingsEmpty)}

        {tab === 'usage' &&
          (budget || runState ? (
            <div className="card stack">
              <span className="section-title">{t.chat.tabUsage}</span>
              {runState ? (
                <span>
                  {t.chat.runState}: {runState}
                </span>
              ) : null}
              {budget ? (
                <>
                  <span>
                    {t.chat.usageObserved}: {microUsd(budget.observed)}
                  </span>
                  <span>
                    {t.chat.usageReserved}: {microUsd(budget.reserved)}
                  </span>
                  <span>
                    {t.chat.usageLimit}: {microUsd(budget.limit)}
                  </span>
                </>
              ) : (
                <span className="faint">{t.chat.usageEmpty}</span>
              )}
            </div>
          ) : (
            emptyCard(t.chat.usageEmpty)
          ))}
      </div>
    </aside>
  );
}
