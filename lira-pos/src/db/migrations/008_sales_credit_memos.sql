-- ============================================================================
-- Migration v8 — Sales Returns / Credit Memos
-- ----------------------------------------------------------------------------
-- A "credit memo" (cashier-facing: "Return / Refund") reverses part or all of
-- a posted sale: it refunds the customer and optionally returns stock.
--
-- Design notes (why dedicated tables instead of negative `sales` rows):
--   * sale_items.quantity has CHECK (quantity > 0) and sale_payments amounts
--     are CHECK (>= 0). Negative sales would violate these or force weakening
--     the checks — which the whole system relies on.
--   * Every existing report/shift query filters status='posted' WITHOUT
--     filtering sale_type. Reusing the sales table would silently fold returns
--     into sales totals with the wrong sign. Separate tables keep sales math
--     and existing posting 100% untouched; returns are layered additively.
--
-- Conventions match the rest of the schema:
--   * TEXT UUID primary keys; all money INTEGER (USD cents / whole LBP).
--   * posted_at IS NOT NULL ⇒ row is IMMUTABLE (triggers enforce it).
--   * Corrections are made via new rows, never edits.
--
-- Source of truth for every amount is the ORIGINAL posted sale_item snapshot,
-- prorated by returned quantity. Nothing is recomputed from current product
-- price / VAT / cost. Rounding is deterministic and always reconciles:
--   line_subtotal_excl_vat_cents + line_vat_cents = line_total_incl_vat_cents.
--
-- NEVER edit this file after shipping. Add a new migration instead.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SALES_CREDIT_MEMOS — header of a return. Always linked to one original sale.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memos (
  id                        TEXT PRIMARY KEY,
  store_id                  TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  original_sale_id          TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,

  -- Human-friendly sequential number per store (app-assigned in a tx).
  credit_memo_number        INTEGER NOT NULL,

  -- The shift the REFUND is processed in (drives cash-drawer impact). May be
  -- NULL if no shift is open, mirroring sales.shift_id nullability.
  shift_id                  TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  device_id                 TEXT REFERENCES devices(id) ON DELETE SET NULL,
  cashier_user_id           TEXT REFERENCES users(id) ON DELETE RESTRICT,

  -- Exchange rate LOCKED at refund time (LBP per 1 USD). Used to convert any
  -- LBP refund leg to its USD-cent equivalent. Mirrors sales.exchange_rate_*.
  exchange_rate_lbp_per_usd INTEGER NOT NULL CHECK (exchange_rate_lbp_per_usd > 0),
  exchange_rate_id          TEXT REFERENCES exchange_rates(id) ON DELETE RESTRICT,

  reason                    TEXT,

  -- Totals (USD cents) — sum of the credit memo lines, prorated from original.
  subtotal_excl_vat_cents   INTEGER NOT NULL DEFAULT 0,
  vat_total_cents           INTEGER NOT NULL DEFAULT 0,
  discount_cents            INTEGER NOT NULL DEFAULT 0,
  total_incl_vat_cents      INTEGER NOT NULL DEFAULT 0,

  -- COGS that was reversed back into inventory — ONLY the restocked portion.
  -- Lines refunded but not returned to stock contribute 0 here (the cost is
  -- retained as a write-off; their full margin is lost in profit reports).
  cogs_reversed_cents       INTEGER NOT NULL DEFAULT 0,

  -- USD-cent equivalent of all refund legs at the locked rate (== total).
  refund_total_usd_cents    INTEGER NOT NULL DEFAULT 0,

  status                    TEXT NOT NULL DEFAULT 'posted'
                            CHECK (status IN ('posted','voided')),

  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- posted_at IS NOT NULL ⇒ immutable.
  posted_at                 TEXT,
  voided_at                 TEXT,
  voided_by_user_id         TEXT REFERENCES users(id) ON DELETE RESTRICT,
  void_reason               TEXT,

  notes                     TEXT,
  UNIQUE (store_id, credit_memo_number)
);
CREATE INDEX IF NOT EXISTS idx_credit_memos_store_posted ON sales_credit_memos(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_memos_original     ON sales_credit_memos(original_sale_id);
CREATE INDEX IF NOT EXISTS idx_credit_memos_shift        ON sales_credit_memos(shift_id);
CREATE INDEX IF NOT EXISTS idx_credit_memos_status       ON sales_credit_memos(store_id, status);


-- ----------------------------------------------------------------------------
-- SALES_CREDIT_MEMO_LINES — the returned lines. Each references exactly one
-- original sale_item; the (memo, original_sale_item) pairing plus quantity is
-- what bounds over-returning. Every monetary value is prorated from the
-- original sale_item snapshot, never recomputed from live product data.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memo_lines (
  id                            TEXT PRIMARY KEY,
  credit_memo_id                TEXT NOT NULL REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,
  store_id                      TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  original_sale_item_id         TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  product_id                    TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Snapshots (copied from the original sale_item — frozen).
  product_name_snapshot         TEXT NOT NULL,
  product_sku_snapshot          TEXT,
  vat_rate_id_snapshot          TEXT NOT NULL REFERENCES vat_rates(id) ON DELETE RESTRICT,
  vat_rate_bps_snapshot         INTEGER NOT NULL,

  -- Returned quantity (canonical base UoM) + display UoM, snapshotted.
  quantity_base                 INTEGER NOT NULL CHECK (quantity_base > 0),
  quantity_in_uom               INTEGER,
  uom_code_snapshot             TEXT,
  factor_num_snapshot           INTEGER,
  factor_den_snapshot           INTEGER,

  -- Per-unit price snapshots (USD cents) — copied verbatim from the original.
  unit_price_excl_vat_cents     INTEGER NOT NULL CHECK (unit_price_excl_vat_cents >= 0),
  unit_price_incl_vat_cents     INTEGER NOT NULL CHECK (unit_price_incl_vat_cents >= 0),

  -- Prorated line totals (USD cents): subtotal + vat = total, by construction.
  line_subtotal_excl_vat_cents  INTEGER NOT NULL,
  line_vat_cents                INTEGER NOT NULL,
  line_total_incl_vat_cents     INTEGER NOT NULL,
  line_discount_cents           INTEGER NOT NULL DEFAULT 0,

  -- COGS snapshot (original unit COGS × returned base qty). Stored regardless
  -- of restock; only counted toward cogs_reversed when return_to_stock = 1.
  unit_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0,
  line_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0,

  -- Snapshot of the product's service flag at return time (services never
  -- move stock, mirroring sale posting).
  is_service                    INTEGER NOT NULL DEFAULT 0 CHECK (is_service IN (0,1)),

  -- Whether this line put stock back. Forced 0 for services. Default 1 for
  -- stock products (the cashier can turn it off to write off damaged goods).
  return_to_stock               INTEGER NOT NULL DEFAULT 1 CHECK (return_to_stock IN (0,1)),

  -- The 'return_in' inventory movement this line created (NULL if not restocked).
  related_movement_id           TEXT REFERENCES inventory_movements(id) ON DELETE RESTRICT,

  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_memo     ON sales_credit_memo_lines(credit_memo_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_orig_item ON sales_credit_memo_lines(original_sale_item_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_product  ON sales_credit_memo_lines(product_id);


-- ----------------------------------------------------------------------------
-- SALES_CREDIT_MEMO_REFUNDS — one row per refund tender, mirroring the shape
-- of sale_payments (split between cash USD / cash LBP / card USD, etc).
-- The sum of amount_usd_cents_equivalent equals the memo total exactly.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memo_refunds (
  id                          TEXT PRIMARY KEY,
  credit_memo_id              TEXT NOT NULL REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,
  store_id                    TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  method                      TEXT NOT NULL CHECK (method IN (
                                'cash_usd','cash_lbp','card_usd','card_lbp',
                                'bank_transfer','wallet','store_credit','other'
                              )),
  currency                    TEXT NOT NULL CHECK (currency IN ('USD','LBP')),

  -- Native amount: cents if USD, whole lira if LBP. Exactly one is meaningful.
  amount_native_usd_cents     INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_usd_cents >= 0),
  amount_native_lbp           INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_lbp >= 0),

  -- USD-cents equivalent at the memo's locked rate. Reports sum this.
  amount_usd_cents_equivalent INTEGER NOT NULL CHECK (amount_usd_cents_equivalent >= 0),

  reference                   TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Exactly one native amount must be > 0, consistent with the currency.
  CHECK ((amount_native_usd_cents > 0 AND currency = 'USD' AND amount_native_lbp = 0)
      OR (amount_native_lbp > 0 AND currency = 'LBP' AND amount_native_usd_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_memo  ON sales_credit_memo_refunds(credit_memo_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_store ON sales_credit_memo_refunds(store_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- Link inventory_movements back to a credit memo document. Symmetric with the
-- related_sale_id / related_purchase_id columns already present. A restock
-- movement also sets related_sale_id/related_sale_item_id to the ORIGINAL sale
-- so the product ledger stays coherent.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN related_credit_memo_id      TEXT
  REFERENCES sales_credit_memos(id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements ADD COLUMN related_credit_memo_line_id TEXT
  REFERENCES sales_credit_memo_lines(id) ON DELETE RESTRICT;


-- ----------------------------------------------------------------------------
-- IMMUTABILITY TRIGGERS — same pattern as sales / purchases.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_credit_memos_no_update_after_post
BEFORE UPDATE ON sales_credit_memos
WHEN OLD.posted_at IS NOT NULL
  -- Allow only status→voided + matching void columns.
  AND NOT (
    NEW.status = 'voided'
    AND OLD.status = 'posted'
    AND NEW.id = OLD.id
    AND NEW.credit_memo_number = OLD.credit_memo_number
    AND NEW.total_incl_vat_cents = OLD.total_incl_vat_cents
    AND NEW.posted_at = OLD.posted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'Posted credit memos are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memos_no_delete_after_post
BEFORE DELETE ON sales_credit_memos
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Posted credit memos cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_update_after_post
BEFORE UPDATE ON sales_credit_memo_lines
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Lines of a posted credit memo are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_delete_after_post
BEFORE DELETE ON sales_credit_memo_lines
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Lines of a posted credit memo cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_update_after_post
BEFORE UPDATE ON sales_credit_memo_refunds
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Refunds of a posted credit memo are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_delete_after_post
BEFORE DELETE ON sales_credit_memo_refunds
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Refunds of a posted credit memo cannot be deleted.');
END;


-- ----------------------------------------------------------------------------
-- App settings — credit memo number sequence.
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('next_credit_memo_number', '1');
