-- ============================================================================
-- Lira POS — Initial schema (migration v1)
-- ----------------------------------------------------------------------------
-- Conventions:
--   * All primary keys are TEXT (UUIDv4 from the frontend).
--   * All monetary columns are INTEGER:
--       - *_usd_cents columns store USD in integer cents.
--       - *_lbp        columns store LBP in integer whole lira.
--       - *_rate       columns store INTEGER LBP per 1 USD.
--   * All percentage/rate columns are INTEGER basis points (1100 = 11.00%).
--   * Timestamps are TEXT ISO-8601 UTC (e.g. '2026-05-12T14:23:01Z').
--   * Booleans are INTEGER 0/1 with CHECK constraints.
--   * posted_at IS NOT NULL means the row is IMMUTABLE — triggers enforce this.
--
-- NEVER edit this file after shipping. Add a new migration instead.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STORES — physical locations / branches.
-- The MVP runs with exactly one seeded row, but every transactional table
-- references it so multi-store is a UI change, not a schema change.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  legal_name      TEXT,            -- For receipts / VAT compliance
  vat_number      TEXT,            -- Lebanese MoF VAT registration number
  address         TEXT,
  phone           TEXT,
  -- Display preferences
  default_currency TEXT NOT NULL DEFAULT 'USD'
                   CHECK (default_currency IN ('USD','LBP')),
  -- Audit
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- ----------------------------------------------------------------------------
-- USERS — cashiers, managers, owners. Local-only auth in Phase 1
-- (no password yet; PIN/password added in Phase 6 alongside cloud auth).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  full_name       TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin_hash        TEXT,            -- bcrypt/argon2 in Phase 6; NULL for now
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id, active);


-- ----------------------------------------------------------------------------
-- DEVICES — each physical machine that runs the app. The device_id stays
-- constant for the life of an install and stamps every transaction, which
-- becomes critical when multi-device sync arrives (conflict resolution).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,   -- e.g. "Front Counter Laptop"
  os              TEXT,            -- 'windows' / 'macos' / 'linux'
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- ----------------------------------------------------------------------------
-- VAT_RATES — temporal table. Never UPDATE a shipped row. To change the
-- standard rate, INSERT a new row and set effective_to on the old one.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vat_rates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,            -- e.g. "Standard 11%", "Zero-rated", "Exempt"
  rate_bps        INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  is_exempt       INTEGER NOT NULL DEFAULT 0 CHECK (is_exempt IN (0,1)),
  effective_from  TEXT NOT NULL,            -- ISO date; first day this rate applies
  effective_to    TEXT,                     -- NULL = still in force
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vat_effective ON vat_rates(effective_from, effective_to);


-- ----------------------------------------------------------------------------
-- PRODUCTS — the SKU catalog.
-- Stores BOTH excl-VAT and incl-VAT prices so display-time recomputation
-- never drifts from what the cashier originally typed (see schema notes).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                       TEXT PRIMARY KEY,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  sku                      TEXT,                    -- optional, may be barcode later
  name                     TEXT NOT NULL,
  description              TEXT,
  unit                     TEXT NOT NULL DEFAULT 'each',  -- 'each', 'kg', 'L', etc.

  -- VAT
  vat_rate_id              TEXT NOT NULL REFERENCES vat_rates(id) ON DELETE RESTRICT,
  vat_pricing_mode         TEXT NOT NULL
                           CHECK (vat_pricing_mode IN ('inclusive','exclusive')),

  -- Sale prices (BOTH stored, source-of-truth indicated by vat_pricing_mode)
  price_excl_vat_cents     INTEGER NOT NULL CHECK (price_excl_vat_cents >= 0),
  price_incl_vat_cents     INTEGER NOT NULL CHECK (price_incl_vat_cents >= 0),

  -- Cost (weighted average, USD only — Lebanese imports almost always priced in USD)
  avg_cost_excl_vat_cents  INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost_excl_vat_cents >= 0),
  avg_cost_incl_vat_cents  INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost_incl_vat_cents >= 0),

  -- Stock (kept denormalized for fast POS display; inventory_movements is the
  -- audit trail. A periodic recompute job can verify these stay in sync.)
  quantity_on_hand         INTEGER NOT NULL DEFAULT 0,
  reorder_point            INTEGER,

  -- Flags
  is_active                INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_service               INTEGER NOT NULL DEFAULT 0 CHECK (is_service IN (0,1)),
                           -- services don't decrement stock; future-proof now

  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_store_active ON products(store_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_name        ON products(store_id, name);


-- ----------------------------------------------------------------------------
-- EXCHANGE_RATES — daily LBP/USD rate.
-- One row per (store, effective_date). The POS always reads the most recent
-- row with effective_date <= today's local date.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchange_rates (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  effective_date  TEXT NOT NULL,                   -- 'YYYY-MM-DD' local date
  rate_lbp_per_usd INTEGER NOT NULL CHECK (rate_lbp_per_usd > 0),
  source          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','api','imported')),
  notes           TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_xr_store_date ON exchange_rates(store_id, effective_date DESC);


-- ----------------------------------------------------------------------------
-- INVENTORY_MOVEMENTS — the audit trail. Every change to quantity_on_hand
-- or avg_cost on a product MUST create a row here. Movements are immutable
-- once posted.
--
-- movement_type semantics:
--   'purchase'    — stock IN from supplier (recompute weighted avg cost)
--   'sale'        — stock OUT linked to a sale_item (snapshot cost)
--   'return_in'   — customer return (stock back IN, cost reversed)
--   'return_out'  — return to supplier (stock OUT, cost reversed)
--   'adjustment'  — manual +/- (shrinkage, count correction)
--   'transfer_in' / 'transfer_out' — multi-store, deferred
--   'opening'     — initial stock-on-hand when product first created
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id                      TEXT PRIMARY KEY,
  store_id                TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id              TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type           TEXT NOT NULL CHECK (movement_type IN (
                            'purchase','sale','return_in','return_out',
                            'adjustment','transfer_in','transfer_out','opening'
                          )),
  quantity_delta          INTEGER NOT NULL,        -- signed; +5 in, -3 out

  -- Cost snapshot at the time of this movement (in USD cents).
  -- For 'purchase'/'opening': cost we paid per unit.
  -- For 'sale'/'return_out':  weighted-avg cost at moment of sale (COGS).
  unit_cost_excl_vat_cents INTEGER NOT NULL DEFAULT 0,
  unit_cost_incl_vat_cents INTEGER NOT NULL DEFAULT 0,

  -- Optional links to source documents (FK NOT enforced cross-table on
  -- generic columns; the column name disambiguates).
  related_sale_id         TEXT REFERENCES sales(id) ON DELETE RESTRICT,
  related_sale_item_id    TEXT REFERENCES sale_items(id) ON DELETE RESTRICT,
  supplier_reference      TEXT,                    -- invoice no., bill of lading, etc.
  notes                   TEXT,

  created_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id               TEXT REFERENCES devices(id) ON DELETE SET NULL,
  posted_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_mov_product ON inventory_movements(product_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_mov_store   ON inventory_movements(store_id, posted_at DESC);


-- ----------------------------------------------------------------------------
-- SHIFTS — cash drawer / cashier session.
-- Open shift → take sales → close shift with declared cash counts.
-- Closing a shift computes expected vs actual and stores variance.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id                       TEXT PRIMARY KEY,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  device_id                TEXT REFERENCES devices(id) ON DELETE SET NULL,
  opened_by_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_by_user_id        TEXT REFERENCES users(id) ON DELETE RESTRICT,

  opened_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at                TEXT,

  -- Cash counts (declared by cashier at open/close)
  opening_cash_usd_cents   INTEGER NOT NULL DEFAULT 0,
  opening_cash_lbp         INTEGER NOT NULL DEFAULT 0,
  closing_cash_usd_cents   INTEGER,
  closing_cash_lbp         INTEGER,

  -- Computed at close-time (NULL until shift is closed)
  expected_cash_usd_cents  INTEGER,
  expected_cash_lbp        INTEGER,
  variance_usd_cents       INTEGER,    -- (closing - expected); negative = short
  variance_lbp             INTEGER,

  status                   TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','closed','voided')),
  notes                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_store_status ON shifts(store_id, status);
CREATE INDEX IF NOT EXISTS idx_shifts_opened       ON shifts(opened_at DESC);


-- ----------------------------------------------------------------------------
-- SALES — the header of a POS transaction.
-- Once posted_at IS NOT NULL, the row is IMMUTABLE (enforced by trigger).
-- The exchange rate USED at the moment of sale is locked here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id                       TEXT PRIMARY KEY,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  shift_id                 TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  device_id                TEXT REFERENCES devices(id) ON DELETE SET NULL,
  cashier_user_id          TEXT REFERENCES users(id) ON DELETE RESTRICT,

  -- Human-friendly sequential receipt number per store. Generated app-side
  -- inside a transaction to avoid races.
  receipt_number           INTEGER NOT NULL,

  -- Exchange rate LOCKED at sale time (LBP per 1 USD). Every payment row
  -- and downstream calc references this, not today's rate.
  exchange_rate_lbp_per_usd INTEGER NOT NULL CHECK (exchange_rate_lbp_per_usd > 0),
  exchange_rate_id         TEXT REFERENCES exchange_rates(id) ON DELETE RESTRICT,

  -- Totals (denormalized for fast list display; sale_items are the truth)
  subtotal_excl_vat_cents  INTEGER NOT NULL DEFAULT 0,
  vat_total_cents          INTEGER NOT NULL DEFAULT 0,
  total_incl_vat_cents     INTEGER NOT NULL DEFAULT 0,
  discount_cents           INTEGER NOT NULL DEFAULT 0,

  -- COGS total in USD cents (sum of sale_item COGS snapshots).
  -- gross_profit_cents = total_incl_vat_cents - vat_total_cents - cogs_total_cents - discount_cents
  cogs_total_cents         INTEGER NOT NULL DEFAULT 0,

  -- 'normal' for a sale, 'credit_memo' for a return/refund (Phase 4+).
  sale_type                TEXT NOT NULL DEFAULT 'normal'
                           CHECK (sale_type IN ('normal','credit_memo')),
  -- If credit_memo, points to the original sale.
  original_sale_id         TEXT REFERENCES sales(id) ON DELETE RESTRICT,

  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','posted','voided')),

  -- Timestamps
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- posted_at IS NOT NULL ⇒ row is immutable. Set when status moves to 'posted'.
  posted_at                TEXT,
  voided_at                TEXT,
  voided_by_user_id        TEXT REFERENCES users(id) ON DELETE RESTRICT,
  void_reason              TEXT,

  notes                    TEXT,
  UNIQUE (store_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS idx_sales_store_posted   ON sales(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_shift          ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_sales_status         ON sales(store_id, status);


-- ----------------------------------------------------------------------------
-- SALE_ITEMS — the lines of a sale. Snapshots EVERYTHING at posting time
-- (price, VAT rate, COGS) so historical sales never change retroactively.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id                            TEXT PRIMARY KEY,
  sale_id                       TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  store_id                      TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id                    TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Snapshots
  product_name_snapshot         TEXT NOT NULL,
  product_sku_snapshot          TEXT,
  vat_rate_id_snapshot          TEXT NOT NULL REFERENCES vat_rates(id) ON DELETE RESTRICT,
  vat_rate_bps_snapshot         INTEGER NOT NULL,

  -- Quantity (integer; for fractional units like '0.5 kg' we'll scale to
  -- grams at the data-entry layer in Phase 2 — keep DB integer-only).
  quantity                      INTEGER NOT NULL CHECK (quantity > 0),

  -- Per-unit snapshots (USD cents)
  unit_price_excl_vat_cents     INTEGER NOT NULL CHECK (unit_price_excl_vat_cents >= 0),
  unit_price_incl_vat_cents     INTEGER NOT NULL CHECK (unit_price_incl_vat_cents >= 0),

  -- Line totals (USD cents) — derived but stored for query speed
  line_subtotal_excl_vat_cents  INTEGER NOT NULL,
  line_vat_cents                INTEGER NOT NULL,
  line_total_incl_vat_cents     INTEGER NOT NULL,
  line_discount_cents           INTEGER NOT NULL DEFAULT 0,

  -- COGS snapshot (weighted-avg unit cost at sale time × quantity)
  unit_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0,
  line_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0,

  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);


-- ----------------------------------------------------------------------------
-- SALE_PAYMENTS — one row per tender. A single sale can have multiple rows
-- (split between USD cash, LBP cash, USD card, etc).
--
-- Always store the amount in the tender's native currency AND the USD-cent
-- equivalent computed at the LOCKED sale exchange rate. The USD equivalent
-- column is what daily-cash-collected-in-USD reports sum.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_payments (
  id                       TEXT PRIMARY KEY,
  sale_id                  TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  -- Phase 1: cash only. Card/wallet/bank-transfer in Phase 4+.
  method                   TEXT NOT NULL CHECK (method IN (
                             'cash_usd','cash_lbp','card_usd','card_lbp',
                             'bank_transfer','wallet','store_credit','other'
                           )),
  currency                 TEXT NOT NULL CHECK (currency IN ('USD','LBP')),

  -- Native amount: cents if USD, whole lira if LBP. EXACTLY ONE of these
  -- is meaningful per row; the other is 0. We don't union them into a
  -- single column because the unit is type-dependent and we want CHECKs.
  amount_native_usd_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_usd_cents >= 0),
  amount_native_lbp        INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_lbp >= 0),

  -- USD-cents equivalent at the LOCKED sale rate. This is what
  -- reports sum, what reconciles against the sale total.
  amount_usd_cents_equivalent INTEGER NOT NULL CHECK (amount_usd_cents_equivalent >= 0),

  -- For change given back (a positive value means cashier handed back
  -- this much to the customer). Stored separately so payment totals
  -- still equal what was actually tendered.
  change_given_usd_cents   INTEGER NOT NULL DEFAULT 0,
  change_given_lbp         INTEGER NOT NULL DEFAULT 0,

  reference                TEXT,  -- card last 4, transfer ref, etc.
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One of the two natives must be > 0 (zero-payment rows are invalid)
  CHECK ((amount_native_usd_cents > 0 AND currency = 'USD' AND amount_native_lbp = 0)
      OR (amount_native_lbp > 0 AND currency = 'LBP' AND amount_native_usd_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale  ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_store ON sale_payments(store_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- SYNC_QUEUE — outbound changes waiting for cloud upload.
-- Phase 1: the table exists and triggers populate it, but no uploader runs.
-- Phase 6: uploader consumes rows in order, marks them synced.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
  id              TEXT PRIMARY KEY,
  entity_table    TEXT NOT NULL,                   -- 'sales', 'products', etc.
  entity_id       TEXT NOT NULL,                   -- PK of the row
  operation       TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
  payload         TEXT NOT NULL,                   -- JSON snapshot
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','syncing','synced','failed','skipped')),
  enqueued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_queue(status, enqueued_at);


-- ----------------------------------------------------------------------------
-- APP_SETTINGS — global key/value config (last sync ts, store name override,
-- default currency display, etc). Single-row-per-key.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- ============================================================================
-- CHART OF ACCOUNTS — scaffolded for Phase 3+, empty/inert in Phase 1.
-- ----------------------------------------------------------------------------
-- This block lets us snap into double-entry posting later without a migration.
-- Phase 1 code DOES NOT WRITE to these tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  code            TEXT NOT NULL,                   -- '1000', '4000', etc.
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN (
                    'asset','liability','equity','revenue','expense','contra'
                  )),
  normal_balance  TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_id       TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  entry_date      TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  -- Source document (e.g. ('sale','<sale-uuid>')) — generic linkage.
  source_type     TEXT,
  source_id       TEXT,
  memo            TEXT,
  posted_at       TEXT,                            -- NULL = draft; immutable once set
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_je_store_date ON journal_entries(store_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_je_source     ON journal_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id              TEXT PRIMARY KEY,
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Exactly one of debit/credit must be > 0 per line.
  debit_usd_cents  INTEGER NOT NULL DEFAULT 0 CHECK (debit_usd_cents  >= 0),
  credit_usd_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_usd_cents >= 0),
  description     TEXT,
  CHECK ((debit_usd_cents > 0 AND credit_usd_cents = 0)
      OR (credit_usd_cents > 0 AND debit_usd_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_jl_entry   ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);


-- ============================================================================
-- IMMUTABILITY TRIGGERS — the safety net.
--
-- Once posted_at IS NOT NULL on a sale/sale_item/sale_payment/inventory_movement,
-- the row CANNOT be UPDATEd or DELETEd. Period. Buggy app code can't bypass this.
-- The only legal "correction" is a credit_memo sale, recorded as a new row.
-- ============================================================================

-- sales
CREATE TRIGGER IF NOT EXISTS trg_sales_no_update_after_post
BEFORE UPDATE ON sales
WHEN OLD.posted_at IS NOT NULL
  -- We DO allow status transitions to 'voided' and the matching void columns.
  AND NOT (
    NEW.status = 'voided'
    AND OLD.status = 'posted'
    AND NEW.id = OLD.id
    AND NEW.receipt_number = OLD.receipt_number
    AND NEW.total_incl_vat_cents = OLD.total_incl_vat_cents
    AND NEW.posted_at = OLD.posted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'Posted sales are immutable. Issue a credit memo instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sales_no_delete_after_post
BEFORE DELETE ON sales
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Posted sales cannot be deleted. Issue a credit memo instead.');
END;

-- sale_items — completely immutable once the parent sale is posted
CREATE TRIGGER IF NOT EXISTS trg_sale_items_no_update_after_post
BEFORE UPDATE ON sale_items
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Sale items of a posted sale are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_no_delete_after_post
BEFORE DELETE ON sale_items
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Sale items of a posted sale cannot be deleted.');
END;

-- sale_payments — same rule
CREATE TRIGGER IF NOT EXISTS trg_sale_payments_no_update_after_post
BEFORE UPDATE ON sale_payments
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Payments of a posted sale are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_no_delete_after_post
BEFORE DELETE ON sale_payments
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Payments of a posted sale cannot be deleted.');
END;

-- inventory_movements — append-only ledger
CREATE TRIGGER IF NOT EXISTS trg_inv_mov_no_update
BEFORE UPDATE ON inventory_movements
BEGIN
  SELECT RAISE(ABORT, 'Inventory movements are append-only. Post a reversing movement instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_inv_mov_no_delete
BEFORE DELETE ON inventory_movements
BEGIN
  SELECT RAISE(ABORT, 'Inventory movements cannot be deleted. Post a reversing movement instead.');
END;

-- journal_entries / journal_lines — same, once posted
CREATE TRIGGER IF NOT EXISTS trg_je_no_update_after_post
BEFORE UPDATE ON journal_entries
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Posted journal entries are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_je_no_delete_after_post
BEFORE DELETE ON journal_entries
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Posted journal entries cannot be deleted.');
END;


-- ============================================================================
-- AUTO-UPDATE TRIGGERS — keep updated_at fresh on mutable tables.
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_stores_updated_at
AFTER UPDATE ON stores
BEGIN
  UPDATE stores SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_updated_at
AFTER UPDATE ON products
BEGIN
  UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;


-- ============================================================================
-- SEED DATA — the bare minimum to make Phase 2 work.
-- ============================================================================

-- Single store (hard-coded UUID for the MVP)
INSERT OR IGNORE INTO stores (id, name, legal_name, default_currency)
VALUES ('00000000-0000-0000-0000-000000000001', 'Main Store', 'Main Store SARL', 'USD');

-- Default owner user
INSERT OR IGNORE INTO users (id, store_id, full_name, role)
VALUES ('00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'Owner', 'owner');

-- Current Lebanese VAT rate: 11% effective 2018-01-01
INSERT OR IGNORE INTO vat_rates (id, name, rate_bps, is_exempt, effective_from, notes)
VALUES ('00000000-0000-0000-0000-000000000010',
        'Standard 11%', 1100, 0, '2018-01-01',
        'Lebanese standard VAT rate per Law No. 64/2017');

-- Zero-rated (exports, etc.) and Exempt — useful to have for product setup
INSERT OR IGNORE INTO vat_rates (id, name, rate_bps, is_exempt, effective_from)
VALUES ('00000000-0000-0000-0000-000000000011',
        'Zero-rated 0%', 0, 0, '2018-01-01');

INSERT OR IGNORE INTO vat_rates (id, name, rate_bps, is_exempt, effective_from)
VALUES ('00000000-0000-0000-0000-000000000012',
        'Exempt', 0, 1, '2018-01-01');

-- Baseline chart of accounts (Lebanese retail flavor; codes follow common practice)
INSERT OR IGNORE INTO accounts (id, store_id, code, name, type, normal_balance) VALUES
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000001', '1010', 'Cash on Hand — USD',        'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', '1011', 'Cash on Hand — LBP',        'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', '1020', 'Bank — USD',                'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', '1021', 'Bank — LBP',                'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-000000000001', '1200', 'Accounts Receivable',       'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000120', '00000000-0000-0000-0000-000000000001', '1300', 'Inventory',                 'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000200', '00000000-0000-0000-0000-000000000001', '2100', 'Accounts Payable',          'liability', 'credit'),
  ('00000000-0000-0000-0000-000000000210', '00000000-0000-0000-0000-000000000001', '2200', 'VAT Payable',               'liability', 'credit'),
  ('00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000001', '2210', 'VAT Receivable (input)',    'asset',     'debit'),
  ('00000000-0000-0000-0000-000000000300', '00000000-0000-0000-0000-000000000001', '3000', 'Owner Equity',              'equity',    'credit'),
  ('00000000-0000-0000-0000-000000000310', '00000000-0000-0000-0000-000000000001', '3900', 'Retained Earnings',         'equity',    'credit'),
  ('00000000-0000-0000-0000-000000000400', '00000000-0000-0000-0000-000000000001', '4000', 'Sales Revenue',             'revenue',   'credit'),
  ('00000000-0000-0000-0000-000000000410', '00000000-0000-0000-0000-000000000001', '4100', 'Sales Returns & Allowances','contra',    'debit'),
  ('00000000-0000-0000-0000-000000000420', '00000000-0000-0000-0000-000000000001', '4200', 'Sales Discounts',           'contra',    'debit'),
  ('00000000-0000-0000-0000-000000000500', '00000000-0000-0000-0000-000000000001', '5000', 'Cost of Goods Sold',        'expense',   'debit'),
  ('00000000-0000-0000-0000-000000000510', '00000000-0000-0000-0000-000000000001', '5100', 'Inventory Adjustments',     'expense',   'debit'),
  ('00000000-0000-0000-0000-000000000520', '00000000-0000-0000-0000-000000000001', '5200', 'FX Gain / Loss',            'expense',   'debit');

-- App settings — initial values
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('schema_version', '1'),
  ('active_store_id', '00000000-0000-0000-0000-000000000001'),
  ('default_currency_display', 'USD'),
  ('last_cloud_sync_at', ''),
  ('next_receipt_number', '1');