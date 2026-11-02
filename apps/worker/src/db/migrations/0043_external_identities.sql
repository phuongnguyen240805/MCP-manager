-- Trusted-gateway identities (Kedi Nest control plane).
--
-- Nest calls `/api/*` with a short-lived assertion. The local user is keyed
-- by (issuer, subject), never by email, so a gateway subject cannot attach
-- itself to an existing Google/GitHub/Access row that happens to share an
-- address. `users.idp` must also accept 'kedi': the column CHECK is closed
-- and SQLite cannot widen a CHECK without rebuilding the table.
--
-- `users` is a referenced parent. D1 ignores `PRAGMA foreign_keys=OFF` inside
-- a migration transaction, and a plain DROP cascades or fails the commit
-- (G1, worked example 0028). Detach every live user reference, swap, reattach.
-- Children enumerated from `REFERENCES users(` in this directory:
--   CASCADE: user_credentials, team_members, user_roles, git_user_credentials.
--   CASCADE nullable column (would delete the PARENT upstream): owner_user_id.
--   SET NULL: documents.locked_by, git_pull_requests.opened_by,
--     git_shared_credentials.created_by (PK is connection_id since 0030),
--     git_sources.created_by, git_connections.created_by,
--     invites.invited_by / redeemed_user, join_codes.created_by,
--     upstream_shared_credentials.created_by.
--   NO ACTION nullable: documents.created_by, doc_revisions.author_id,
--     doc_editors.granted_by, doc_attachments.created_by,
--     skill_revisions.author_id, skill_attachments.created_by.
--   NO ACTION not-null: skills.created_by (delete the skills subtree, including
--     skill_tags, which CASCADE off skills — 0028 restored skills without tags).
-- sync_as_user_id, async_jobs.user_id, oauth_grant_activity.user_id and
-- upstream_operations are intentionally not foreign keys.

PRAGMA defer_foreign_keys = TRUE;

-- 1. Snapshot rows we must put back. SELECT * keeps BLOB ciphertext byte-exact
--    and picks up columns added after 0028 (visibility, granted_at, …).
CREATE TABLE _u43_user_credentials     AS SELECT * FROM user_credentials;
CREATE TABLE _u43_team_members         AS SELECT * FROM team_members;
CREATE TABLE _u43_user_roles           AS SELECT * FROM user_roles;
CREATE TABLE _u43_git_user_credentials AS SELECT * FROM git_user_credentials;
CREATE TABLE _u43_skills               AS SELECT * FROM skills;
CREATE TABLE _u43_skill_revisions      AS SELECT * FROM skill_revisions;
CREATE TABLE _u43_skill_attachments    AS SELECT * FROM skill_attachments;
CREATE TABLE _u43_skill_tags           AS SELECT * FROM skill_tags;

CREATE TABLE _u43_documents AS
  SELECT id, created_by, locked_by FROM documents
  WHERE created_by IS NOT NULL OR locked_by IS NOT NULL;
CREATE TABLE _u43_doc_revisions AS
  SELECT id, author_id FROM doc_revisions WHERE author_id IS NOT NULL;
CREATE TABLE _u43_doc_editors AS
  SELECT doc_id, scope_kind, scope_id, granted_by FROM doc_editors
  WHERE granted_by IS NOT NULL;
CREATE TABLE _u43_doc_attachments AS
  SELECT doc_id, upstream_id, tool_name, created_by FROM doc_attachments
  WHERE created_by IS NOT NULL;
CREATE TABLE _u43_git_prs AS
  SELECT id, opened_by FROM git_pull_requests WHERE opened_by IS NOT NULL;
CREATE TABLE _u43_git_shared AS
  SELECT connection_id, created_by FROM git_shared_credentials WHERE created_by IS NOT NULL;
CREATE TABLE _u43_git_sources AS
  SELECT id, created_by FROM git_sources WHERE created_by IS NOT NULL;
CREATE TABLE _u43_git_connections AS
  SELECT id, created_by FROM git_connections WHERE created_by IS NOT NULL;
CREATE TABLE _u43_invites AS
  SELECT id, invited_by, redeemed_user FROM invites
  WHERE invited_by IS NOT NULL OR redeemed_user IS NOT NULL;
CREATE TABLE _u43_join_codes AS
  SELECT id, created_by FROM join_codes WHERE created_by IS NOT NULL;
CREATE TABLE _u43_up_shared AS
  SELECT upstream_id, created_by FROM upstream_shared_credentials WHERE created_by IS NOT NULL;
CREATE TABLE _u43_up_owner AS
  SELECT id, owner_user_id FROM upstream_servers WHERE owner_user_id IS NOT NULL;

-- 2. Detach. Explicit deletes (not the DROP's cascade) so a runner with
--    foreign keys off does not leave rows that collide on restore.
UPDATE upstream_servers SET owner_user_id = NULL;
UPDATE documents SET created_by = NULL, locked_by = NULL;
UPDATE doc_revisions SET author_id = NULL;
UPDATE doc_editors SET granted_by = NULL;
UPDATE doc_attachments SET created_by = NULL;
UPDATE git_pull_requests SET opened_by = NULL;
UPDATE git_shared_credentials SET created_by = NULL;
UPDATE git_sources SET created_by = NULL;
UPDATE git_connections SET created_by = NULL;
UPDATE invites SET invited_by = NULL, redeemed_user = NULL;
UPDATE join_codes SET created_by = NULL;
UPDATE upstream_shared_credentials SET created_by = NULL;

DELETE FROM skill_revisions;
DELETE FROM skill_attachments;
DELETE FROM skill_tags;
DELETE FROM skills;
DELETE FROM user_credentials;
DELETE FROM team_members;
DELETE FROM user_roles;
DELETE FROM git_user_credentials;

-- 3. Rebuild users with the widened idp CHECK plus session_epoch (0033).
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  idp           TEXT NOT NULL CHECK (idp IN ('google', 'github', 'access', 'kedi')),
  idp_sub       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended')),
  session_epoch INTEGER NOT NULL DEFAULT 0,
  UNIQUE(idp, idp_sub)
);
INSERT INTO users_new
  (id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at, status, session_epoch)
SELECT
  id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at, status, session_epoch
FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_status ON users(status);

-- 4. Reattach. Parent ids are unchanged, so the deferred FK check passes.
INSERT INTO user_credentials     SELECT * FROM _u43_user_credentials;
INSERT INTO team_members         SELECT * FROM _u43_team_members;
INSERT INTO user_roles           SELECT * FROM _u43_user_roles;
INSERT INTO git_user_credentials SELECT * FROM _u43_git_user_credentials;
INSERT INTO skills               SELECT * FROM _u43_skills;
INSERT INTO skill_revisions      SELECT * FROM _u43_skill_revisions;
INSERT INTO skill_attachments    SELECT * FROM _u43_skill_attachments;
INSERT INTO skill_tags           SELECT * FROM _u43_skill_tags;

UPDATE documents SET
  created_by = (SELECT created_by FROM _u43_documents s WHERE s.id = documents.id),
  locked_by  = (SELECT locked_by  FROM _u43_documents s WHERE s.id = documents.id)
WHERE id IN (SELECT id FROM _u43_documents);
UPDATE doc_revisions SET author_id = (
  SELECT author_id FROM _u43_doc_revisions s WHERE s.id = doc_revisions.id
) WHERE id IN (SELECT id FROM _u43_doc_revisions);
UPDATE doc_editors SET granted_by = (
  SELECT granted_by FROM _u43_doc_editors s
  WHERE s.doc_id = doc_editors.doc_id
    AND s.scope_kind = doc_editors.scope_kind
    AND s.scope_id = doc_editors.scope_id
) WHERE (doc_id, scope_kind, scope_id) IN (
  SELECT doc_id, scope_kind, scope_id FROM _u43_doc_editors
);
UPDATE doc_attachments SET created_by = (
  SELECT created_by FROM _u43_doc_attachments s
  WHERE s.doc_id = doc_attachments.doc_id
    AND s.upstream_id = doc_attachments.upstream_id
    AND s.tool_name = doc_attachments.tool_name
) WHERE (doc_id, upstream_id, tool_name) IN (
  SELECT doc_id, upstream_id, tool_name FROM _u43_doc_attachments
);
UPDATE git_pull_requests SET opened_by = (
  SELECT opened_by FROM _u43_git_prs s WHERE s.id = git_pull_requests.id
) WHERE id IN (SELECT id FROM _u43_git_prs);
UPDATE git_shared_credentials SET created_by = (
  SELECT created_by FROM _u43_git_shared s
  WHERE s.connection_id = git_shared_credentials.connection_id
) WHERE connection_id IN (SELECT connection_id FROM _u43_git_shared);
UPDATE git_sources SET created_by = (
  SELECT created_by FROM _u43_git_sources s WHERE s.id = git_sources.id
) WHERE id IN (SELECT id FROM _u43_git_sources);
UPDATE git_connections SET created_by = (
  SELECT created_by FROM _u43_git_connections s WHERE s.id = git_connections.id
) WHERE id IN (SELECT id FROM _u43_git_connections);
UPDATE invites SET
  invited_by = (SELECT invited_by FROM _u43_invites s WHERE s.id = invites.id),
  redeemed_user = (SELECT redeemed_user FROM _u43_invites s WHERE s.id = invites.id)
WHERE id IN (SELECT id FROM _u43_invites);
UPDATE join_codes SET created_by = (
  SELECT created_by FROM _u43_join_codes s WHERE s.id = join_codes.id
) WHERE id IN (SELECT id FROM _u43_join_codes);
UPDATE upstream_shared_credentials SET created_by = (
  SELECT created_by FROM _u43_up_shared s
  WHERE s.upstream_id = upstream_shared_credentials.upstream_id
) WHERE upstream_id IN (SELECT upstream_id FROM _u43_up_shared);
UPDATE upstream_servers SET owner_user_id = (
  SELECT owner_user_id FROM _u43_up_owner s WHERE s.id = upstream_servers.id
) WHERE id IN (SELECT id FROM _u43_up_owner);

DROP TABLE _u43_user_credentials;
DROP TABLE _u43_team_members;
DROP TABLE _u43_user_roles;
DROP TABLE _u43_git_user_credentials;
DROP TABLE _u43_skills;
DROP TABLE _u43_skill_revisions;
DROP TABLE _u43_skill_attachments;
DROP TABLE _u43_skill_tags;
DROP TABLE _u43_documents;
DROP TABLE _u43_doc_revisions;
DROP TABLE _u43_doc_editors;
DROP TABLE _u43_doc_attachments;
DROP TABLE _u43_git_prs;
DROP TABLE _u43_git_shared;
DROP TABLE _u43_git_sources;
DROP TABLE _u43_git_connections;
DROP TABLE _u43_invites;
DROP TABLE _u43_join_codes;
DROP TABLE _u43_up_shared;
DROP TABLE _u43_up_owner;

-- 5. Gateway principal map. PK is the UNIQUE(issuer, subject) the caller
--    resolves. Email on `users` is a synthetic address and is not a join key.
CREATE TABLE external_identities (
  issuer     TEXT NOT NULL CHECK (length(issuer) > 0),
  subject    TEXT NOT NULL CHECK (length(subject) > 0),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX idx_external_identities_user ON external_identities(user_id);
