-- ============================================================================
-- Migration v24 — THE AUDIT LOG CAN RECORD RESTORING ACCESS AND RENAMING
--                 SOMEBODY (Gate 2B, Stage B.3, round 2)
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- Migration 023 created `auth_audit` with a fixed `event` vocabulary and said in
-- its own header that the vocabulary "is stated now so the CHECK never has to be
-- widened, which on this table would mean a rebuild". The intent was right and
-- the list was incomplete. Stage B.3 shipped the four staff-administration
-- commands and could record only three of the five things they do:
--
--   created            -> 'user_created'      ✓
--   role changed       -> 'role_changed'      ✓
--   retired            -> 'user_deactivated'  ✓
--   BROUGHT BACK       -> nothing
--   RENAMED            -> nothing
--
-- and one more that the same round needed: a live session ENDED because the
-- account behind it stopped being usable. That is not a `logout` — nobody chose
-- it — and recording it as one would claim the person signed out when what
-- happened is that their access was withdrawn while they were working.
-- `session_revoked` is therefore added here as well.
--
-- An independent review called the first of those a P1, and it is the right
-- call. `user_deactivated` is the record that somebody's access was TAKEN AWAY;
-- with no counterpart, access could be GIVEN BACK and the log would say only
-- that it had once been removed. An owner reading it six months later would see
-- a cashier retired in March and no indication that they were working again in
-- April — and the log is the only place that could have said so, because
-- `users.active` holds today's value and nothing else.
--
-- The rename is the quieter half and belongs in the same change. `users.full_name`
-- is the name printed on every shift report and shown beside every sale in
-- Sales History, and those screens JOIN to the live row rather than snapshotting
-- it. So editing a name silently restates the attribution on documents that are
-- otherwise immutable — not the `user_id` they are keyed on, but the name a
-- person reads off them, which is the part anybody actually uses to say who did
-- something. The row is allowed to change (people's names change, and a typo on
-- the first day should be fixable), so the answer is not to forbid it; the
-- answer is that it leaves a trace.
--
-- ----------------------------------------------------------------------------
-- WHY A REBUILD, AND WHY THAT IS SAFE HERE
--
-- SQLite cannot ALTER a CHECK constraint. The documented options are to rebuild
-- the table or to leave the rule as a trigger, and this codebase has taken both
-- before: migration 015 rebuilt `sale_payments` to widen a `method` CHECK, and
-- migration 020 deliberately put a WIDER domain in its CHECK than it
-- implemented, so that WP-B2-B could relax a TRIGGER instead of rebuilding
-- `products`. The second approach is unavailable here: the restriction being
-- relaxed IS the CHECK, and no trigger can make a CHECK accept a value.
--
-- The rebuild is safe for this table for the reasons migration 015 set out, and
-- they are checked rather than assumed:
--
--   * `auth_audit` IS A LEAF. Nothing in the schema references it — no foreign
--     key, no view, no trigger on another table reads it. Its own two foreign
--     keys point OUT, at `stores` and `users`, and are preserved exactly.
--   * THE COPY IS COLUMN-FOR-COLUMN. Every row is moved by an explicit
--     `INSERT ... SELECT` naming all seven columns in order. No value is
--     re-derived, no timestamp is regenerated, no id is reissued. A security log
--     that lost or altered a row in the course of being improved would be worse
--     than one that could not record a reactivation.
--   * THE APPEND-ONLY TRIGGERS ARE DROPPED FIRST AND RECREATED, which is
--     necessary rather than convenient: `trg_auth_audit_no_delete` would abort
--     the `DROP TABLE` of the old copy, and the recreated pair is 023's,
--     verbatim.
--   * IT RUNS WITH FOREIGN KEYS ENABLED, and that is stated rather than
--     worked around. The first version of this migration opened with
--     `PRAGMA foreign_keys = OFF` and closed with `ON`, which is the documented
--     table-rebuild recipe — and which DOES NOTHING HERE: sqlx runs each
--     migration inside a transaction, and SQLite makes `PRAGMA foreign_keys`
--     a silent no-op while one is open. So the rebuild was always running with
--     enforcement on, and a comment claiming otherwise described a safety
--     mechanism that did not exist (independent review, Stage B.3 round 2).
--     The PRAGMAs are removed instead of being made to work, because the
--     rebuild does not need them: `auth_audit` is referenced by nothing, so
--     dropping it violates no child; and every row copied forward already
--     satisfied the same two foreign keys, so the `INSERT ... SELECT` cannot
--     fail on one. A rebuild of a table with CHILDREN would need the PRAGMA
--     and would therefore need to be its own migration outside a transaction —
--     a different problem, and not this one.
--   * NOTHING IS WIDENED EXCEPT THE VOCABULARY. The two new values are added;
--     no existing value is removed or renamed, so every row already written
--     still satisfies the new CHECK, and the copy cannot fail on a historical
--     row. The column list, the types, the nullability, the defaults, the
--     foreign keys, the three indexes and the store-coherence trigger are
--     reproduced unchanged.
--
-- The rule binds from the moment this applies. No existing row is rewritten, no
-- missing event is invented for the past, and a shop that reactivated somebody
-- under v23 has no record of it — which is the truth about that shop and is not
-- something a migration can honestly repair.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_auth_audit_no_update;
DROP TRIGGER IF EXISTS trg_auth_audit_no_delete;
DROP TRIGGER IF EXISTS trg_auth_audit_user_is_of_this_store;

DROP INDEX IF EXISTS idx_auth_audit_at;
DROP INDEX IF EXISTS idx_auth_audit_event;
DROP INDEX IF EXISTS idx_auth_audit_user;

-- 023's table, with two values added to the vocabulary and nothing else
-- changed. Built under a working name and renamed into place after the copy, so
-- the old rows are never without a home.
CREATE TABLE auth_audit_v24 (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  event          TEXT NOT NULL CHECK (event IN (
                   -- Session lifecycle.
                   'login_ok','login_failed','locked_out','logout','timeout',
                   'lock','unlock','unlock_failed',
                   -- Credential lifecycle.
                   'credential_set','credential_changed','credential_reset',
                   -- Enrollment and recovery.
                   'enrollment_code_issued','enrollment_failed',
                   'owner_enrolled','recovery_used','recovery_failed',
                   -- Administration. `user_activated`, `user_renamed` and
                   -- `session_revoked` are this migration; the rest are 023's.
                   'role_changed','user_created','user_deactivated',
                   'user_activated','user_renamed',
                   -- A live session ended because its own account stopped
                   -- being usable, which is not a `logout`: nobody chose it.
                   -- Recording it as one would say the person signed out when
                   -- what happened is that their access was withdrawn
                   -- underneath them.
                   'session_revoked',
                   'permission_denied')),

  user_id        TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
  operation      TEXT,
  detail         TEXT
);

INSERT INTO auth_audit_v24
  (id, store_id, at, event, user_id, actor_user_id, operation, detail)
SELECT
   id, store_id, at, event, user_id, actor_user_id, operation, detail
  FROM auth_audit;

DROP TABLE auth_audit;
ALTER TABLE auth_audit_v24 RENAME TO auth_audit;

CREATE INDEX IF NOT EXISTS idx_auth_audit_at    ON auth_audit(store_id, at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event ON auth_audit(store_id, event, at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user  ON auth_audit(user_id, at);

-- APPEND-ONLY, the `supplier_ledger` pattern (006). An audit row that can be
-- edited or deleted is a note, not evidence. 023's pair, verbatim.
CREATE TRIGGER IF NOT EXISTS trg_auth_audit_no_update
BEFORE UPDATE ON auth_audit
BEGIN
  SELECT RAISE(ABORT, 'auth_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_audit_no_delete
BEFORE DELETE ON auth_audit
BEGIN
  SELECT RAISE(ABORT, 'auth_audit is append-only');
END;

-- An audit row is filed against the store of the user it names. 023's trigger,
-- verbatim.
CREATE TRIGGER IF NOT EXISTS trg_auth_audit_user_is_of_this_store
BEFORE INSERT ON auth_audit
WHEN (NEW.user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u
                       WHERE u.id = NEW.user_id AND u.store_id = NEW.store_id))
  OR (NEW.actor_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u
                       WHERE u.id = NEW.actor_user_id AND u.store_id = NEW.store_id))
BEGIN
  SELECT RAISE(ABORT, 'an auth_audit row must name users of its own store');
END;
