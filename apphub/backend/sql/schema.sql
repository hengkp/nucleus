-- SISP AppHub control-plane schema (ADR-005). The server applies this idempotently on
-- boot (see src/lib/postgres-store.js); this file is the canonical reference + manual
-- migration source. Postgres runs on node1 with restore-verified nightly pg_dump.

CREATE TABLE IF NOT EXISTS instances (
  id         text PRIMARY KEY,
  owner      text NOT NULL,
  state      text NOT NULL,              -- queued|starting|running|expiring|stopped|failed
  port       int,
  data       jsonb NOT NULL,             -- full instance record (template, resources, jobId, url, …)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instances_owner_idx ON instances(owner);
CREATE INDEX IF NOT EXISTS instances_state_idx ON instances(state);

-- Pre-seeded pool of node-side ports. Allocation is an atomic claim
-- (UPDATE … WHERE port = (SELECT … FOR UPDATE SKIP LOCKED)) so concurrent launches
-- can never collide on a port — the real multi-writer guard.
CREATE TABLE IF NOT EXISTS port_pool (
  port        int PRIMARY KEY,
  instance_id text REFERENCES instances(id) ON DELETE SET NULL
);
-- INSERT INTO port_pool(port) SELECT generate_series(31000, 31999) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  actor  text,
  action text NOT NULL,                  -- launch|stop|extend|approve|…
  target text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit(at DESC);

-- Approvals for "host my own app" requests (Apptainer / persistent partition).
CREATE TABLE IF NOT EXISTS approvals (
  id         text PRIMARY KEY,
  requester  text NOT NULL,
  kind       text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',  -- pending|approved|denied
  detail     jsonb,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
