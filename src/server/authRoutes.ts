import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Viewer } from '../shared/access.js';
import { GROUP_ROLES, type GroupKind, type GroupRole } from '../shared/types.js';
import { cookiePath } from './proxy.js';
import {
  acceptInvite,
  changePassword,
  loginWithPassword,
  MIN_PASSWORD_LENGTH,
  registerWithPassword,
  setPasswordByEmail,
  allClubs,
  checkLoginCode,
  createGroup,
  createInvite,
  createSession,
  deleteGroup,
  deleteSession,
  findOrCreateEmailUser,
  groupMembers,
  inviteInfo,
  issueLoginCode,
  myGroups,
  otherAdmins,
  pollTelegramLogin,
  removeMember,
  renameGroup,
  renameUser,
  SESSION_MAX_AGE_SEC,
  sessionUser,
  setMemberRole,
  startTelegramLogin,
  userById,
  viewerOf,
  type AdminList,
  type User,
} from './accounts.js';
import type { Db } from './db.js';
import type { Mailer } from './mail.js';
import type { TelegramBot } from './telegram.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Signed-in user, or null */
    user: User | null;
    /** What access decisions are made from (anonymous when not signed in) */
    viewer: Viewer;
  }
}

const COOKIE = 'retrace_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthOptions {
  db: Db;
  mailer: Mailer;
  telegram: TelegramBot | null;
  admins: AdminList;
  /** Send the cookie only over HTTPS (COOKIE_SECURE=1 behind an HTTPS proxy) */
  secureCookie: boolean;
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string | null, secure: boolean) {
  const attrs = [
    `${COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    `Path=${cookiePath(reply.request.headers['x-forwarded-prefix'])}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${token ? SESSION_MAX_AGE_SEC : 0}`,
  ];
  if (secure) attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}

/** Small in-memory limiter: at most `max` hits per key per minute */
function limiter(max: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length <= max;
  };
}

export async function registerAuth(app: FastifyInstance, opts: AuthOptions) {
  const { db, mailer, telegram, admins, secureCookie } = opts;
  const emailLimit = limiter(5);
  const passwordLimit = limiter(10);
  const telegramLimit = limiter(10);

  app.decorateRequest('user', null);
  app.decorateRequest('viewer', null as unknown as Viewer);
  // Who is asking: the session cookie → user → roles in their clubs and families
  app.addHook('onRequest', async (req) => {
    req.user = null;
    if (req.url.startsWith('/api/')) {
      const token = readCookie(req, COOKIE);
      if (token) req.user = await sessionUser(db, token);
    }
    req.viewer = await viewerOf(db, req.user);
  });

  const signIn = async (reply: FastifyReply, userId: string) => {
    setSessionCookie(reply, await createSession(db, userId), secureCookie);
  };

  app.get('/api/me', async (req) => {
    const user = req.user;
    return {
      user: user && {
        id: user.id,
        name: user.name,
        email: user.email,
        telegramUsername: user.telegramUsername,
        isAdmin: user.isAdmin,
      },
      groups: user ? await myGroups(db, user.id) : [],
      // Site admins pick the organiser of a championship stage from every club
      clubs: user?.isAdmin ? await allClubs(db) : undefined,
      login: {
        password: true,
        email: mailer.enabled,
        telegram: telegram ? { bot: telegram.username } : null,
      },
    };
  });

  app.patch<{ Body: { name?: string } }>('/api/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Войдите' });
    const name = req.body?.name?.trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'Пустое имя' });
    await renameUser(db, req.user.id, name);
    return { ok: true };
  });

  // ---- Sign-up / sign-in with e-mail and password ----

  app.post<{ Body: { email?: string; name?: string; password?: string } }>(
    '/api/auth/register',
    async (req, reply) => {
      const email = req.body?.email?.trim().toLowerCase() ?? '';
      const name = req.body?.name?.trim() ?? '';
      const password = req.body?.password ?? '';
      if (!EMAIL_RE.test(email) || email.length > 200) {
        return reply.code(400).send({ error: 'Проверьте адрес почты' });
      }
      if (!name) return reply.code(400).send({ error: 'Введите имя' });
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
        return reply.code(400).send({ error: `Пароль — не короче ${MIN_PASSWORD_LENGTH} символов` });
      }
      if (!passwordLimit(req.ip)) return reply.code(429).send({ error: 'Слишком часто, подождите минуту' });
      const user = await registerWithPassword(db, email, name, password, admins);
      if (!user) return reply.code(409).send({ error: 'Этот адрес уже зарегистрирован — войдите' });
      await signIn(reply, user.id);
      return { ok: true };
    }
  );

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const email = req.body?.email?.trim().toLowerCase() ?? '';
    const password = req.body?.password ?? '';
    // Per address and per client: slows down password guessing
    if (!passwordLimit(req.ip) || !passwordLimit(`email:${email}`)) {
      return reply.code(429).send({ error: 'Слишком много попыток, подождите минуту' });
    }
    const user = email && password ? await loginWithPassword(db, email, password, admins) : null;
    if (!user) return reply.code(400).send({ error: 'Неверная почта или пароль' });
    await signIn(reply, user.id);
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>('/api/me/password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Войдите' });
    const next = req.body?.next ?? '';
    if (next.length < MIN_PASSWORD_LENGTH || next.length > 200) {
      return reply.code(400).send({ error: `Пароль — не короче ${MIN_PASSWORD_LENGTH} символов` });
    }
    if (!passwordLimit(`user:${req.user.id}`)) return reply.code(429).send({ error: 'Подождите минуту' });
    const ok = await changePassword(db, req.user.id, req.body?.current ?? '', next);
    if (!ok) return reply.code(400).send({ error: 'Текущий пароль неверный' });
    return { ok: true };
  });

  // Forgotten password: there is no e-mail to reset it by, a site admin sets a new one
  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/admin/set-password',
    async (req, reply) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: 'Только администратор сайта' });
      const password = req.body?.password ?? '';
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: `Пароль — не короче ${MIN_PASSWORD_LENGTH} символов` });
      }
      const ok = await setPasswordByEmail(db, req.body?.email ?? '', password);
      if (!ok) return reply.code(404).send({ error: 'Нет такого пользователя' });
      return { ok: true };
    }
  );

  // ---- Sign-in by e-mail code / Telegram bot (switched off at startup in index.ts, kept) ----

  app.post<{ Body: { email?: string } }>('/api/auth/email/start', async (req, reply) => {
    if (!mailer.enabled) return reply.code(400).send({ error: 'Вход по почте не настроен' });
    const email = req.body?.email?.trim().toLowerCase() ?? '';
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return reply.code(400).send({ error: 'Проверьте адрес почты' });
    }
    if (!emailLimit(req.ip)) return reply.code(429).send({ error: 'Слишком часто, подождите минуту' });
    const code = await issueLoginCode(db, email);
    if (!code) return reply.code(429).send({ error: 'Код уже отправлен — подождите минуту' });
    try {
      await mailer.sendLoginCode(email, code);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: 'Не удалось отправить письмо' });
    }
    return { ok: true };
  });

  app.post<{ Body: { email?: string; code?: string } }>(
    '/api/auth/email/verify',
    async (req, reply) => {
      const email = req.body?.email?.trim().toLowerCase() ?? '';
      const code = req.body?.code?.replace(/\D/g, '') ?? '';
      if (!EMAIL_RE.test(email) || code.length !== 6) {
        return reply.code(400).send({ error: 'Введите 6 цифр из письма' });
      }
      if (!(await checkLoginCode(db, email, code))) {
        return reply.code(400).send({ error: 'Неверный или устаревший код' });
      }
      const user = await findOrCreateEmailUser(db, email, admins);
      await signIn(reply, user.id);
      return { ok: true };
    }
  );

  app.post('/api/auth/telegram/start', async (req, reply) => {
    if (!telegram) return reply.code(400).send({ error: 'Вход через Telegram не настроен' });
    if (!telegramLimit(req.ip)) return reply.code(429).send({ error: 'Слишком часто' });
    const token = await startTelegramLogin(db);
    return { token, url: `https://t.me/${telegram.username}?start=${token}` };
  });

  app.get<{ Querystring: { token?: string } }>('/api/auth/telegram/poll', async (req, reply) => {
    const token = req.query.token ?? '';
    if (!token) return reply.code(400).send({ error: 'Нет токена' });
    const res = await pollTelegramLogin(db, token);
    if (res.status === 'done') {
      await signIn(reply, res.userId);
      return { status: 'done' };
    }
    return res;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) await deleteSession(db, token);
    setSessionCookie(reply, null, secureCookie);
    return { ok: true };
  });

  // ---- Clubs and families ----

  const roleIn = (req: FastifyRequest, groupId: string): GroupRole | undefined =>
    req.viewer.roles[groupId];
  const isGroupAdmin = (req: FastifyRequest, groupId: string) =>
    req.viewer.isAdmin || roleIn(req, groupId) === 'admin';

  app.post<{ Body: { kind?: GroupKind; name?: string } }>('/api/groups', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Войдите' });
    const kind = req.body?.kind;
    const name = req.body?.name?.trim().slice(0, 60);
    if (kind !== 'club' && kind !== 'family') return reply.code(400).send({ error: 'Клуб или семья?' });
    if (!name) return reply.code(400).send({ error: 'Введите название' });
    if (kind === 'club' && !req.user.isAdmin) {
      return reply.code(403).send({ error: 'Клубы создаёт администратор сайта' });
    }
    const id = await createGroup(db, kind, name, req.user.id);
    return { id, groups: await myGroups(db, req.user.id) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/groups/:id',
    async (req, reply) => {
      if (!isGroupAdmin(req, req.params.id)) return reply.code(403).send({ error: 'Нет прав' });
      const name = req.body?.name?.trim().slice(0, 60);
      if (!name) return reply.code(400).send({ error: 'Введите название' });
      await renameGroup(db, req.params.id, name);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    if (!isGroupAdmin(req, req.params.id)) return reply.code(403).send({ error: 'Нет прав' });
    await deleteGroup(db, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/members', async (req, reply) => {
    if (!req.viewer.isAdmin && !roleIn(req, req.params.id)) {
      return reply.code(403).send({ error: 'Нет прав' });
    }
    return { members: await groupMembers(db, req.params.id) };
  });

  app.patch<{ Params: { id: string; userId: string }; Body: { role?: GroupRole } }>(
    '/api/groups/:id/members/:userId',
    async (req, reply) => {
      const { id, userId } = req.params;
      if (!isGroupAdmin(req, id)) return reply.code(403).send({ error: 'Нет прав' });
      const role = req.body?.role;
      if (!role || !GROUP_ROLES.includes(role)) return reply.code(400).send({ error: 'Неизвестная роль' });
      if (role !== 'admin' && (await otherAdmins(db, id, userId)) === 0) {
        return reply.code(400).send({ error: 'Должен остаться хотя бы один админ' });
      }
      await setMemberRole(db, id, userId, role);
      return { members: await groupMembers(db, id) };
    }
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/groups/:id/members/:userId',
    async (req, reply) => {
      const { id, userId } = req.params;
      const self = req.user?.id === userId;
      if (!self && !isGroupAdmin(req, id)) return reply.code(403).send({ error: 'Нет прав' });
      if (roleIn(req, id) === 'admin' && self && (await otherAdmins(db, id, userId)) === 0) {
        return reply.code(400).send({ error: 'Сначала назначьте другого админа' });
      }
      await removeMember(db, id, userId);
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: { role?: GroupRole } }>(
    '/api/groups/:id/invites',
    async (req, reply) => {
      const { id } = req.params;
      if (!req.user || !isGroupAdmin(req, id)) return reply.code(403).send({ error: 'Нет прав' });
      const role = req.body?.role ?? 'member';
      if (!GROUP_ROLES.includes(role)) return reply.code(400).send({ error: 'Неизвестная роль' });
      return { token: await createInvite(db, id, role, req.user.id) };
    }
  );

  app.get<{ Params: { token: string } }>('/api/invites/:token', async (req, reply) => {
    const info = await inviteInfo(db, req.params.token);
    if (!info) return reply.code(404).send({ error: 'Приглашение устарело' });
    return { groupName: info.groupName, kind: info.kind, role: info.role };
  });

  app.post<{ Params: { token: string } }>('/api/invites/:token/accept', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Войдите' });
    const groupId = await acceptInvite(db, req.params.token, req.user.id);
    if (!groupId) return reply.code(404).send({ error: 'Приглашение устарело' });
    return { groupId, groups: await myGroups(db, req.user.id) };
  });

  return { userById: (id: string) => userById(db, id) };
}
