'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, items, obj, revision, str, type Session } from '../lib/api';
import type { Project } from './projects';

type Row = Record<string, unknown>;
export function ProjectDetail({
  current,
  owner,
  onError,
  onChange,
}: {
  current: Project;
  owner: Session;
  onError: (e: unknown) => void;
  onChange: () => Promise<void>;
}) {
  const base = `/projects/${encodeURIComponent(current.id)}`;
  const [chats, setChats] = useState<Row[]>([]);
  const [notes, setNotes] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, n] = await Promise.all([api(`${base}/chats`), api(`${base}/notes`)]);
      setChats(items(c));
      setNotes(items(n));
      const next = obj(c).next_cursor;
      setCursor(next == null ? null : str(next));
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [base, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setNotice('');
    try {
      await api(path, { method, body, csrf: owner.csrf });
      setNotice('Đã lưu thay đổi.');
      await Promise.all([load(), onChange()]);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  function submit(
    e: FormEvent<HTMLFormElement>,
    path: string,
    method: string,
    fields: (f: FormData) => unknown,
  ) {
    e.preventDefault();
    void mutate(path, method, fields(new FormData(e.currentTarget)));
  }
  return (
    <section className="panel detail">
      <div className="section-title">
        <div>
          <p className="eyebrow">DỰ ÁN</p>
          <h2>{current.name}</h2>
        </div>
        <span className="badge">
          {current.status === 'active'
            ? 'Đang hoạt động'
            : current.status === 'archived'
              ? 'Đã lưu trữ'
              : 'Đang xóa'}
        </span>
      </div>
      <p>{current.description || 'Chưa có mô tả.'}</p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading && <p role="status">Đang tải nội dung…</p>}
      <details>
        <summary>Cấu hình dự án</summary>
        <form
          key={current.revision}
          onSubmit={(e) =>
            submit(e, base, 'PATCH', (f) => ({
              expected_revision: current.revision,
              name: f.get('name'),
              description: f.get('description'),
              data_mode: f.get('data_mode'),
              approval_mode: f.get('approval_mode'),
            }))
          }
        >
          <fieldset disabled={busy || current.status !== 'active'}>
            <label>
              Tên dự án
              <input name="name" required maxLength={120} defaultValue={current.name} />
            </label>
            <label>
              Mô tả
              <textarea name="description" defaultValue={current.description} maxLength={4000} />
            </label>
            <label>
              Dữ liệu gửi model
              <select name="data_mode" defaultValue={current.dataMode}>
                <option value="local_only">Chỉ local</option>
                <option value="redacted_cloud">Cloud với dữ liệu đã che</option>
                <option value="cloud_full">Cloud — nội dung được chọn</option>
              </select>
            </label>
            <label>
              Phê duyệt
              <select name="approval_mode" defaultValue={current.approvalMode}>
                <option value="always_ask">Luôn hỏi</option>
                <option value="ask_high_risk">Hỏi khi rủi ro cao</option>
                <option value="automatic">Tự động trong phạm vi được cấp</option>
                <option value="reject">Từ chối</option>
              </select>
            </label>
            <button>Lưu cấu hình</button>
          </fieldset>
        </form>
        {!current.isInbox && (
          <button
            disabled={busy}
            onClick={() =>
              void mutate(
                `${base}/${current.status === 'archived' ? 'unarchive' : 'archive'}`,
                'POST',
              )
            }
          >
            {current.status === 'archived' ? 'Khôi phục dự án' : 'Lưu trữ dự án'}
          </button>
        )}
      </details>
      <h3>Hội thoại</h3>
      {!loading && chats.length === 0 && <p>Chưa có hội thoại.</p>}
      {chats.map((c) => (
        <form
          className="row"
          key={`${str(c.id)}-${revision(c.revision)}`}
          onSubmit={(e) =>
            submit(e, `${base}/chats/${str(c.id)}`, 'PATCH', (f) => ({
              expected_revision: revision(c.revision),
              title: f.get('title'),
              pinned: f.get('pinned') === 'on',
            }))
          }
        >
          <fieldset disabled={busy}>
            <label>
              Tên hội thoại
              <input name="title" defaultValue={str(c.title)} required maxLength={200} />
            </label>
            <label className="check">
              <input name="pinned" type="checkbox" defaultChecked={c.pinned === true} />
              Ghim
            </label>
            <button>Lưu hội thoại</button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Xóa hội thoại này?'))
                  void mutate(`${base}/chats/${str(c.id)}`, 'DELETE');
              }}
            >
              Xóa
            </button>
          </fieldset>
        </form>
      ))}
      {cursor && (
        <button
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void api(`${base}/chats?cursor=${encodeURIComponent(cursor)}`)
              .then((data) => {
                setChats((old) => [...old, ...items(data)]);
                const next = obj(data).next_cursor;
                setCursor(next == null ? null : str(next));
              })
              .catch(onError)
              .finally(() => setLoading(false));
          }}
        >
          Tải thêm hội thoại
        </button>
      )}
      <form
        onSubmit={(e) => submit(e, `${base}/chats`, 'POST', (f) => ({ title: f.get('title') }))}
      >
        <fieldset disabled={busy || current.status !== 'active'}>
          <label>
            Hội thoại mới
            <input name="title" required maxLength={200} />
          </label>
          <button>Tạo hội thoại</button>
        </fieldset>
      </form>
      <p className="hint">Chức năng gửi tin nhắn Ask/Agent chưa sẵn sàng.</p>
      <h3>Ghi chú</h3>
      {!loading && notes.length === 0 && <p>Chưa có ghi chú.</p>}
      {notes.map((n) => (
        <form
          className="note"
          key={`${str(n.id)}-${revision(n.revision)}`}
          onSubmit={(e) =>
            submit(e, `${base}/notes/${str(n.id)}`, 'PATCH', (f) => ({
              expected_revision: revision(n.revision),
              title: f.get('title'),
              content: f.get('content'),
              selected_for_context: f.get('selected') === 'on',
            }))
          }
        >
          <fieldset disabled={busy}>
            <label>
              Tiêu đề ghi chú
              <input name="title" defaultValue={str(n.title)} required />
            </label>
            <label>
              Nội dung
              <textarea name="content" defaultValue={str(n.content)} required />
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="selected"
                defaultChecked={n.selected_for_context === true}
              />
              Chọn làm ngữ cảnh
            </label>
            <button>Lưu ghi chú</button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Xóa ghi chú này?'))
                  void mutate(`${base}/notes/${str(n.id)}`, 'DELETE');
              }}
            >
              Xóa ghi chú
            </button>
          </fieldset>
        </form>
      ))}
      <details>
        <summary>Thêm ghi chú</summary>
        <form
          onSubmit={(e) =>
            submit(e, `${base}/notes`, 'POST', (f) => ({
              title: f.get('title'),
              content: f.get('content'),
              selected_for_context: f.get('selected') === 'on',
            }))
          }
        >
          <fieldset disabled={busy || current.status !== 'active'}>
            <label>
              Tiêu đề mới
              <input name="title" required maxLength={200} />
            </label>
            <label>
              Nội dung mới
              <textarea name="content" required maxLength={100000} />
            </label>
            <label className="check">
              <input name="selected" type="checkbox" />
              Chọn làm ngữ cảnh
            </label>
            <button>Tạo ghi chú</button>
          </fieldset>
        </form>
      </details>
    </section>
  );
}
