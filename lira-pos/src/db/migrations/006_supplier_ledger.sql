-- src/db/migrations/006_supplier_ledger.sql
-- ============================================================================
-- Migration v6 — Supplier accounts payable ledger
-- ----------------------------------------------------------------------------
-- Tracks how much we owe each supplier as an append-only ledger.
-- Convention: positive amount means we owe more, negative means we owe less.
--   purchase        → + (we received goods on credit)
--   payment         → − (we paid down the balance)
--   credit_note     → − (supplier credited us, e.g. for returns)
--   opening_balance → ± (initial balance carried in from elsewhere)
--   adjustment      → ± (manual write-up/down — requires reason)
--
-- Why ledger over a materialized column: the audit trail is the point.
-- Balance is SUM(amount_cents). Mistakes are fixed by posting another row,
-- never by editing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplier_ledger (
  id                  TEXT PRIMARY KEY,
  store_id            TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,

  entry_type          TEXT NOT NULL CHECK (entry_type IN
                        ('purchase','payment','credit_note','opening_balance','adjustment')),

  -- Signed cents. + = we owe more; − = we owe less.
  amount_cents        INTEGER NOT NULL,

  -- Document date the user typed (local YYYY-MM-DD). For purchases this
  -- mirrors purchases.purchase_date.
  entry_date          TEXT NOT NULL,

  -- Free-form note. For 'adjustment' the UI requires this be non-empty.
  notes               TEXT,

  -- Source document linkage. Set when entry_type='purchase'.
  related_purchase_id TEXT REFERENCES purchases(id) ON DELETE RESTRICT,

  -- For payments: a reference the user types (e.g. wire ref, check no).
  payment_reference   TEXT,

  -- Audit
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id           TEXT REFERENCES devices(id) ON DELETE SET NULL,
  posted_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier  ON supplier_ledger(supplier_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_store     ON supplier_ledger(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_purchase  ON supplier_ledger(related_purchase_id);

-- Append-only.
CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_no_update
BEFORE UPDATE ON supplier_ledger
BEGIN
  SELECT RAISE(ABORT, 'Supplier ledger entries are immutable. Post a correcting entry instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_no_delete
BEFORE DELETE ON supplier_ledger
BEGIN
  SELECT RAISE(ABORT, 'Supplier ledger entries cannot be deleted.');
END;

-- ----------------------------------------------------------------------------
-- A convenience view: running balance per supplier.
-- Read-side only; never written to.
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS supplier_balances AS
SELECT
  s.id              AS supplier_id,
  s.store_id        AS store_id,
  s.name            AS supplier_name,
  COALESCE(SUM(l.amount_cents), 0) AS balance_cents,
  MAX(l.posted_at)  AS last_activity_at
FROM suppliers s
LEFT JOIN supplier_ledger l ON l.supplier_id = s.id
GROUP BY s.id;