-- A deleted project must not silently turn a scoped connection into an open one.
CREATE TABLE upstream_invocation_policies (
  upstream_id TEXT PRIMARY KEY REFERENCES upstream_servers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_invocation_policies_product ON upstream_invocation_policies(product_id);

-- Persist arguments so queue dispatch and result access use the same invocation.
ALTER TABLE async_jobs ADD COLUMN args_json TEXT;
