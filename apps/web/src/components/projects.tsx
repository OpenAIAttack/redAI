'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, items, obj, revision, str, type Session } from '../lib/api';
import { ProjectDetail } from './project-detail';
type Project = {
  id: string;
  name: string;
  description: string;
  status: string;
  revision: number;
  isInbox: boolean;
  dataMode: string;
  approvalMode: string;
};
export function project(v: unknown): Project {
  const p = obj(v);
  return {
    id: str(p.id),
    name: str(p.name),
    description: str(p.description),
    status: str(p.status),
    revision: revision(p.revision),
    isInbox: p.is_inbox === true,
    dataMode: str(p.data_mode),
    approvalMode: str(p.approval_mode),
  };
}
export function Projects({ owner, onError }: { owner: Session; onError: (e: unknown) => void }) {
  const [list, setList] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const load = useCallback(
    async (next?: string) => {
      setLoading(true);
      try {
        const data = obj(
          await api(`/projects${next ? `?cursor=${encodeURIComponent(next)}` : ''}`),
        );
        const rows = items(data).map(project);
        setList((old) => (next ? [...old, ...rows] : rows));
        setCursor(data.next_cursor == null ? null : str(data.next_cursor));
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setNotice('');
    try {
      const created = project(
        await api('/projects', {
          method: 'POST',
          csrf: owner.csrf,
          body: { name: data.get('name'), description: data.get('description') },
        }),
      );
      await load();
      setSelected(created.id);
      form.reset();
      setNotice('Đã tạo dự án.');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  const current = list.find((p) => p.id === selected);
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">KHÔNG GIAN LÀM VIỆC</p>
          <h1>Dự án của bạn</h1>
          <p>Tổ chức hội thoại, ghi chú và tài liệu theo từng dự án.</p>
        </div>
        <span className="badge">{owner.username}</span>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <div className="columns">
        <aside className="panel">
          <h2>Dự án</h2>
          {loading && <p role="status">Đang tải dự án…</p>}
          {!loading && list.length === 0 && <p>Chưa có dự án nào.</p>}
          <div className="project-list">
            {list.map((p) => (
              <button
                className={p.id === selected ? 'selected' : ''}
                key={p.id}
                onClick={() => setSelected(p.id)}
              >
                <strong>{p.name}</strong>
                <small>
                  {p.isInbox
                    ? 'Hộp thư đến'
                    : p.status === 'archived'
                      ? 'Đã lưu trữ'
                      : 'Đang hoạt động'}
                </small>
              </button>
            ))}
          </div>
          {cursor && (
            <button disabled={loading} onClick={() => void load(cursor)}>
              Tải thêm dự án
            </button>
          )}
          <details>
            <summary>Tạo dự án</summary>
            <form onSubmit={(e) => void create(e)}>
              <fieldset disabled={busy}>
                <label>
                  Tên dự án
                  <input name="name" required maxLength={120} />
                </label>
                <label>
                  Mô tả
                  <textarea name="description" maxLength={4000} />
                </label>
                <button className="primary">{busy ? 'Đang tạo…' : 'Tạo dự án'}</button>
              </fieldset>
            </form>
          </details>
        </aside>
        {current ? (
          <ProjectDetail
            key={current.id}
            current={current}
            owner={owner}
            onError={onError}
            onChange={() => load()}
          />
        ) : (
          <section className="panel empty">
            <span className="empty-symbol">＋</span>
            <h2>Một nơi cho từng mục tiêu.</h2>
            <p>Chọn dự án bên trái hoặc tạo dự án đầu tiên để bắt đầu.</p>
          </section>
        )}
      </div>
    </>
  );
}
export type { Project };
