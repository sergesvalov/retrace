/**
 * PostgreSQL access. Production: DATABASE_URL (node-postgres pool). Tests and local
 * development without a server: PGlite — real Postgres compiled to WebAssembly, in memory
 * or in a folder (DATABASE_URL=pglite://data/pglite). It is loaded only then, so the
 * production bundle does not carry it.
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements at once, no parameters (schema) */
  exec(sql: string): Promise<void>;
  /** Run `fn` in one transaction */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (!url) throw new Error('DATABASE_URL is not set (e.g. postgres://user:pass@host/db)');
  if (url.startsWith('pglite:')) {
    const dir = url.slice('pglite:'.length).replace(/^\/\//, '');
    return openPglite(dir || undefined);
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  // A dropped idle connection must not crash the server
  pool.on('error', (err) => console.error('Postgres pool error:', err));
  const wrap = (q: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }): Omit<Db, 'tx' | 'close'> => ({
    query: async <T>(sql: string, params?: unknown[]) =>
      (await q.query(sql, params)) as { rows: T[] },
    exec: async (sql: string) => {
      await q.query(sql);
    },
  });
  return {
    ...wrap(pool),
    tx: async (fn) => {
      const client = await pool.connect();
      // A transaction inside this one just keeps using the same connection
      const clientDb: Db = {
        ...wrap(client),
        tx: (inner) => inner(clientDb),
        close: async () => {},
      };
      try {
        await client.query('BEGIN');
        const out = await fn(clientDb);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres for tests (no dir = in memory) and local development */
export async function openPglite(dir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dir ? new PGlite(dir) : new PGlite();
  const db: Db = {
    query: async <T>(sql: string, params?: unknown[]) =>
      (await pg.query(sql, params)) as unknown as { rows: T[] },
    exec: async (sql: string) => {
      await pg.exec(sql);
    },
    // One connection: statements already run one after another
    tx: async (fn) => {
      await pg.exec('BEGIN');
      try {
        const out = await fn(db);
        await pg.exec('COMMIT');
        return out;
      } catch (err) {
        await pg.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => pg.close(),
  };
  return db;
}

/** Schema, in versions: each step runs once, in order */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text UNIQUE,
    telegram_id bigint UNIQUE,
    telegram_username text,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE login_codes (
    email text PRIMARY KEY,
    code_hash text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    attempts int NOT NULL DEFAULT 0
  );
  CREATE TABLE telegram_logins (
    token text PRIMARY KEY,
    user_id text REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE groups (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('club', 'family')),
    name text NOT NULL,
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE group_members (
    group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('admin', 'judge', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members(user_id);
  CREATE TABLE group_invites (
    token text PRIMARY KEY,
    group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('admin', 'judge', 'member')),
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE events (
    id text PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    scope text,
    group_id text REFERENCES groups(id) ON DELETE SET NULL,
    owner_id text REFERENCES users(id) ON DELETE SET NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE tracks (
    event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    participant_id text NOT NULL,
    packed jsonb NOT NULL,
    PRIMARY KEY (event_id, participant_id)
  );
  `,
  // 2: sign-up with e-mail and password
  `
  ALTER TABLE users ADD COLUMN password_hash text;
  `,
  // 3: sign-up by a nickname instead of an e-mail; unique regardless of case
  `
  ALTER TABLE users ADD COLUMN login text;
  CREATE UNIQUE INDEX users_login_lower ON users (lower(login));
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version (version int PRIMARY KEY)');
  const { rows } = await db.query<{ v: number | null }>(
    'SELECT max(version) AS v FROM schema_version'
  );
  const current = rows[0]?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.tx(async (t) => {
      await t.exec(MIGRATIONS[i]);
      await t.query('INSERT INTO schema_version (version) VALUES ($1)', [i + 1]);
    });
  }
}
