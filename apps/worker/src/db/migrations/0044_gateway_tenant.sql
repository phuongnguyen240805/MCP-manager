-- Partition gateway data by the Kedi assertion tenant (`tid`).
--
-- NULL means the deployment's own cookie / MCP org. Existing rows stay
-- NULL, so that path is unchanged. A gateway request only reads and writes
-- rows whose tenant_id equals the assertion. Child tables (revisions, tags,
-- credentials, visibility) are reached through a parent row.
--
-- external_identities was keyed by (issuer, subject). The same Nest subject
-- in two tenants shared one user, so a role flip in one tenant landed in the
-- other. The primary key is now (issuer, subject, tenant_id). Rows that
-- predate this migration are parked on tenant_id 'legacy' and are not reused.

ALTER TABLE documents ADD COLUMN tenant_id TEXT;
ALTER TABLE skills ADD COLUMN tenant_id TEXT;
ALTER TABLE upstream_servers ADD COLUMN tenant_id TEXT;
ALTER TABLE teams ADD COLUMN tenant_id TEXT;
ALTER TABLE products ADD COLUMN tenant_id TEXT;
ALTER TABLE roles ADD COLUMN tenant_id TEXT;
ALTER TABLE users ADD COLUMN tenant_id TEXT;
ALTER TABLE git_sources ADD COLUMN tenant_id TEXT;
ALTER TABLE git_connections ADD COLUMN tenant_id TEXT;
ALTER TABLE usage_events ADD COLUMN tenant_id TEXT;
ALTER TABLE usage_rollups_daily ADD COLUMN tenant_id TEXT;
ALTER TABLE audit_log ADD COLUMN tenant_id TEXT;
ALTER TABLE async_jobs ADD COLUMN tenant_id TEXT;
ALTER TABLE invites ADD COLUMN tenant_id TEXT;
ALTER TABLE join_codes ADD COLUMN tenant_id TEXT;
ALTER TABLE job_runs ADD COLUMN tenant_id TEXT;
ALTER TABLE upstream_operations ADD COLUMN tenant_id TEXT;
ALTER TABLE oauth_grant_activity ADD COLUMN tenant_id TEXT;

CREATE INDEX idx_documents_tenant ON documents(tenant_id);
CREATE INDEX idx_skills_tenant ON skills(tenant_id);
CREATE INDEX idx_upstream_servers_tenant ON upstream_servers(tenant_id);
CREATE INDEX idx_teams_tenant ON teams(tenant_id);
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_roles_tenant ON roles(tenant_id);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_git_sources_tenant ON git_sources(tenant_id);
CREATE INDEX idx_git_connections_tenant ON git_connections(tenant_id);
CREATE INDEX idx_usage_events_tenant ON usage_events(tenant_id, ts);
CREATE INDEX idx_usage_rollups_tenant ON usage_rollups_daily(tenant_id, day);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, ts);
CREATE INDEX idx_async_jobs_tenant ON async_jobs(tenant_id, created_at);
CREATE INDEX idx_invites_tenant ON invites(tenant_id);
CREATE INDEX idx_join_codes_tenant ON join_codes(tenant_id);
CREATE INDEX idx_job_runs_tenant ON job_runs(tenant_id, started_at);
CREATE INDEX idx_operations_tenant ON upstream_operations(tenant_id, created_at);
CREATE INDEX idx_grant_activity_tenant ON oauth_grant_activity(tenant_id);

CREATE TABLE external_identities_new (
  issuer     TEXT NOT NULL CHECK (length(issuer) > 0),
  subject    TEXT NOT NULL CHECK (length(subject) > 0),
  tenant_id  TEXT NOT NULL CHECK (length(tenant_id) > 0),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject, tenant_id)
);
INSERT INTO external_identities_new (issuer, subject, tenant_id, user_id, created_at)
SELECT issuer, subject, 'legacy', user_id, created_at FROM external_identities;
DROP TABLE external_identities;
ALTER TABLE external_identities_new RENAME TO external_identities;
CREATE INDEX idx_external_identities_user ON external_identities(user_id);

UPDATE users
SET tenant_id = (SELECT e.tenant_id FROM external_identities e WHERE e.user_id = users.id)
WHERE tenant_id IS NULL
  AND id IN (SELECT user_id FROM external_identities);
