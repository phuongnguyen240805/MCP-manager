-- Soft references preserve the operation record when identities/upstreams are removed.
CREATE TABLE upstream_operations (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  connection_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','running','succeeded','failed','unknown','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  approved_by TEXT,
  started_at INTEGER,
  result_json TEXT,
  error_code TEXT,
  resolution_json TEXT,
  UNIQUE (requester_id, request_id)
);
CREATE INDEX idx_operations_upstream ON upstream_operations(upstream_id, created_at);
CREATE INDEX idx_operations_requester ON upstream_operations(requester_id, created_at);

-- State changes and their audit evidence commit together, including execution claims.
CREATE TABLE operation_events (
  id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','running','succeeded','failed','unknown','expired')),
  actor_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_operation_events_operation ON operation_events(operation_id, id);
CREATE TRIGGER operation_created AFTER INSERT ON upstream_operations BEGIN
  INSERT INTO operation_events(operation_id, state, actor_id, at)
  VALUES (NEW.id, NEW.state, NEW.updated_by, NEW.updated_at);
  INSERT INTO audit_log(id, ts, actor_id, action, target, meta)
  VALUES (lower(hex(randomblob(16))), NEW.updated_at, NEW.updated_by,
    'operation.' || NEW.state, NEW.id,
    json_object('upstreamId', NEW.upstream_id, 'projectId', NEW.product_id, 'policyVersion', NEW.policy_version));
END;
CREATE TRIGGER operation_transition AFTER UPDATE OF state ON upstream_operations
WHEN OLD.state != NEW.state BEGIN
  INSERT INTO operation_events(operation_id, state, actor_id, at)
  VALUES (NEW.id, NEW.state, NEW.updated_by, NEW.updated_at);
  INSERT INTO audit_log(id, ts, actor_id, action, target, meta)
  VALUES (lower(hex(randomblob(16))), NEW.updated_at, NEW.updated_by,
    'operation.' || NEW.state, NEW.id,
    json_object('upstreamId', NEW.upstream_id, 'projectId', NEW.product_id, 'policyVersion', NEW.policy_version));
END;
