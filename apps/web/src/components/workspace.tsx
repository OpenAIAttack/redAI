'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, obj, session, type Session } from '../lib/api';
import { Projects } from './projects';
import { Settings } from './settings';

export function Workspace({ view }: { view: string }) {
  const [owner, setOwner] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setOwner(session(await api('/auth/session')));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setOwner(null);
      else setError('Không kết nối được dịch vụ. Hãy thử tải lại.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 240_000);
    const focus = () => {
      void reload();
    };
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [reload]);
  const failure = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setOwner(null);
    setError(e instanceof Error ? e.message : 'Không thể hoàn tất yêu cầu.');
  }, []);
  useEffect(() => {
    if (!owner?.username) return;
    void api('/settings')
      .then((value) => {
        document.documentElement.dataset.theme =
          obj(obj(value).settings).theme === 'light' ? 'light' : 'dark';
      })
      .catch(() => {});
  }, [owner?.username]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      setOwner(
        session(
          await api('/auth/login', {
            method: 'POST',
            body: { username: data.get('username'), password: data.get('password') },
          }),
        ),
      );
    } catch (e) {
      failure(e);
    } finally {
      const input = form.elements.namedItem('password');
      if (input instanceof HTMLInputElement) input.value = '';
      setBusy(false);
    }
  }
  async function logout() {
    if (!owner) return;
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', { method: 'POST', csrf: owner.csrf });
      setOwner(null);
    } catch (e) {
      failure(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          red<span>AI</span>
          <small>PERSONAL WORKSPACE</small>
        </a>
        {owner && (
          <nav aria-label="Điều hướng chính">
            <a href="/" aria-current={view === 'projects' ? 'page' : undefined}>
              Dự án
            </a>
            <a href="/settings" aria-current={view === 'settings' ? 'page' : undefined}>
              Cài đặt
            </a>
            <button disabled={busy} onClick={() => void logout()}>
              Đăng xuất
            </button>
          </nav>
        )}
      </header>
      <main>
        {error && (
          <div className="notice error" role="alert">
            {error} <button onClick={() => void reload()}>Tải lại</button>
          </div>
        )}
        {loading ? (
          <p role="status">Đang kiểm tra phiên đăng nhập…</p>
        ) : !owner ? (
          <section className="login panel">
            <p className="eyebrow">KHÔNG GIAN RIÊNG CỦA BẠN</p>
            <h1>Chào mừng trở lại.</h1>
            <p>Đăng nhập để quản lý dự án và cấu hình redAI.</p>
            <form onSubmit={(e) => void login(e)}>
              <fieldset disabled={busy}>
                <label>
                  Tên đăng nhập
                  <input name="username" autoComplete="username" required maxLength={128} />
                </label>
                <label>
                  Mật khẩu
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                <button className="primary" type="submit">
                  {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
                </button>
              </fieldset>
            </form>
            <a href="/setup">Hướng dẫn cài đặt lần đầu</a>
            {view === 'setup' && (
              <div className="setup">
                <h2>Thiết lập chủ sở hữu</h2>
                <p>
                  Chủ sở hữu được tạo trên máy chạy redAI bằng lệnh bootstrap. Không có đăng ký công
                  khai hoặc mật khẩu mặc định.
                </p>
                <p>
                  Làm theo mục “Thiết lập lần đầu” trong README của dự án, lưu mã khôi phục an toàn,
                  rồi đăng nhập tại đây.
                </p>
              </div>
            )}
          </section>
        ) : view === 'settings' ? (
          <Settings owner={owner} onError={failure} />
        ) : (
          <Projects owner={owner} onError={failure} />
        )}
      </main>
      <footer>redAI Personal · Dữ liệu thuộc không gian của bạn</footer>
    </div>
  );
}
