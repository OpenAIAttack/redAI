'use client';
import { useCallback, useEffect, useState, useRef, type FormEvent } from 'react';
import { api, items, obj, revision, str, type Session } from '../lib/api';
type Row = Record<string, unknown>;
export function Settings({ owner, onError }: { owner: Session; onError: (e: unknown) => void }) {
  const [sessions, setSessions] = useState<Row[]>([]);
  const [providers, setProviders] = useState<Row[]>([]);
  const [secrets, setSecrets] = useState<Row[]>([]);
  const [settings, setSettings] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const probeKeys = useRef(new Map<string, string>());
  const [probing, setProbing] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s, w, sessionsData] = await Promise.all([
        api('/settings/providers'),
        api('/settings/secrets'),
        api('/settings'),
        api('/auth/sessions'),
      ]);
      setProviders(items(p));
      setSecrets(items(s));
      setSettings(obj(w));
      setSessions(items(sessionsData));
      document.documentElement.dataset.theme =
        obj(obj(w).settings).theme === 'light' ? 'light' : 'dark';
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setNotice('');
    try {
      await api(path, { method, csrf: owner.csrf, body });
      setNotice('Đã lưu thay đổi.');
      await load();
      if (path === '/auth/password') window.location.assign('/login');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await mutate('/settings/providers', 'POST', {
        display_name: f.get('display_name'),
        api_key: f.get('api_key') || undefined,
        config: {
          adapter_kind: 'chat_completions_compatible',
          max_output_tokens: Number(f.get('max_output_tokens')),
          base_url: f.get('base_url'),
          model_id: f.get('model_id'),
          allowed_data_modes: [f.get('mode')],
        },
      });
    } finally {
      const key = form.elements.namedItem('api_key');
      if (key instanceof HTMLInputElement) key.value = '';
    }
  }
  async function probe(provider: Row) {
    const id = str(provider.id);
    const version = revision(provider.revision);
    const scope = `${id}:${version}`;
    if (
      !window.confirm(
        'Kiểm tra model bằng 5 yêu cầu dữ liệu mẫu, tối đa 64 token đầu ra mỗi yêu cầu? Có thể phát sinh phí. Không gửi dữ liệu dự án.',
      )
    )
      return;
    // Preserve key on uncertain network errors; a repeated click cannot double-spend.
    const key = probeKeys.current.get(scope) ?? crypto.randomUUID();
    probeKeys.current.set(scope, key);
    setBusy(true);
    setProbing(id);
    setNotice('');
    try {
      const result = obj(
        await api(`/providers/${id}/probe`, {
          method: 'POST',
          csrf: owner.csrf,
          idempotencyKey: key,
          body: { confirmed: true, expected_revision: version },
        }),
      );
      setNotice(
        result.status === 'passed'
          ? 'Đã kiểm chứng khả năng model bằng dữ liệu mẫu.'
          : 'Kiểm tra chưa đạt. Xem kết quả của model bên dưới.',
      );
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      setProbing(null);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">CẤU HÌNH KHÔNG GIAN</p>
          <h1>Cài đặt</h1>
          <p>Quản lý model, khóa truy cập và tùy chọn của bạn.</p>
        </div>
      </div>
      {loading && <p role="status">Đang tải cài đặt…</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="settings-grid">
        <section className="panel">
          <h2>Model của bạn</h2>
          <p className="hint">
            Lưu cấu hình không gửi yêu cầu đến model. Kết nối chưa kiểm chứng sẽ hiển thị rõ bên
            dưới.
          </p>
          {!loading && providers.length === 0 && <p>Chưa cấu hình model nào.</p>}
          {providers.map((p) => (
            <article className="provider" key={str(p.id)}>
              <h3>{str(p.display_name)}</h3>
              <p>{str(obj(p.config).model_id ?? 'Chưa chọn model')}</p>
              <span className="badge">
                {p.probe_status === 'not_tested' ? 'Chưa kiểm chứng kết nối' : str(p.probe_status)}
              </span>
              <button disabled={busy || p.enabled !== true} onClick={() => void probe(p)}>
                {probing === p.id ? 'Đang kiểm tra model…' : 'Kiểm tra model'}
              </button>
              {p.probe_result != null && (
                <div className="hint">
                  <p>
                    Tool calls: {obj(p.probe_result).supports_tools === true ? 'Đạt' : 'Chưa đạt'} ·
                    Streaming:{' '}
                    {obj(p.probe_result).supports_streaming === true ? 'Đạt' : 'Chưa đạt'}
                  </p>
                  <p>
                    JSON có schema:{' '}
                    {obj(p.probe_result).supports_structured_output === true ? 'Đạt' : 'Chưa đạt'} ·
                    Hủy kết nối:{' '}
                    {obj(p.probe_result).cancellation_observed === true
                      ? 'Đã kiểm tra'
                      : 'Chưa kiểm chứng'}
                  </p>
                  <p>
                    {obj(p.probe_result).usage_observed === true
                      ? 'Provider có trả usage cho ít nhất một yêu cầu; tổng phí chưa xác định.'
                      : 'Provider không trả usage; chi phí chưa xác định.'}
                  </p>
                  <p>
                    Kiểm tra lúc {str(obj(p.probe_result).checked_at)}
                    {obj(p.probe_result).error_code
                      ? ` · ${str(obj(p.probe_result).error_code)}`
                      : ''}
                  </p>
                </div>
              )}
              <p>{p.credential ? 'Đã lưu khóa · ••••••••' : 'Không có khóa truy cập'}</p>
              <p className="hint">
                {Array.isArray(obj(p.config).allowed_data_modes)
                  ? obj(p.config).allowed_data_modes?.toString()
                  : 'Chưa chọn chế độ dữ liệu'}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void mutate(`/settings/providers/${str(p.id)}`, 'PATCH', {
                    expected_revision: revision(p.revision),
                    enabled: p.enabled !== true,
                  })
                }
              >
                {p.enabled === true ? 'Tắt model' : 'Bật model'}
              </button>
            </article>
          ))}
          <details>
            <summary>Thêm model</summary>
            <form onSubmit={(e) => void create(e)}>
              <fieldset disabled={busy || loading}>
                <label>
                  Tên hiển thị
                  <input name="display_name" required maxLength={120} />
                </label>
                <label>
                  Địa chỉ API
                  <input
                    name="base_url"
                    type="url"
                    placeholder="https://provider.example/v1"
                    required
                  />
                </label>
                <label>
                  Model ID
                  <input name="model_id" required maxLength={200} />
                </label>
                <label>
                  Giới hạn token đầu ra
                  <input
                    name="max_output_tokens"
                    type="number"
                    min={128}
                    max={65536}
                    defaultValue={1024}
                    required
                  />
                </label>
                <label>
                  API key
                  <input
                    name="api_key"
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                  />
                </label>
                <label>
                  Chế độ dữ liệu
                  <select name="mode" defaultValue="redacted_cloud">
                    <option value="redacted_cloud">Cloud với dữ liệu đã che</option>
                    <option value="local_only">Chỉ endpoint local đã được duyệt</option>
                    <option value="cloud_full">Cloud — nội dung được chọn</option>
                  </select>
                </label>
                <button className="primary">{busy ? 'Đang lưu…' : 'Lưu model'}</button>
              </fieldset>
            </form>
          </details>
        </section>
        <div>
          <section className="panel">
            <h2>Bảo mật tài khoản</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                void mutate('/auth/password', 'POST', {
                  current_password: f.get('current_password'),
                  new_password: f.get('new_password'),
                }).finally(() => form.reset());
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  Mật khẩu hiện tại
                  <input
                    name="current_password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={1024}
                  />
                </label>
                <label>
                  Mật khẩu mới
                  <input
                    name="new_password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={1024}
                  />
                </label>
                <p className="hint">Đổi mật khẩu sẽ kết thúc mọi phiên đăng nhập.</p>
                <button>Đổi mật khẩu</button>
              </fieldset>
            </form>
            <h3>Phiên đăng nhập</h3>
            {sessions.map((s) => (
              <div className="secret" key={str(s.id)}>
                <p>
                  {s.current ? 'Phiên hiện tại' : 'Phiên khác'} ·{' '}
                  {s.revoked_at ? 'Đã kết thúc' : 'Đang hoạt động'}
                </p>
                <small>{new Date(str(s.created_at)).toLocaleString('vi-VN')}</small>
                <button
                  disabled={busy || !!s.revoked_at}
                  onClick={() => void mutate(`/auth/sessions/${str(s.id)}/revoke`, 'POST')}
                >
                  Kết thúc phiên
                </button>
              </div>
            ))}
            <h2>Tùy chọn</h2>
            {settings && (
              <form
                key={revision(settings.revision)}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void mutate('/settings', 'PUT', {
                    expected_revision: revision(settings.revision),
                    settings: {
                      ...obj(settings.settings),
                      theme: f.get('theme'),
                      language: f.get('language'),
                    },
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <label>
                    Giao diện
                    <select
                      name="theme"
                      defaultValue={String(obj(settings.settings).theme ?? 'dark')}
                    >
                      <option value="dark">Tối</option>
                      <option value="light">Sáng</option>
                    </select>
                  </label>
                  <label>
                    Ngôn ngữ ưu tiên
                    <select
                      name="language"
                      defaultValue={String(obj(settings.settings).language ?? 'vi')}
                    >
                      <option value="vi">Tiếng Việt</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <button>Lưu tùy chọn</button>
                </fieldset>
              </form>
            )}
          </section>
          <section className="panel">
            <h2>Khóa truy cập</h2>
            <p className="hint">Giá trị khóa không được trả lại trình duyệt.</p>
            {!loading && secrets.length === 0 && <p>Chưa lưu khóa nào.</p>}
            {secrets.map((s) => (
              <div className="secret" key={str(s.id)}>
                <strong>{str(s.name)}</strong>
                <p>{s.revoked_at ? 'Đã thu hồi' : 'Đang hoạt động'} · ••••••••</p>
                <button
                  disabled={busy || !!s.revoked_at}
                  onClick={() => {
                    if (
                      window.confirm('Thu hồi khóa này? Model sử dụng khóa sẽ không thể kết nối.')
                    )
                      void mutate(`/settings/secrets/${str(s.id)}`, 'DELETE');
                  }}
                >
                  Thu hồi khóa
                </button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
}
