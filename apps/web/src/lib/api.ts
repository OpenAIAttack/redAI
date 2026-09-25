export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {},
): Promise<unknown> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      ...(options.method && options.method !== 'GET'
        ? { 'idempotency-key': options.idempotencyKey ?? crypto.randomUUID() }
        : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.',
      403: 'Yêu cầu chưa được xác thực. Hãy tải lại trang rồi thử lại.',
      404: 'Không tìm thấy dữ liệu hoặc chức năng chưa được cấu hình.',
      409: 'Dữ liệu đã thay đổi. Hãy tải lại trước khi lưu.',
      422: 'Dữ liệu chưa hợp lệ. Hãy kiểm tra các trường nhập.',
      429: 'Bạn thử quá nhiều lần. Vui lòng chờ một lúc.',
      503: 'Dịch vụ hoặc kho khóa chưa sẵn sàng.',
    };
    throw new ApiError(
      response.status,
      messages[response.status] ?? 'Không thể hoàn tất yêu cầu. Hãy thử lại.',
    );
  }
  return response.status === 204 ? null : response.json();
}
export function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error('Phản hồi không hợp lệ.');
  return v as Record<string, unknown>;
}
export function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Phản hồi không hợp lệ.');
  return v;
}
export function revision(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1)
    throw new Error('Phiên bản dữ liệu không hợp lệ.');
  return n;
}
export function items(v: unknown): Record<string, unknown>[] {
  const list = obj(v).items;
  if (!Array.isArray(list)) throw new Error('Danh sách không hợp lệ.');
  return list.map(obj);
}
export interface Session {
  username: string;
  csrf: string;
}
export function session(v: unknown): Session {
  const data = obj(v);
  return { username: str(data.username), csrf: str(data.csrf_token) };
}
