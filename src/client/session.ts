import type { GroupKind, GroupRole } from '../shared/types.js';

/** The signed-in user as GET /api/me describes them */
export interface MeUser {
  id: string;
  name: string;
  email: string | null;
  /** nickname, for those who signed up without an e-mail */
  login: string | null;
  telegramUsername: string | null;
  isAdmin: boolean;
}

/** How an account is shown under a name: its e-mail, nickname or Telegram */
export function accountLabel(u: {
  email: string | null;
  login?: string | null;
  telegramUsername: string | null;
}): string {
  return u.email ?? (u.login ? `ник ${u.login}` : u.telegramUsername ? `@${u.telegramUsername}` : 'Telegram');
}

export interface MyGroup {
  id: string;
  kind: GroupKind;
  name: string;
  role: GroupRole;
  memberCount: number;
}

export interface Me {
  user: MeUser | null;
  groups: MyGroup[];
  /** Every club (site admins only): organisers of championship stages */
  clubs?: { id: string; name: string }[];
  /** password: e-mail + password; email: one-time code by e-mail; telegram: through the bot */
  login: { password?: boolean; email: boolean; telegram: { bot: string } | null };
}

/**
 * Full address of a path inside the app. The site lives at `/` at home and at `/retrace/` behind
 * haproxy, so app paths are relative to the page (`api/…`, `?event=…`); a server-stored
 * `/uploads/…` also counts from the app, not the host. For places that need an absolute
 * address: links to copy, MapLibre and the worker.
 */
export function appUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).href;
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('api/me');
  if (!res.ok) throw new Error('Сервер недоступен');
  return res.json();
}

/** JSON request; throws the server's error message */
export async function api<T = unknown>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data as T;
}

export const ROLE_LABELS: Record<GroupRole, string> = {
  admin: 'админ',
  judge: 'судья / тренер',
  member: 'участник',
};
