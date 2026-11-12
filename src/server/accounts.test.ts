import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvite,
  changePassword,
  checkLoginCode,
  loginWithPassword,
  registerWithPassword,
  setPasswordByEmail,
  confirmTelegramLogin,
  createGroup,
  createInvite,
  createSession,
  deleteSession,
  findOrCreateEmailUser,
  issueLoginCode,
  myGroups,
  pollTelegramLogin,
  sessionUser,
  startTelegramLogin,
  viewerOf,
} from './accounts.js';
import { migrate, openPglite, type Db } from './db.js';
import { deleteEvent, eventCount, importEvents, loadEvents, saveEvent, saveTrack } from './store.js';
import type { RaceEvent } from '../shared/types.js';

let db: Db;
const admins = { emails: ['boss@club.ru'], telegramIds: [] as string[] };

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  // a second run must be a no-op
  await migrate(db);
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe('accounts', () => {
  it('the first user becomes a site admin; others do not unless listed', async () => {
    const first = await findOrCreateEmailUser(db, 'First@Mail.ru', admins);
    expect(first.isAdmin).toBe(true);
    expect(first.email).toBe('first@mail.ru');
    const second = await findOrCreateEmailUser(db, 'second@mail.ru', admins);
    expect(second.isAdmin).toBe(false);
    const listed = await findOrCreateEmailUser(db, 'boss@club.ru', admins);
    expect(listed.isAdmin).toBe(true);
    // the same address is the same user
    expect((await findOrCreateEmailUser(db, 'second@MAIL.ru', admins)).id).toBe(second.id);
  });

  it('sign-up and sign-in with a password; the address is unique; passwords are hashed', async () => {
    const u = await registerWithPassword(db, 'Pass@Mail.ru', 'Аня', 'correct horse', admins);
    expect(u?.name).toBe('Аня');
    expect(await registerWithPassword(db, 'pass@mail.ru', 'Другая', 'whatever1', admins)).toBeNull();
    expect((await loginWithPassword(db, 'PASS@mail.ru', 'correct horse', admins))?.id).toBe(u!.id);
    expect(await loginWithPassword(db, 'pass@mail.ru', 'wrong pass', admins)).toBeNull();
    expect(await loginWithPassword(db, 'nobody@mail.ru', 'correct horse', admins)).toBeNull();
    const { rows } = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE email = 'pass@mail.ru'"
    );
    expect(rows[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(rows[0].password_hash).not.toContain('correct horse');

    expect(await changePassword(db, u!.id, 'wrong', 'new password')).toBe(false);
    expect(await changePassword(db, u!.id, 'correct horse', 'new password')).toBe(true);
    expect(await loginWithPassword(db, 'pass@mail.ru', 'new password', admins)).not.toBeNull();
    expect(await setPasswordByEmail(db, 'pass@mail.ru', 'from admin 1')).toBe(true);
    expect(await loginWithPassword(db, 'pass@mail.ru', 'from admin 1', admins)).not.toBeNull();
    expect(await setPasswordByEmail(db, 'nobody@mail.ru', 'x'.repeat(8))).toBe(false);
  });

  it('e-mail codes: one per minute, right once, burnt by wrong tries', async () => {
    const code = await issueLoginCode(db, 'a@b.ru');
    expect(code).toMatch(/^\d{6}$/);
    expect(await issueLoginCode(db, 'a@b.ru')).toBeNull();
    expect(await checkLoginCode(db, 'a@b.ru', code === '000000' ? '111111' : '000000')).toBe(false);
    expect(await checkLoginCode(db, 'A@B.ru', code!)).toBe(true);
    expect(await checkLoginCode(db, 'a@b.ru', code!)).toBe(false);
  });

  it('sessions', async () => {
    const u = await findOrCreateEmailUser(db, 'sess@mail.ru', admins);
    const token = await createSession(db, u.id);
    expect((await sessionUser(db, token))?.id).toBe(u.id);
    expect(await sessionUser(db, token + 'x')).toBeNull();
    await deleteSession(db, token);
    expect(await sessionUser(db, token)).toBeNull();
  });

  it('telegram: the bot confirms the token, the browser picks the session up once', async () => {
    const token = await startTelegramLogin(db);
    expect(await pollTelegramLogin(db, token)).toEqual({ status: 'pending' });
    const tg = { id: 123456789, first_name: 'Аня', username: 'anya' };
    expect(await confirmTelegramLogin(db, token, tg, admins)).toBe(true);
    // a second /start with the same token does nothing
    expect(await confirmTelegramLogin(db, token, tg, admins)).toBe(false);
    const done = await pollTelegramLogin(db, token);
    expect(done.status).toBe('done');
    expect(await pollTelegramLogin(db, token)).toEqual({ status: 'expired' });
  });

  it('groups and invitations; roles reach the viewer', async () => {
    const owner = await findOrCreateEmailUser(db, 'coach@club.ru', admins);
    const runner = await findOrCreateEmailUser(db, 'runner@club.ru', admins);
    const clubId = await createGroup(db, 'club', 'Азимут', owner.id);
    expect((await viewerOf(db, owner)).roles[clubId]).toBe('admin');

    const invite = await createInvite(db, clubId, 'member', owner.id);
    expect(await acceptInvite(db, invite, runner.id)).toBe(clubId);
    expect((await viewerOf(db, runner)).roles[clubId]).toBe('member');
    // a judge invitation upgrades; a member invitation never downgrades
    expect(await acceptInvite(db, await createInvite(db, clubId, 'judge', owner.id), runner.id)).toBe(clubId);
    expect((await viewerOf(db, runner)).roles[clubId]).toBe('judge');
    await acceptInvite(db, invite, runner.id);
    expect((await viewerOf(db, runner)).roles[clubId]).toBe('judge');
    expect(await acceptInvite(db, 'nope', runner.id)).toBeNull();

    const groups = await myGroups(db, runner.id);
    expect(groups.map((g) => [g.name, g.role, g.memberCount])).toEqual([['Азимут', 'judge', 2]]);
  });
});

describe('store', () => {
  const evt = (id: string): RaceEvent => ({
    id,
    slug: id,
    title: 'Тест',
    description: '',
    createdAt: new Date().toISOString(),
    kind: 'run',
    scope: 'personal',
    timeMode: 'from_start',
    participants: [
      {
        id: 'p1',
        name: 'Аня',
        color: '#ef4444',
        visible: true,
        sourceFormat: 'gpx',
        startedAtIso: '2026-11-01T10:00:00.000Z',
        offsetSec: 0,
        trimStartSec: 0,
        trimEndSec: 10,
        totalDistanceM: 30,
        durationSec: 10,
        avgSpeedMs: 3,
        maxSpeedMs: 3,
        points: [
          { t: 0, absTimeMs: Date.parse('2026-11-01T10:00:00Z'), lat: 55.7, lon: 37.5, distM: 0, speedMs: 3 },
          { t: 10, absTimeMs: Date.parse('2026-11-01T10:00:10Z'), lat: 55.7003, lon: 37.5, distM: 30, speedMs: 3 },
        ],
      },
    ],
  });

  it('events with their track points round-trip; deleting drops the tracks', async () => {
    expect(await importEvents(db, [evt('e1'), evt('e2')])).toBe(2);
    const e1 = evt('e1');
    e1.title = 'Переименовано';
    await saveEvent(db, e1);
    await saveTrack(db, 'e1', e1.participants[0]);
    const loaded = await loadEvents(db);
    expect(loaded.get('e1')?.title).toBe('Переименовано');
    expect(loaded.get('e1')?.participants[0].points).toHaveLength(2);
    expect(loaded.get('e1')?.participants[0].points[1].lat).toBeCloseTo(55.7003, 6);
    await deleteEvent(db, 'e2');
    expect(await eventCount(db)).toBe(1);
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tracks WHERE event_id = 'e2'"
    );
    expect(rows[0].n).toBe('0');
  });
});
