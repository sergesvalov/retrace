import { toLiteEvent, toWireParticipant, unpackPoints } from '../shared/pointsCodec.js';
import type { ParticipantTrack, RaceEvent } from '../shared/types.js';
import type { Db } from './db.js';

/**
 * Events and tracks in Postgres. An event row holds the settings without points (~1 KB of
 * JSON, rewritten on every change) plus the columns access is decided by; track points are
 * written once per upload. The server keeps every event in memory and writes through.
 */

export async function loadEvents(db: Db): Promise<Map<string, RaceEvent>> {
  const events = await db.query<{ data: RaceEvent }>('SELECT data FROM events');
  const tracks = await db.query<{ event_id: string; participant_id: string; packed: never }>(
    'SELECT event_id, participant_id, packed FROM tracks'
  );
  const points = new Map<string, ReturnType<typeof unpackPoints>>();
  for (const t of tracks.rows) {
    points.set(`${t.event_id}/${t.participant_id}`, unpackPoints(t.packed));
  }
  const map = new Map<string, RaceEvent>();
  for (const { data } of events.rows) {
    for (const p of data.participants) {
      p.points = points.get(`${data.id}/${p.id}`) ?? [];
    }
    map.set(data.id, data);
  }
  return map;
}

export async function saveEvent(db: Db, evt: RaceEvent): Promise<void> {
  await db.query(
    `INSERT INTO events (id, slug, scope, group_id, owner_id, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, scope = EXCLUDED.scope,
       group_id = EXCLUDED.group_id, owner_id = EXCLUDED.owner_id, data = EXCLUDED.data,
       updated_at = now()`,
    [
      evt.id,
      evt.slug,
      evt.scope ?? null,
      evt.groupId ?? null,
      evt.ownerId ?? null,
      JSON.stringify(toLiteEvent(evt)),
      evt.createdAt,
    ]
  );
}

export async function saveTrack(db: Db, eventId: string, p: ParticipantTrack): Promise<void> {
  await db.query(
    `INSERT INTO tracks (event_id, participant_id, packed) VALUES ($1, $2, $3)
     ON CONFLICT (event_id, participant_id) DO UPDATE SET packed = EXCLUDED.packed`,
    [eventId, p.id, JSON.stringify(toWireParticipant(p).packed)]
  );
}

export async function deleteTrack(db: Db, eventId: string, participantId: string): Promise<void> {
  await db.query('DELETE FROM tracks WHERE event_id = $1 AND participant_id = $2', [
    eventId,
    participantId,
  ]);
}

/** The event and its tracks */
export async function deleteEvent(db: Db, eventId: string): Promise<void> {
  await db.query('DELETE FROM events WHERE id = $1', [eventId]);
}

export async function eventCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM events');
  return Number(rows[0]?.n ?? 0);
}

/**
 * Events saved as files before the database (data/events + data/tracks): copied in once,
 * into an empty database. They keep no owner, so only site admins see them until an admin
 * sets who they are for.
 */
export async function importEvents(db: Db, events: Iterable<RaceEvent>): Promise<number> {
  let n = 0;
  await db.tx(async (t) => {
    for (const evt of events) {
      await saveEvent(t, evt);
      for (const p of evt.participants) await saveTrack(t, evt.id, p);
      n++;
    }
  });
  return n;
}
