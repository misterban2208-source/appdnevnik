import type { SyncRequest, SyncResponse } from '@dnevnik/shared';
import { initData } from './telegram.ts';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const data = initData();
  if (data) headers.Authorization = `tma ${data}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

export const api = {
  sync: (body: SyncRequest) => request<SyncResponse>('/api/sync', { method: 'POST', body: JSON.stringify(body) }),
  exportNotes: () => request<{ ok: boolean; count: number }>('/api/export/notes', { method: 'POST' }),
  health: () => request<{ ok: boolean }>('/api/health'),
};
