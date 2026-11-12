import crypto from 'node:crypto';
import type { Viewer } from '../shared/access.js';
import type { GroupKind, GroupRole } from '../shared/types.js';
import type { Db } from './db.js';

/** Users, sessions, clubs and families, invitations — the Postgres side of accounts */

export interface User {
  id: string;
  name: string;
  email: string | null;
  /** nickname to sign in with, for those who signed up without an e-mail */
  login: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  isAdmin: boolean;
}

export interface GroupInfo {
  id: string;
  kind: GroupKind;
  name: string;
  /** the current user's role in it */
  role: GroupRole;
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  name: string;
  role: GroupRole;
  email: string | null;
  login: string | null;
  telegramUsername: string | null;
}

const SESSION_DAYS = 90;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Nickname: 3–30 letters (any alphabet), digits, `_ . -`; never an `@`, so never an e-mail */
const NICK_RE = /^[\p{L}\p{N}_.-]{3,30}$/u;

/** What a person signs up and signs in with: an e-mail or a nickname */
export type LoginId = { email: string } | { nick: string };

/** `a@b.ru` → e-mail (lower case), `Anya_run` → nickname (as typed); null if it is neither */
export function parseLoginId(raw: string): LoginId | null {
  const s = raw.trim();
  if (s.includes('@')) {
    return EMAIL_RE.test(s) && s.length <= 200 ? { email: s.toLowerCase() } : null;
  }
  return NICK_RE.test(s) ? { nick: s } : null;
}

export function newId(bytes = 6): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  login: string | null;
  telegram_id: string | null;
  telegram_username: string | null;
  is_admin: boolean;
}

const USER_COLS =
  'id, name, email, login, telegram_id::text AS telegram_id, telegram_username, is_admin';

function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    login: r.login,
    telegramId: r.telegram_id,
    telegramUsername: r.telegram_username,
    isAdmin: r.is_admin,
  };
}

/** Site admins: listed in ADMIN_EMAILS / ADMIN_TELEGRAM_IDS, or the very first user */
export interface AdminList {
  emails: string[];
  telegramIds: string[];
}

export function adminListFromEnv(env = process.env): AdminList {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return { emails: list(env.ADMIN_EMAILS), telegramIds: list(env.ADMIN_TELEGRAM_IDS) };
}

async function grantAdminIfListed(db: Db, user: User, admins: AdminList): Promise<User> {
  const listed =
    (user.email && admins.emails.includes(user.email.toLowerCase())) ||
    (user.telegramId && admins.telegramIds.includes(user.telegramId));
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM users WHERE is_admin'
  );
  const noAdminYet = rows[0]?.n === '0';
  if (!user.isAdmin && (listed || noAdminYet)) {
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
    return { ...user, isAdmin: true };
  }
  return user;
}

export async function findOrCreateEmailUser(
  db: Db,
  email: string,
  admins: AdminList
): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const found = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [
    normalized,
  ]);
  let user = found.rows[0] ? toUser(found.rows[0]) : null;
  if (!user) {
    const name = normalized.split('@')[0].slice(0, 40) || 'Участник';
    const ins = await db.query<UserRow>(
      `INSERT INTO users (id, name, email) VALUES ($1, $2, $3) RETURNING ${USER_COLS}`,
      [newId(), name, normalized]
    );
    user = toUser(ins.rows[0]);
  }
  return grantAdminIfListed(db, user, admins);
}

export interface TelegramProfile {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export async function findOrCreateTelegramUser(
  db: Db,
  tg: TelegramProfile,
  admins: AdminList
): Promise<User> {
  const found = await db.query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE telegram_id = $1`,
    [tg.id]
  );
  let user = found.rows[0] ? toUser(found.rows[0]) : null;
  if (user) {
    if (tg.username && tg.username !== user.telegramUsername) {
      await db.query('UPDATE users SET telegram_username = $2 WHERE id = $1', [user.id, tg.username]);
      user = { ...user, telegramUsername: tg.username };
    }
  } else {
    const name =
      [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim().slice(0, 40) ||
      tg.username ||
      'Участник';
    const ins = await db.query<UserRow>(
      `INSERT INTO users (id, name, telegram_id, telegram_username)
       VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
      [newId(), name, tg.id, tg.username ?? null]
    );
    user = toUser(ins.rows[0]);
  }
  return grantAdminIfListed(db, user, admins);
}

// ---- Sign-up and sign-in with e-mail and password ----

export const MIN_PASSWORD_LENGTH = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scrypt(password: string, salt: Buffer, opts = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  );
}

/** "scrypt$N$r$p$salt$hash" (base64url): parameters travel with the hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  const { N, r, p } = SCRYPT;
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return crypto.timingSafeEqual(key, expected);
}

/** E-mail or nickname, whichever the text is: `$1` matches either (an e-mail always has an `@`) */
const BY_LOGIN = 'email = lower($1) OR lower(login) = lower($1)';

/** New account by e-mail or nickname; null if it is already taken */
export async function registerWithPassword(
  db: Db,
  id: LoginId,
  name: string,
  password: string,
  admins: AdminList
): Promise<User | null> {
  const key = 'email' in id ? id.email : id.nick;
  const taken = await db.query(`SELECT 1 FROM users WHERE ${BY_LOGIN}`, [key]);
  if (taken.rows.length > 0) return null;
  // No conflict target: a race on either unique key (e-mail, nickname) gives no row
  const ins = await db.query<UserRow>(
    `INSERT INTO users (id, name, email, login, password_hash) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING ${USER_COLS}`,
    [
      newId(),
      name.trim().slice(0, 40),
      'email' in id ? id.email : null,
      'nick' in id ? id.nick : null,
      await hashPassword(password),
    ]
  );
  if (!ins.rows[0]) return null;
  return grantAdminIfListed(db, toUser(ins.rows[0]), admins);
}

/** The user with this e-mail or nickname and password, or null */
export async function loginWithPassword(
  db: Db,
  login: string,
  password: string,
  admins: AdminList
): Promise<User | null> {
  const { rows } = await db.query<UserRow & { password_hash: string | null }>(
    `SELECT ${USER_COLS}, password_hash FROM users WHERE ${BY_LOGIN}`,
    [login.trim()]
  );
  const r = rows[0];
  if (!r?.password_hash || !(await verifyPassword(password, r.password_hash))) return null;
  return grantAdminIfListed(db, toUser(r), admins);
}

/** Change the password: the current one must match (if there is one) */
export async function changePassword(
  db: Db,
  userId: string,
  current: string,
  next: string
): Promise<boolean> {
  const { rows } = await db.query<{ password_hash: string | null }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  );
  const stored = rows[0]?.password_hash;
  if (stored && !(await verifyPassword(current, stored))) return false;
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(next)]);
  return true;
}

/** Site admin sets a new password for someone who forgot theirs (no e-mail to reset by) */
export async function setPasswordByLogin(db: Db, login: string, password: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET password_hash = $2 WHERE ${BY_LOGIN} RETURNING id`,
    [login.trim(), await hashPassword(password)]
  );
  // The old password may be known to someone else: every earlier sign-in ends
  if (rows[0]) await db.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
  return rows.length > 0;
}

export async function renameUser(db: Db, userId: string, name: string): Promise<void> {
  await db.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name]);
}

// ---- Sessions ----

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId]
  );
  return token;
}

export const SESSION_MAX_AGE_SEC = SESSION_DAYS * 24 * 3600;

export async function sessionUser(db: Db, token: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.name, u.email, u.login, u.telegram_id::text AS telegram_id, u.telegram_username,
            u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function viewerOf(db: Db, user: User | null): Promise<Viewer> {
  if (!user) return { id: null, isAdmin: false, roles: {} };
  const { rows } = await db.query<{ group_id: string; role: GroupRole }>(
    'SELECT group_id, role FROM group_members WHERE user_id = $1',
    [user.id]
  );
  return {
    id: user.id,
    isAdmin: user.isAdmin,
    roles: Object.fromEntries(rows.map((r) => [r.group_id, r.role])),
  };
}

// ---- Clubs and families ----

export async function groupKinds(db: Db): Promise<Record<string, GroupKind>> {
  const { rows } = await db.query<{ id: string; kind: GroupKind }>('SELECT id, kind FROM groups');
  return Object.fromEntries(rows.map((r) => [r.id, r.kind]));
}

export async function groupNames(db: Db): Promise<Record<string, string>> {
  const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM groups');
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

export async function myGroups(db: Db, userId: string): Promise<GroupInfo[]> {
  const { rows } = await db.query<{
    id: string;
    kind: GroupKind;
    name: string;
    role: GroupRole;
    members: string;
  }>(
    `SELECT g.id, g.kind, g.name, m.role,
            (SELECT count(*)::text FROM group_members x WHERE x.group_id = g.id) AS members
     FROM group_members m JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = $1
     ORDER BY g.kind, g.name`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    role: r.role,
    memberCount: Number(r.members),
  }));
}

/** All clubs (site admins manage them, and pick an organiser for a championship stage) */
export async function allClubs(db: Db): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM groups WHERE kind = 'club' ORDER BY name"
  );
  return rows;
}

export async function createGroup(
  db: Db,
  kind: GroupKind,
  name: string,
  creatorId: string
): Promise<string> {
  const id = newId();
  await db.tx(async (t) => {
    await t.query('INSERT INTO groups (id, kind, name, created_by) VALUES ($1, $2, $3, $4)', [
      id,
      kind,
      name,
      creatorId,
    ]);
    await t.query(
      "INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')",
      [id, creatorId]
    );
  });
  return id;
}

export async function renameGroup(db: Db, groupId: string, name: string): Promise<void> {
  await db.query('UPDATE groups SET name = $2 WHERE id = $1', [groupId, name]);
}

export async function deleteGroup(db: Db, groupId: string): Promise<void> {
  await db.query('DELETE FROM groups WHERE id = $1', [groupId]);
}

export async function groupMembers(db: Db, groupId: string): Promise<GroupMember[]> {
  const { rows } = await db.query<{
    user_id: string;
    name: string;
    role: GroupRole;
    email: string | null;
    login: string | null;
    telegram_username: string | null;
  }>(
    `SELECT m.user_id, u.name, m.role, u.email, u.login, u.telegram_username
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1
     ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'judge' THEN 1 ELSE 2 END, u.name`,
    [groupId]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    role: r.role,
    email: r.email,
    login: r.login,
    telegramUsername: r.telegram_username,
  }));
}

export async function setMemberRole(
  db: Db,
  groupId: string,
  userId: string,
  role: GroupRole
): Promise<void> {
  await db.query('UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2', [
    groupId,
    userId,
    role,
  ]);
}

export async function removeMember(db: Db, groupId: string, userId: string): Promise<void> {
  await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [
    groupId,
    userId,
  ]);
}

/** Admins left in the group if `userId` leaves (a group must keep one) */
export async function otherAdmins(db: Db, groupId: string, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM group_members
     WHERE group_id = $1 AND role = 'admin' AND user_id <> $2`,
    [groupId, userId]
  );
  return Number(rows[0]?.n ?? 0);
}

const INVITE_DAYS = 14;

export async function createInvite(
  db: Db,
  groupId: string,
  role: GroupRole,
  createdBy: string
): Promise<string> {
  const token = newToken();
  await db.query(
    `INSERT INTO group_invites (token, group_id, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days')`,
    [token, groupId, role, createdBy]
  );
  return token;
}

export async function inviteInfo(
  db: Db,
  token: string
): Promise<{ groupId: string; groupName: string; kind: GroupKind; role: GroupRole } | null> {
  const { rows } = await db.query<{ group_id: string; name: string; kind: GroupKind; role: GroupRole }>(
    `SELECT i.group_id, g.name, g.kind, i.role
     FROM group_invites i JOIN groups g ON g.id = i.group_id
     WHERE i.token = $1 AND i.expires_at > now()`,
    [token]
  );
  const r = rows[0];
  return r ? { groupId: r.group_id, groupName: r.name, kind: r.kind, role: r.role } : null;
}

/** Join by an invitation link; an existing member keeps the higher of the two roles */
export async function acceptInvite(db: Db, token: string, userId: string): Promise<string | null> {
  const info = await inviteInfo(db, token);
  if (!info) return null;
  await db.query(
    `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO UPDATE SET role =
       CASE WHEN group_members.role = 'admin' OR EXCLUDED.role = 'member' THEN group_members.role
            WHEN group_members.role = 'judge' AND EXCLUDED.role = 'judge' THEN 'judge'
            ELSE EXCLUDED.role END`,
    [info.groupId, userId, info.role]
  );
  return info.groupId;
}

export async function userNames(db: Db, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = ANY($1)',
    [ids]
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

// ---- Login by e-mail code ----

const CODE_MINUTES = 15;
const CODE_RESEND_SEC = 60;
const CODE_ATTEMPTS = 5;

/** New 6-digit code for the address, or null if one was sent less than a minute ago */
export async function issueLoginCode(db: Db, email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await db.query<{ recent: boolean }>(
    `SELECT sent_at > now() - interval '${CODE_RESEND_SEC} seconds' AS recent
     FROM login_codes WHERE email = $1`,
    [normalized]
  );
  if (rows[0]?.recent) return null;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `INSERT INTO login_codes (email, code_hash, sent_at, expires_at, attempts)
     VALUES ($1, $2, now(), now() + interval '${CODE_MINUTES} minutes', 0)
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, sent_at = now(),
       expires_at = EXCLUDED.expires_at, attempts = 0`,
    [normalized, sha256(`${normalized}:${code}`)]
  );
  return code;
}

/** true once for the right code; a few wrong tries burn it */
export async function checkLoginCode(db: Db, email: string, code: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await db.query<{ code_hash: string; attempts: number; valid: boolean }>(
    `SELECT code_hash, attempts, expires_at > now() AS valid FROM login_codes WHERE email = $1`,
    [normalized]
  );
  const r = rows[0];
  if (!r || !r.valid || r.attempts >= CODE_ATTEMPTS) return false;
  const ok = r.code_hash === sha256(`${normalized}:${code.trim()}`);
  if (ok) await db.query('DELETE FROM login_codes WHERE email = $1', [normalized]);
  else await db.query('UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1', [normalized]);
  return ok;
}

// ---- Login through the Telegram bot ----

const TELEGRAM_LOGIN_MINUTES = 10;

export async function startTelegramLogin(db: Db): Promise<string> {
  const token = newToken().slice(0, 32);
  await db.query(
    `INSERT INTO telegram_logins (token, expires_at)
     VALUES ($1, now() + interval '${TELEGRAM_LOGIN_MINUTES} minutes')`,
    [token]
  );
  return token;
}

/** The bot got "/start <token>" from this Telegram user */
export async function confirmTelegramLogin(
  db: Db,
  token: string,
  tg: TelegramProfile,
  admins: AdminList
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT expires_at > now() AND user_id IS NULL AS ok FROM telegram_logins WHERE token = $1`,
    [token]
  );
  if (!rows[0]?.ok) return false;
  const user = await findOrCreateTelegramUser(db, tg, admins);
  await db.query('UPDATE telegram_logins SET user_id = $2 WHERE token = $1', [token, user.id]);
  return true;
}

/** The browser asks whether the bot has confirmed: the user id once (the token is spent) */
export async function pollTelegramLogin(
  db: Db,
  token: string
): Promise<{ status: 'pending' | 'expired' } | { status: 'done'; userId: string }> {
  const { rows } = await db.query<{ user_id: string | null; valid: boolean }>(
    'SELECT user_id, expires_at > now() AS valid FROM telegram_logins WHERE token = $1',
    [token]
  );
  const r = rows[0];
  if (!r || !r.valid) return { status: 'expired' };
  if (!r.user_id) return { status: 'pending' };
  await db.query('DELETE FROM telegram_logins WHERE token = $1', [token]);
  return { status: 'done', userId: r.user_id };
}

export async function userById(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

/** Old sessions, codes and logins */
export async function cleanupExpired(db: Db): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query("DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'");
  await db.query('DELETE FROM telegram_logins WHERE expires_at < now()');
  await db.query('DELETE FROM group_invites WHERE expires_at < now()');
}
