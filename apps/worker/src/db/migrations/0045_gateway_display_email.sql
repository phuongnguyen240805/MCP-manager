-- Display address from a gateway assertion (`email` claim).
--
-- Not unique and not a join key. Account lookup stays
-- (issuer, subject, tenant_id). `users.email` remains the synthetic
-- `kedi.<hash>@gateway.invalid` so an email invite or another IdP
-- cannot attach to this row.

ALTER TABLE external_identities ADD COLUMN display_email TEXT;
