import type { SyncRequest, SyncResponse, VoiceNote } from '@dnevnik/shared';
import { initData } from './telegram.ts';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Raw response body when one was read (the voice routes answer `{error}` codes). */
    public body = '',
    /** Milliseconds from a Retry-After header, when the server sent one. */
    public retryAfter: number | null = null,
  ) {
    super(message);
  }

  /** `{error:'code'}` bodies as one word; '' otherwise. */
  get code(): string {
    try {
      const parsed = JSON.parse(this.body) as { error?: unknown };
      return typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      return '';
    }
  }
}

function authHeader(): Record<string, string> {
  const data = initData();
  return data ? { Authorization: `tma ${data}` } : {};
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeader() };
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status} ${body}`, body, parseRetryAfter(res.headers.get('retry-after')));
  }
  return (await res.json()) as T;
}

/**
 * PUT the raw bytes of a voice note. XHR instead of fetch because only XHR reports upload progress.
 * Rejects with ApiError; status 0 means the request never reached the server (offline, aborted).
 */
function uploadVoice(note: VoiceNote, bytes: ArrayBuffer, onProgress?: (ratio: number) => void): Promise<{ note: VoiceNote }> {
  const q = new URLSearchParams({
    date: note.date,
    section: note.section,
    duration: String(note.duration),
    createdAt: String(note.createdAt),
    peaks: note.peaks,
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}/api/voice/${note.id}/blob?${q.toString()}`);
    for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Content-Type', note.mime);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      const body = typeof xhr.response === 'string' ? xhr.response : '';
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(body) as { note: VoiceNote });
        } catch {
          reject(new ApiError(xhr.status, 'bad json', body));
        }
        return;
      }
      reject(new ApiError(xhr.status, `${xhr.status} ${body}`, body, parseRetryAfter(xhr.getResponseHeader('retry-after'))));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted'));
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout'));
    xhr.send(bytes);
  });
}

async function downloadVoice(id: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/voice/${id}/blob`, { headers: authHeader() });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status} ${body}`, body);
  }
  return res.arrayBuffer();
}

export const api = {
  sync: (body: SyncRequest) => request<SyncResponse>('/api/sync', { method: 'POST', body: JSON.stringify(body) }),
  exportNotes: () => request<{ ok: boolean; count: number }>('/api/export/notes', { method: 'POST' }),
  health: () => request<{ ok: boolean }>('/api/health'),
  uploadVoice,
  downloadVoice,
  sendVoice: (id: string) => request<{ ok: boolean }>(`/api/voice/${id}/send`, { method: 'POST' }),
};
