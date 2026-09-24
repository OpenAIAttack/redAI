'use client';

/**
 * Workers overview. There is no owner-facing global worker-list API yet, so this
 * page is an honest information screen rather than a fabricated list. It also
 * clarifies the "local worker" vs "local model" distinction (task requirement):
 * a worker is a Go task-runner; a local model is an inference engine — different
 * things. Per-project worker bindings live in each project's settings.
 */
import { useI18n } from '../../../i18n/index';

export default function WorkersPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="content stack">
      <h1>{t.workers.title}</h1>
      <div className="banner banner-info" role="note">
        {t.workers.intro}
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 18 }}>{t.workers.enrollHeading}</h2>
        <p className="muted">{t.workers.enrollBody}</p>
      </div>
      <div className="card muted">{t.workers.noList}</div>
    </div>
  );
}
