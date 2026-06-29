import { config } from '../config.js'

// Postgres-backed store (prod). pg is imported lazily by store.js only when DATABASE_URL
// is set. The port allocator is a real atomic claim (FOR UPDATE SKIP LOCKED), which is
// the multi-writer race guard ADR-005 calls for.
export async function createPostgresStore(url) {
  const pg = await import('pg')
  const pool = new pg.default.Pool({ connectionString: url, max: 8 })

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS instances (
        id text PRIMARY KEY,
        owner text NOT NULL,
        state text NOT NULL,
        port int,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS instances_owner_idx ON instances(owner);
      CREATE INDEX IF NOT EXISTS instances_state_idx ON instances(state);

      CREATE TABLE IF NOT EXISTS port_pool (
        port int PRIMARY KEY,
        instance_id text REFERENCES instances(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS audit (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        actor text,
        action text NOT NULL,
        target text,
        detail jsonb
      );
    `)
    // Seed the port pool once.
    await pool.query(
      `INSERT INTO port_pool(port)
       SELECT generate_series($1::int, $2::int)
       ON CONFLICT (port) DO NOTHING`,
      [config.portRange.min, config.portRange.max],
    )
  }

  const rowToRec = (r) => ({ ...r.data, id: r.id, owner: r.owner, state: r.state, port: r.port ?? undefined })

  return {
    kind: 'postgres',
    init,
    async all() {
      const { rows } = await pool.query('SELECT id, owner, state, port, data FROM instances')
      return rows.map(rowToRec)
    },
    async get(id) {
      const { rows } = await pool.query('SELECT id, owner, state, port, data FROM instances WHERE id=$1', [id])
      return rows[0] ? rowToRec(rows[0]) : null
    },
    async create(rec) {
      await pool.query(
        'INSERT INTO instances(id, owner, state, port, data) VALUES ($1,$2,$3,$4,$5)',
        [rec.id, rec.owner, rec.state, rec.port ?? null, rec],
      )
      if (rec.port) {
        await pool.query('UPDATE port_pool SET instance_id=$1 WHERE port=$2', [rec.id, rec.port])
      }
      return rec
    },
    async update(id, patch) {
      const cur = await this.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch }
      await pool.query(
        'UPDATE instances SET owner=$2, state=$3, port=$4, data=$5, updated_at=now() WHERE id=$1',
        [id, next.owner, next.state, next.port ?? null, next],
      )
      return next
    },
    async remove(id) {
      await pool.query('UPDATE port_pool SET instance_id=NULL WHERE instance_id=$1', [id])
      await pool.query('DELETE FROM instances WHERE id=$1', [id])
    },
    // Atomic free-port claim, linked to the instance in one statement. The instance row
    // must already exist (FK). FOR UPDATE SKIP LOCKED makes concurrent claims pick
    // distinct rows — the real multi-writer guard (ADR-005).
    async allocatePort(instanceId) {
      const { rows } = await pool.query(
        `UPDATE port_pool SET instance_id = $1
         WHERE port = (
           SELECT port FROM port_pool WHERE instance_id IS NULL ORDER BY port
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING port`,
        [instanceId],
      )
      if (!rows[0]) throw new Error('No free ports in range')
      return rows[0].port
    },
    async freePort(instanceId) {
      await pool.query('UPDATE port_pool SET instance_id=NULL WHERE instance_id=$1', [instanceId])
    },
    async audit(entry) {
      await pool.query('INSERT INTO audit(actor, action, target, detail) VALUES ($1,$2,$3,$4)', [
        entry.actor || null,
        entry.action,
        entry.target || null,
        entry.detail || null,
      ])
    },
    async listAudit(limit = 200) {
      const { rows } = await pool.query('SELECT at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT $1', [limit])
      return rows
    },
  }
}
