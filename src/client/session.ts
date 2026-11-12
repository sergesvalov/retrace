import type { GroupKind, GroupRole } from '../shared/types.js';

/** The signed-in user as GET /api/me describes them */
export interface MeUser {
  id: string;
  name: string;
  email: string | null;
  telegramUsername: string | null;
  isAdmin: boolean;
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

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/me');
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
