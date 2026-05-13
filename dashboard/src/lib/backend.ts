export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ??
  'http://127.0.0.1:5001';

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  API_BASE.replace(/^http/, 'ws') + '/ws';

export async function fetchBackendData<T>(path: string): Promise<T[]> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${path}`);
  }

  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

export async function fetchBackendRecord<T>(path: string): Promise<Record<string, T>> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${path}`);
  }

  const body = await response.json();
  return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data
    : {};
}
