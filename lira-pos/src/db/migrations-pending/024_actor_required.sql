-- ============================================================================
-- Migration v24 — A NEW FINANCIAL DOCUMENT MUST NAME A REAL ACTOR
--                 (Gate 2B, Stage B.2b)
-- ----------------------------------------------------------------------------
-- NUMBERED 024, NOT 025. The Gate 2B plan proposed 023 authentication, 024
-- audit, 025 actor triggers. The audit table was folded into 023 because the
-- login path has to audit from its very first line — shipping it one release
-- later would have meant the first release of authentication kept no record of
-- attacks on itself — so 024 was free and the numbering stays contiguous. The
-- planning documents' "025" and this file are the same migration.
-- ----------------------------------------------------------------------------
-- WHAT THIS ADDS, AND WHY IT COMES LAST
--
-- Stage A.1 gave Greaz a session. Stage B.1 made the three roles into
-- permissions. Stage B.2 made the actor on a new document come from that
-- session, with the request's own copy demoted to a cross-check that is refused
-- on disagreement. This migration is the engine's half of that: it makes the
-- actor MANDATORY, so the rule holds for a writer that never goes through
-- `posting.rs` at all — a future screen, an import, a script, a second
-- terminal, a support engineer with a SQL prompt.
--
-- It is LAST on purpose, and the sequencing is not a preference. Making the
-- actor mandatory before a session existed would have refused writes the
-- application could not yet attribute: every command took its actor from the
-- request, and `NULL` was always available. So this trigger set is useless
-- before Stage B.2 and unsafe before Stage A.1.
--
-- WHAT IT ASSERTS — three things, not one
--
-- For each new row: the named user EXISTS, is ACTIVE, and belongs to the
-- DOCUMENT'S OWN STORE. The third is the one a first draft omits, and it is the
-- one that matters most in a multi-store database: a document of branch A
-- attributed to a member of branch B's staff is a document nobody at A can
-- answer for, and the foreign key alone permits it. Migration 022 had to close
-- that same cross-store hole twice for recipe lines.
--
-- HISTORY IS NOT TOUCHED. Every trigger is BEFORE INSERT, so the rules bind
-- writes from the moment this migration applies and read no existing row. Every
-- NULL actor already recorded stays exactly as it was recorded, stays readable,
-- and stays replayable — which is required, because an idempotent retry of a
-- historical document must still resolve to it. `sales.cashier_user_id` and the
-- rest therefore stay NULLABLE in the schema: the rule governs what may be
-- written from now on, and the past is not restated. That is the same position
-- migration 017 took on shifts and 019 took on the demo catalogue.
--
-- NOT A COLUMN CHANGE. Making the columns `NOT NULL` would mean rebuilding
-- `sales`, `purchases`, `inventory_movements` and three more — tables
-- referenced by most of the schema — and it would refuse every historical row
-- on the way. A `BEFORE INSERT` trigger achieves the forward-only rule with no
-- table rebuild and no restatement, which is this codebase's established
-- pattern for exactly this situation.
--
-- THE ONE-WAY DOOR, STATED PLAINLY BECAUSE IT IS THE COMPATIBILITY COST
--
-- After this migration a database will refuse a new financial document that
-- names no actor. A PRE-STAGE-B BINARY SENDS EXACTLY THAT, because its commands
-- bound the actor from a request that often left it NULL. So an older build
-- CANNOT POST against a v24 database, and rolling back past this point needs
-- the backup taken before the upgrade — which `docs/BACKUP.md` already
-- instructs the operator to take before every upgrade, and which GZ-WAL-01's
-- startup validation independently requires by refusing a database whose
-- migration history is ahead of the binary.
--
-- Dropping the six triggers by hand would let an older build post again. That
-- is an EMERGENCY MEASURE, not an option: it removes the only engine-level
-- guarantee that a posted document can be answered for, and its absence is
-- visible afterwards precisely because the triggers are gone. It is recorded
-- here rather than in a support note so that anybody reading the schema finds
-- it.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   * `sales.voided_by_user_id` and its siblings. No void command exists in any
--     shipped build, so a rule about who may be named in one would be a guess
--     about a workflow that has not been designed.
--   * `shifts.opened_by_user_id` is already `NOT NULL` (migration 001), so it
--     needs no existence rule — but it does get the ACTIVE and SAME-STORE
--     proofs, which 001 never made.
--   * Nothing about `role`. Whether a cashier may refund is a question for
--     `authz::permits`, which is Rust the renderer cannot edit. A role rule in
--     SQL would be a second copy of the permission matrix, in the one place
--     this application cannot defend, and the two would drift.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A reusable shape, written out per table because SQLite has no way to share a
-- trigger body. Each one reads:
--
--     the actor is NULL  ->  refuse
--     OR no active user of THIS document's store has that id  ->  refuse
--
-- `NEW.store_id` is used rather than a literal, so the rule is per-document and
-- a multi-store database is covered without the triggers knowing how many
-- stores there are.
-- ----------------------------------------------------------------------------

-- SALES ----------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_sales_actor_required
BEFORE INSERT ON sales
WHEN NEW.cashier_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.cashier_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new sale must name an active user of its own store as the cashier');
END;

-- CREDIT MEMOS (refunds) -----------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_credit_memos_actor_required
BEFORE INSERT ON sales_credit_memos
WHEN NEW.cashier_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.cashier_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new credit memo must name an active user of its own store as the cashier');
END;

-- PURCHASES ------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_purchases_actor_required
BEFORE INSERT ON purchases
WHEN NEW.created_by_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.created_by_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new purchase must name an active user of its own store as its buyer');
END;

-- SUPPLIER LEDGER ------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_actor_required
BEFORE INSERT ON supplier_ledger
WHEN NEW.created_by_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.created_by_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new supplier ledger entry must name an active user of its own store');
END;

-- DRIVER LEDGER --------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_actor_required
BEFORE INSERT ON driver_ledger
WHEN NEW.created_by_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.created_by_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new driver ledger entry must name an active user of its own store');
END;

-- INVENTORY MOVEMENTS --------------------------------------------------------
--
-- This is the one that makes the stock trail answerable. `quantity_on_hand` and
-- `avg_cost_*` are maintained alongside these rows precisely so the quantity
-- and the value of the shelf agree; a movement nobody is named on is a stock
-- change nobody can be asked about.
CREATE TRIGGER IF NOT EXISTS trg_inventory_movements_actor_required
BEFORE INSERT ON inventory_movements
WHEN NEW.created_by_user_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.created_by_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
BEGIN
  SELECT RAISE(ABORT,
    'a new inventory movement must name an active user of its own store');
END;

-- SHIFTS ---------------------------------------------------------------------
--
-- `opened_by_user_id` is already NOT NULL from migration 001, so existence is
-- settled. What 001 never proved is that the person is ACTIVE and belongs to
-- this store — and a shift is what every drawer figure is reconciled against,
-- so the person it names is the person the variance is put to.
--
-- `closed_by_user_id` is checked only when present: a shift is INSERTed open,
-- with no closer, and acquires one by UPDATE when it closes. That UPDATE is
-- governed by migration 009's immutability trigger and by `close_shift`, which
-- since Stage B.2 takes its closer from the session.
CREATE TRIGGER IF NOT EXISTS trg_shifts_actor_required
BEFORE INSERT ON shifts
WHEN NOT EXISTS (SELECT 1 FROM users u
                  WHERE u.id = NEW.opened_by_user_id
                    AND u.store_id = NEW.store_id
                    AND u.active = 1)
   OR (NEW.closed_by_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users u
                        WHERE u.id = NEW.closed_by_user_id
                          AND u.store_id = NEW.store_id
                          AND u.active = 1))
BEGIN
  SELECT RAISE(ABORT,
    'a shift must be opened by an active user of its own store');
END;
