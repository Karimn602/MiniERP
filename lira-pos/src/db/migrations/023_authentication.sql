-- ============================================================================
-- Migration v23 — OFFLINE AUTHENTICATION FOUNDATION (Gate 2B, Stage A.1)
-- ----------------------------------------------------------------------------
-- WHAT THIS ADDS
--
-- Until now Greaz had no authentication of any kind. `users.role` carried
-- ('owner','manager','cashier') from migration 001 and was read by NOTHING;
-- `users.pin_hash` existed, was NULL in every row, and was read by nothing;
-- and `src/state/activeContext.ts` decided "who is using the application" with
--
--     SELECT id FROM users WHERE store_id = ? AND active = 1
--      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC
--      LIMIT 1
--
-- so the application always ran as the oldest active owner and every actor on
-- every posted document was that one seeded row, asserted by the caller.
--
-- This migration adds the SCHEMA an offline credential needs. It adds no
-- enforcement of who may do what — that is Stage B — and it is deliberately
-- useless on its own: until `auth.rs` ships, nothing reads these columns, and
-- until Stage B ships, a role is still not a permission.
--
--   1. The credential, on the EXISTING `users` row (§1).
--   2. `auth_enrollment` — the per-store enrollment STATE MACHINE (§2). This is
--      the heart of the migration and §2's note explains why it is a persisted
--      row rather than something inferred.
--   3. `owner_recovery` — the single-use owner recovery secret (§3).
--   4. `auth_audit` — append-only security log (§4).
--
-- IT IS ADDITIVE AND IT RESTATES NOTHING. New nullable columns, new columns
-- with defaults, new tables, new indexes, and -- on every EXISTING table --
-- BEFORE triggers only. (The one AFTER trigger here, `trg_auth_enrollment_
-- updated_at` in section 2, is on a table this migration creates, so it can
-- touch nothing that existed before. An earlier draft of this header said
-- "BEFORE triggers only" without that qualification, which independent review
-- correctly called inaccurate.) No existing row is read for its own sake,
-- rewritten, or re-validated; no CHECK on an
-- existing column is widened; no table is rebuilt. `users` is referenced by
-- eight tables (`sales`, `shifts`, `sales_credit_memos`, `purchases`,
-- `supplier_ledger`, `driver_ledger`, `inventory_movements`, and 001's own
-- `sales.voided_by_user_id`) and 001's role CHECK already names exactly the
-- three roles Gate 2B needs — so nothing here has to touch the most dangerous
-- statement this codebase could run. Migration 022 wrote down at length why
-- that matters.
--
-- WHAT IS NOT HERE, DELIBERATELY
--
--   * NO SESSION TABLE. A session lives in Rust process memory. Persisting one
--     would create a credential at rest in a file that is copied to a USB stick
--     every evening, for no benefit: there is one window and one till, and a
--     session should not survive a restart.
--   * NO ROLE-PERMISSION TABLE. Three roles and ~26 operations belong in Rust
--     as data, reviewable in a diff and not editable at the till. A table would
--     be configuration nothing can configure.
--   * NO ACTOR-REQUIRED TRIGGERS. Making the actor mandatory before a session
--     can supply one would refuse writes the application cannot yet attribute.
--     That is migration 025, after Stage B.
--
-- THE LIMIT, STATED HERE BECAUSE IT IS EASY TO FORGET LATER
--
-- None of this encrypts the database. The file is unencrypted SQLite under the
-- Windows account that runs the application, so anybody who can run a program
-- on that account can read every hash below and can clear one to bypass login
-- entirely. That is not a defect in this migration; it is the boundary of what
-- an application-level control can do, and it is why the credential policy
-- (Argon2id, lockout, a passphrase rather than a PIN for owner and manager)
-- is written for an attacker who may eventually hold the file, and why the
-- deployment checklist — a separate non-administrator Windows account, a
-- password on it, screen lock, BitLocker — is worth more against that attacker
-- than everything in this file.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. THE CREDENTIAL, on the existing `users` row.
--
-- `pin_hash` is reused rather than replaced: it has existed since 001, it is
-- NULL everywhere, and replacing it would mean rebuilding `users`.
--
-- `credential_version` is the POLICY version, not the hash format — the hash
-- carries its own parameters in its PHC string. It exists so that raising the
-- Argon2id cost later can be detected and the credential rehashed on next
-- successful login, instead of the shop silently keeping a weaker one for ever.
--
-- `failed_attempts` and `locked_until` are PERSISTED, not in-memory. An
-- in-memory counter is reset by closing and reopening the application, which
-- is the first thing anybody guessing a PIN would try.
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN credential_algo       TEXT;
ALTER TABLE users ADD COLUMN credential_version    INTEGER;
ALTER TABLE users ADD COLUMN credential_set_at     TEXT;
ALTER TABLE users ADD COLUMN failed_attempts       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until          TEXT;
ALTER TABLE users ADD COLUMN must_change_pin       INTEGER NOT NULL DEFAULT 0;

-- A CREDENTIAL IS ALL THREE PARTS OR NONE OF THEM.
--
-- SQLite cannot add a CHECK by ALTER TABLE, so the rule is a trigger pair — and
-- it holds on UPDATE as well as INSERT, which is migration 021's lesson: a
-- guard that holds only for the one writer that does not need it is not a
-- guard. A row carrying a hash with no algorithm is a credential nothing can
-- verify, and a row carrying an algorithm with no hash is a login that can
-- never succeed; both are states the verifier would have to guess about.
CREATE TRIGGER IF NOT EXISTS trg_users_credential_coherent_ins
BEFORE INSERT ON users
WHEN ( (NEW.pin_hash           IS NOT NULL)
     + (NEW.credential_algo    IS NOT NULL)
     + (NEW.credential_set_at  IS NOT NULL) ) NOT IN (0, 3)
BEGIN
  SELECT RAISE(ABORT,
    'a credential is a hash plus an algorithm plus a date, or nothing at all');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_credential_coherent_upd
BEFORE UPDATE ON users
WHEN ( (NEW.pin_hash           IS NOT NULL)
     + (NEW.credential_algo    IS NOT NULL)
     + (NEW.credential_set_at  IS NOT NULL) ) NOT IN (0, 3)
BEGIN
  SELECT RAISE(ABORT,
    'a credential is a hash plus an algorithm plus a date, or nothing at all');
END;

-- The supported algorithm, and the bounds on the counters. Separate from the
-- coherence trigger so a refusal names the actual problem.
CREATE TRIGGER IF NOT EXISTS trg_users_credential_shape_ins
BEFORE INSERT ON users
WHEN (NEW.credential_algo IS NOT NULL AND NEW.credential_algo <> 'argon2id')
  OR NEW.failed_attempts < 0
  OR NEW.must_change_pin NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'unsupported credential algorithm or out-of-range auth state');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_credential_shape_upd
BEFORE UPDATE ON users
WHEN (NEW.credential_algo IS NOT NULL AND NEW.credential_algo <> 'argon2id')
  OR NEW.failed_attempts < 0
  OR NEW.must_change_pin NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'unsupported credential algorithm or out-of-range auth state');
END;


-- ----------------------------------------------------------------------------
-- 2. `auth_enrollment` — THE PER-STORE ENROLLMENT STATE MACHINE.
--
-- WHY THIS IS A PERSISTED ROW AND NOT AN INFERENCE
--
-- The obvious implementation of "does this installation need a first owner?" is
-- `SELECT count(*) FROM users WHERE pin_hash IS NOT NULL` — and it is wrong in
-- a way that matters on a POS. Two cases break it:
--
--   * A RESTORED DATABASE. The Gate 1 recovery procedure copies the database
--     file back from a USB stick. If bootstrap eligibility were inferred from
--     the absence of a hash, then any state in which the hash were missing —
--     including a support engineer clearing it to recover a forgotten
--     passphrase — would silently re-arm first-time bootstrap, and whoever
--     launched the application next would become the owner.
--   * AN UPGRADED DATABASE. A shop that has been trading for months on a
--     pre-023 build has no hash either. It must NOT be treated as a fresh
--     installation, because a fresh installation hands ownership to whoever is
--     standing there, and on an upgrade that is a cashier.
--
-- So the state is RECORDED, once, at the moment this migration applies, from
-- EVIDENCE — and the lifecycle trigger below makes `initialized` terminal, so
-- it can never be walked backwards by any writer.
--
-- THE EVIDENCE IS THE SHOP'S OWN HISTORY: a posted sale, a shift, a purchase, a
-- credit memo, a supplier or driver ledger entry, or an inventory movement. If
-- any of those exists the installation has TRADED, somebody owns it already,
-- and enrollment is `legacy_pending` — which requires naming which existing
-- owner row receives the credential rather than picking one.
--
-- A database with a configured catalogue but no documents is treated as
-- `virgin`. That is deliberate: nothing has happened that needs attributing to
-- a person, and both states require the same enrollment ceremony anyway. The
-- only difference is that `legacy_pending` must choose among existing owners
-- and `virgin` has exactly the one row 001 seeded.
--
-- THE ENROLLMENT CODE is high-entropy, single-use, time-limited, and stored
-- here only as an Argon2id hash. The plaintext is generated by Rust at first
-- launch and written to a file in the application's own config directory, which
-- is the installation ceremony: whoever can read that file at install time is
-- the trusted installer. It is NOT compiled into the binary, NOT in source, and
-- NOT written to ordinary application logs.
--
-- Be honest about what that ceremony is worth. On a single shared Windows
-- account, the cashier and the owner are the SAME operating-system principal,
-- so no in-application ceremony can tell them apart — the cashier could read
-- the file too. What the ceremony does buy is that ownership is never captured
-- by ACCIDENT, that capturing it requires a deliberate act, and that the act is
-- audited. What makes it a real control is the deployment checklist: a separate
-- non-administrator Windows account for the till, with a password only the
-- owner knows. That is stated in the operator documentation rather than
-- implied here.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_enrollment (
  store_id                  TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE RESTRICT,

  -- 'virgin'         — never provisioned, no trading history. Bootstrap allowed.
  -- 'legacy_pending' — pre-023 installation with history. Owner-assisted
  --                    enrollment required, naming which owner row.
  -- 'initialized'    — an owner credential exists. TERMINAL.
  state                     TEXT NOT NULL
                              CHECK (state IN ('virgin','legacy_pending','initialized')),

  -- The one-time enrollment material. Cleared when enrollment completes.
  enrollment_code_hash      TEXT,
  enrollment_code_algo      TEXT CHECK (enrollment_code_algo IS NULL
                                        OR enrollment_code_algo = 'argon2id'),
  enrollment_code_issued_at TEXT,
  enrollment_code_expires_at TEXT,

  -- Throttling on the enrollment code itself. Without this the code is a
  -- guessable secret with unlimited attempts, which is not a secret.
  enrollment_attempts       INTEGER NOT NULL DEFAULT 0
                              CHECK (enrollment_attempts >= 0),
  enrollment_locked_until   TEXT,

  initialized_at            TEXT,
  initialized_user_id       TEXT REFERENCES users(id) ON DELETE RESTRICT,

  created_at                TEXT NOT NULL
                              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL
                              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- `initialized` means a named user acquired a credential at a known time.
  -- The three facts travel together or the state is a claim about nothing.
  CHECK ( (state = 'initialized')
          = (initialized_at IS NOT NULL AND initialized_user_id IS NOT NULL) ),

  -- A live code is a hash plus an algorithm plus both timestamps, or nothing.
  CHECK ( ( (enrollment_code_hash       IS NOT NULL)
          + (enrollment_code_algo       IS NOT NULL)
          + (enrollment_code_issued_at  IS NOT NULL)
          + (enrollment_code_expires_at IS NOT NULL) ) IN (0, 4) )
);

-- Seeded from EVIDENCE, once, now. `INSERT OR IGNORE` so re-running this
-- migration on a database that somehow already has the row changes nothing.
INSERT OR IGNORE INTO auth_enrollment (store_id, state)
SELECT s.id,
       CASE
         WHEN EXISTS (SELECT 1 FROM sales                WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM shifts               WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM purchases            WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM sales_credit_memos   WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM supplier_ledger      WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM driver_ledger        WHERE store_id = s.id)
           OR EXISTS (SELECT 1 FROM inventory_movements  WHERE store_id = s.id)
         THEN 'legacy_pending'
         ELSE 'virgin'
       END
  FROM stores s;

-- `initialized` IS TERMINAL, and the identity of the row never moves.
--
-- This is the trigger that makes the restored-database case safe: once a store
-- has an owner credential, nothing — not a restore, not a support reset, not a
-- direct UPDATE — can put it back into a state where first-time bootstrap is
-- offered. A forgotten passphrase is recovered through `owner_recovery` (§3) or
-- by a support engineer setting a new credential, never by re-running
-- enrollment.
CREATE TRIGGER IF NOT EXISTS trg_auth_enrollment_lifecycle
BEFORE UPDATE ON auth_enrollment
WHEN NEW.store_id <> OLD.store_id
  OR (OLD.state = 'initialized'    AND NEW.state <> 'initialized')
  OR (OLD.state = 'legacy_pending' AND NEW.state NOT IN ('legacy_pending','initialized'))
  OR (OLD.state = 'virgin'         AND NEW.state NOT IN ('virgin','initialized'))
  OR (OLD.initialized_at      IS NOT NULL AND NEW.initialized_at      IS NOT OLD.initialized_at)
  OR (OLD.initialized_user_id IS NOT NULL AND NEW.initialized_user_id IS NOT OLD.initialized_user_id)
BEGIN
  SELECT RAISE(ABORT,
    'enrollment state may only move forward to initialized, and an initialized store keeps its owner and date');
END;

-- No store loses its enrollment record while it exists.
CREATE TRIGGER IF NOT EXISTS trg_auth_enrollment_no_delete
BEFORE DELETE ON auth_enrollment
BEGIN
  SELECT RAISE(ABORT, 'enrollment state is not deletable');
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_enrollment_updated_at
AFTER UPDATE ON auth_enrollment
BEGIN
  UPDATE auth_enrollment
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE store_id = NEW.store_id;
END;

-- An initialized store's owner must be an owner OF THAT STORE. Nothing else in
-- the schema says so, and a credential attached to another branch's row would
-- be an owner of a shop they have no claim on.
CREATE TRIGGER IF NOT EXISTS trg_auth_enrollment_owner_is_of_this_store
BEFORE UPDATE ON auth_enrollment
WHEN NEW.initialized_user_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id       = NEW.initialized_user_id
                    AND u.store_id = NEW.store_id
                    AND u.role     = 'owner')
BEGIN
  SELECT RAISE(ABORT, 'the enrolled owner must be an owner of this store');
END;


-- ----------------------------------------------------------------------------
-- 3. `owner_recovery` — the single-use owner recovery secret.
--
-- The honest limit is in the operator documentation and is repeated here: an
-- owner who has lost both the passphrase and the code is recovered by a support
-- engineer editing the database file. That is a real bypass and it is
-- unavoidable on an unencrypted local file. What this table buys is that the
-- SUPPORTED route is auditable and single-use, and that the unsupported route
-- leaves a visible gap in the audit trail (§4) rather than looking routine.
--
-- Recovery must never return the store to `virgin`: `auth_recover_owner` sets a
-- new credential on the SAME owner row and leaves `auth_enrollment.state` at
-- `initialized`, which §2's lifecycle trigger enforces regardless.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS owner_recovery (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  code_hash     TEXT NOT NULL,
  code_algo     TEXT NOT NULL CHECK (code_algo = 'argon2id'),
  issued_at     TEXT NOT NULL,
  -- NULL = live. Set once, when the code is spent.
  used_at       TEXT,
  -- Throttling, for the same reason as §2's.
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until  TEXT
);

-- AT MOST ONE LIVE CODE PER STORE, decided by the engine rather than by the
-- command that issues one. This is `ux_recipes_one_active` /
-- `ux_shifts_one_open_per_store` applied again: `auth_recover_owner` marks the
-- old code used and issues the replacement in ONE transaction, so there is
-- never a moment with two.
CREATE UNIQUE INDEX IF NOT EXISTS ux_owner_recovery_one_live
  ON owner_recovery(store_id) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_owner_recovery_store
  ON owner_recovery(store_id, issued_at);

-- A SPENT CODE IS SPENT. The secret, its algorithm, its store and its issue
-- date are immutable, and `used_at` can be set but never cleared or rewritten:
-- clearing it would make a code that has already been used live again, which is
-- the whole property this table exists to have.
CREATE TRIGGER IF NOT EXISTS trg_owner_recovery_append_only
BEFORE UPDATE ON owner_recovery
WHEN NEW.id        <> OLD.id
  OR NEW.store_id  <> OLD.store_id
  OR NEW.code_hash <> OLD.code_hash
  OR NEW.code_algo <> OLD.code_algo
  OR NEW.issued_at <> OLD.issued_at
  OR (OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at)
BEGIN
  SELECT RAISE(ABORT,
    'a recovery code is immutable; `used_at` may be set once and never cleared');
END;

CREATE TRIGGER IF NOT EXISTS trg_owner_recovery_no_delete
BEFORE DELETE ON owner_recovery
BEGIN
  SELECT RAISE(ABORT,
    'recovery codes are append-only: a spent code is evidence, not clutter');
END;


-- ----------------------------------------------------------------------------
-- 4. `auth_audit` — append-only security log.
--
-- Folded into 023 rather than kept as the separate 024 the implementation plan
-- proposed. The reason is a dependency the plan did not account for: Stage A.1
-- must audit from its very first line. `login_failed` and `locked_out` are the
-- only persistent record that somebody stood at the till trying PINs, and
-- shipping the login path one release before the table it writes to would mean
-- the first release of authentication keeps no evidence of attacks on itself.
-- The plan's §6.2 sequencing is otherwise unchanged; 025 is still last.
--
-- `detail` NEVER HOLDS A SECRET, a hash, a recovery code, an enrollment code or
-- any part of one. This is a rule about the writers, asserted by
-- `tests::auth_credentials`, because an audit table that leaks the secret it
-- audits is worse than no audit table. It also never holds a typed passphrase,
-- including a wrong one — a wrong guess is very often somebody else's right
-- password.
--
-- Protected from the renderer by `read_guard`: `auth_audit` is on the read
-- pool's denied-tables list, so a cashier cannot read the log of their own
-- failed attempts, and the owner reads it through a trusted command instead.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_audit (
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
                   -- Administration (Stage B writes these; the vocabulary is
                   -- stated now so the CHECK never has to be widened, which on
                   -- this table would mean a rebuild).
                   'role_changed','user_created','user_deactivated',
                   'permission_denied')),

  -- The subject. NULL when the attempt named no resolvable user — a login
  -- against an unknown id must still be recorded, which is why this is
  -- nullable and why the attempted identifier goes in `detail`.
  user_id        TEXT REFERENCES users(id) ON DELETE RESTRICT,
  -- Who performed it, when that is somebody else (an owner resetting a
  -- cashier's credential).
  actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
  -- The refused `Operation`, for `permission_denied`.
  operation      TEXT,
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_at    ON auth_audit(store_id, at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event ON auth_audit(store_id, event, at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user  ON auth_audit(user_id, at);

-- APPEND-ONLY, the `supplier_ledger` pattern (006). An audit row that can be
-- edited or deleted is a note, not evidence.
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

-- An audit row is filed against the store of the user it names. Without this a
-- multi-store database could record one branch's failed logins under another's,
-- and the owner reading their own log would not see them.
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
