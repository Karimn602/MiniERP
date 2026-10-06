/**
 * SQL / read-model test harness.
 *
 * SCOPE — read this before adding tests here.
 *
 * This layer runs the repositories' SQL against a real SQLite engine
 * (`node:sqlite`) so query logic can be tested in Node. It is NOT an
 * end-to-end Tauri test: `@tauri-apps/plugin-sql` is replaced, the Rust
 * posting commands are not involved, and rows are inserted by the fixtures
 * below rather than by `post_sale` / `post_purchase`.
 *
 * The authoritative database and posting integration layer is the Rust suite
 * in `src-tauri/src/tests/`. Use this layer only for read-model behaviour:
 * reports, shift summaries, aggregation and grouping.
 *
 * Safety: every database here is `:memory:`. The production `greaz-pos.db`
 * is never opened — `assertInMemory` enforces it.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { centsToMicrocents, microcentsToCents } from "../../src/lib/cost";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/db/migrations", import.meta.url));

const IN_MEMORY = ":memory:";

function assertInMemory(location: string): void {
  if (location !== IN_MEMORY) {
    throw new Error(
      `SQL tests may only open an in-memory database, refusing "${location}". ` +
        "The production greaz-pos.db must never be opened by a test.",
    );
  }
}

/** The application's migration files, in version order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

/**
 * A fresh in-memory database with every migration applied in order.
 *
 * Note: this applies the migration SQL directly. The sqlx migration runner
 * (versioning, checksums, `_sqlx_migrations`) is exercised by the Rust suite,
 * which is the authority on migration behaviour.
 */
export function createSqlTestDb(): DatabaseSync {
  assertInMemory(IN_MEMORY);
  const db = new DatabaseSync(IN_MEMORY);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles()) {
    db.exec(readFileSync(file, "utf8"));
  }
  return db;
}

// ============================================================================
// Seeded IDs (from migration 001) and fixture constants
// ============================================================================

export const STORE_ID = "00000000-0000-0000-0000-000000000001";
export const USER_ID = "00000000-0000-0000-0000-000000000002";
export const VAT_STD_ID = "00000000-0000-0000-0000-000000000010";
export const VAT_EXEMPT_ID = "00000000-0000-0000-0000-000000000012";
export const VAT_STD_BPS = 1100;
export const RATE_ID = "00000000-0000-0000-0000-00000000e001";
export const RATE_LBP_PER_USD = 89_500;

let seq = 0;
export function id(prefix = "row"): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

/** Reset the id counter so each test file starts from a known state. */
export function resetIds(): void {
  seq = 0;
}

// ============================================================================
// Fixtures
//
// These insert rows in the SHAPE the Rust posting commands produce. In
// particular, sale line values are POST-discount and the header discount is
// recorded separately — exactly what PosRegister sends and post_sale persists.
// ============================================================================

export function seedExchangeRate(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
     VALUES (?, ?, '2026-01-01', ?, 'manual')`,
  ).run(RATE_ID, STORE_ID, RATE_LBP_PER_USD);
}

export function seedProduct(
  db: DatabaseSync,
  opts: { id: string; sku: string; name: string; vatRateId?: string; isService?: boolean },
): string {
  db.prepare(
    `INSERT INTO products (
       id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
       price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, is_active, is_service
     ) VALUES (?, ?, ?, ?, ?, 'inclusive', 450, 500, 100, 1, ?)`,
  ).run(
    opts.id,
    STORE_ID,
    opts.sku,
    opts.name,
    opts.vatRateId ?? VAT_STD_ID,
    opts.isService ? 1 : 0,
  );
  return opts.id;
}

/**
 * A shift for the fixture store.
 *
 * `status` defaults to `'open'`, and since migration 009 a store may hold only
 * one open shift at a time — a test that needs a second shift to exist
 * alongside it must seed that one as `'closed'`, which is what a real handover
 * produces anyway.
 */
export function seedShift(
  db: DatabaseSync,
  opts: {
    id: string;
    openingUsdCents?: number;
    openingLbp?: number;
    status?: "open" | "closed";
  },
): string {
  const closed = opts.status === "closed";
  db.prepare(
    `INSERT INTO shifts (
       id, store_id, opened_by_user_id, opened_at,
       closed_at, closed_by_user_id,
       opening_cash_usd_cents, opening_cash_lbp, status
     ) VALUES (?, ?, ?, '2026-03-01T08:00:00.000Z', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    STORE_ID,
    USER_ID,
    closed ? "2026-03-01T16:00:00.000Z" : null,
    closed ? USER_ID : null,
    opts.openingUsdCents ?? 0,
    opts.openingLbp ?? 0,
    closed ? "closed" : "open",
  );
  return opts.id;
}

export interface SaleLineFixture {
  productId: string;
  /**
   * The name and SKU as the RECEIPT recorded them, which is what
   * `sale_items.product_*_snapshot` holds. A fixture may vary them between
   * sales of one product to reproduce a rename or a re-SKU — the case that
   * makes `reportsRepo.productSales` legitimately return several rows for one
   * `product_id`.
   */
  productName: string;
  productSku?: string | null;
  /** Base-unit quantity, as `sale_items.quantity` stores it. */
  quantity: number;
  /** POST-discount line figures, matching what post_sale persists. */
  subtotalExclVat: number;
  vat: number;
  totalInclVat: number;
  lineDiscount?: number;
  cogs?: number;
  vatRateId?: string;
  vatBps?: number;
}

export interface PaymentFixture {
  method: string;
  currency: "USD" | "LBP";
  nativeUsdCents?: number;
  nativeLbp?: number;
  usdEquivalent: number;
  changeUsdCents?: number;
  changeLbp?: number;
}

export interface SaleFixture {
  postedAt: string;
  shiftId?: string | null;
  /** Header discount in cents. Lines are already net of it. */
  discountCents?: number;
  status?: "posted" | "draft" | "voided";
  lines: SaleLineFixture[];
  payments: PaymentFixture[];
}

/**
 * Insert a sale exactly as `post_sale` would have persisted it.
 *
 * Built as a DRAFT and promoted at the end, because since migration 012 a
 * POSTED sale takes no further children — so inserting a posted header and
 * then its lines would be a shortcut the production command cannot take
 * either. The committed row state is identical; only the order differs, which
 * is exactly the order `post_sale` uses since WP-07.
 */
export function insertSale(db: DatabaseSync, sale: SaleFixture): string {
  const saleId = id("sale");
  const subtotal = sale.lines.reduce((s, l) => s + l.subtotalExclVat, 0);
  const vat = sale.lines.reduce((s, l) => s + l.vat, 0);
  const total = sale.lines.reduce((s, l) => s + l.totalInclVat, 0);
  const cogs = sale.lines.reduce((s, l) => s + (l.cogs ?? 0), 0);

  db.prepare(
    `INSERT INTO sales (
       id, store_id, shift_id, cashier_user_id, receipt_number,
       exchange_rate_lbp_per_usd, exchange_rate_id,
       subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
       discount_cents, cogs_total_cents, cogs_method,
       sale_type, status, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'weighted_average', 'normal', 'draft', NULL)`,
  ).run(
    saleId,
    STORE_ID,
    sale.shiftId ?? null,
    USER_ID,
    nextReceiptNumber(db),
    RATE_LBP_PER_USD,
    RATE_ID,
    subtotal,
    vat,
    total,
    sale.discountCents ?? 0,
    cogs,
  );

  for (const line of sale.lines) {
    db.prepare(
      `INSERT INTO sale_items (
         id, sale_id, store_id, product_id,
         product_name_snapshot, product_sku_snapshot,
         vat_rate_id_snapshot, vat_rate_bps_snapshot,
         quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
         line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
         line_discount_cents,
         unit_cogs_excl_vat_cents, unit_cogs_excl_vat_microcents,
         line_cogs_excl_vat_cents,
         quantity_in_uom, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'each', 1, 1)`,
    ).run(
      id("item"),
      saleId,
      STORE_ID,
      line.productId,
      line.productName,
      line.productSku ?? null,
      line.vatRateId ?? VAT_STD_ID,
      line.vatBps ?? VAT_STD_BPS,
      line.quantity,
      Math.round(line.subtotalExclVat / line.quantity),
      Math.round(line.totalInclVat / line.quantity),
      line.subtotalExclVat,
      line.vat,
      line.totalInclVat,
      line.lineDiscount ?? 0,
      // `post_sale` stores a per-unit COGS RATE in microcents and the line
      // amount in cents (WP-03). The fixture derives both from the line COGS the
      // test states, so the shape matches what the real command persists.
      Math.round((line.cogs ?? 0) / line.quantity),
      Math.round(centsToMicrocents(line.cogs ?? 0) / line.quantity),
      line.cogs ?? 0,
      line.quantity,
    );
  }

  for (const p of sale.payments) {
    db.prepare(
      `INSERT INTO sale_payments (
         id, sale_id, store_id, method, currency,
         amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
         change_given_usd_cents, change_given_lbp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id("pay"),
      saleId,
      STORE_ID,
      p.method,
      p.currency,
      p.nativeUsdCents ?? 0,
      p.nativeLbp ?? 0,
      p.usdEquivalent,
      p.changeUsdCents ?? 0,
      p.changeLbp ?? 0,
    );
  }

  // Seal it, exactly as `post_sale`'s last statement does.
  db.prepare(
    `UPDATE sales SET status = ?, posted_at = ? WHERE id = ? AND status = 'draft'`,
  ).run(sale.status ?? "posted", sale.postedAt, saleId);

  return saleId;
}

function nextReceiptNumber(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(receipt_number), 0) AS n FROM sales").get() as {
    n: number;
  };
  return row.n + 1;
}

export interface PurchaseItemFixture {
  productId: string;
  productName: string;
  quantityBase: number;
  unitCostExclVatBaseMicrocents: number;
}

/**
 * Insert a purchase as `post_purchase` would have persisted it.
 *
 * Built as a DRAFT, its `lines` written, and promoted at the end — the order
 * `post_purchase` itself uses, and the only order migration 012 permits: a
 * POSTED purchase takes no further lines, so a fixture cannot insert a posted
 * header and then add to it. Lines must therefore be passed in rather than
 * attached afterwards.
 */
export function insertPurchase(
  db: DatabaseSync,
  opts: {
    purchaseDate: string;
    subtotalExclVat: number;
    vat: number;
    status?: "posted" | "draft";
    lines?: PurchaseItemFixture[];
  },
): string {
  const purchaseId = id("purchase");
  const row = db.prepare("SELECT COALESCE(MAX(purchase_number), 0) AS n FROM purchases").get() as {
    n: number;
  };
  db.prepare(
    `INSERT INTO purchases (
       id, store_id, purchase_type, purchase_number, purchase_date,
       subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
       status, posted_at
     ) VALUES (?, ?, 'opening', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    purchaseId,
    STORE_ID,
    row.n + 1,
    opts.purchaseDate,
    opts.subtotalExclVat,
    opts.vat,
    opts.subtotalExclVat + opts.vat,
    "draft",
    null,
  );

  for (const line of opts.lines ?? []) {
    insertPurchaseItem(db, { purchaseId, ...line });
  }

  // Seal it, exactly as `post_purchase`'s last statement does.
  db.prepare(
    `UPDATE purchases SET status = ?, posted_at = ? WHERE id = ? AND status = 'draft'`,
  ).run(
    opts.status ?? "posted",
    `${opts.purchaseDate}T10:00:00.000Z`,
    purchaseId,
  );
  return purchaseId;
}

/**
 * Give a seeded product a stock level and a weighted-average cost, stated as a
 * RATE in microcents (WP-03). The rounded `*_cents` mirror is maintained
 * alongside, exactly as `post_purchase` maintains it — a fixture that set only
 * one of the pair would not match anything the real command writes.
 */
export function seedProductCost(
  db: DatabaseSync,
  opts: {
    productId: string;
    quantityOnHand: number;
    avgCostExclVatMicrocents: number;
    avgCostInclVatMicrocents?: number;
  },
): void {
  const incl = opts.avgCostInclVatMicrocents ?? opts.avgCostExclVatMicrocents;
  db.prepare(
    `UPDATE products
        SET quantity_on_hand             = ?,
            avg_cost_excl_vat_microcents = ?,
            avg_cost_incl_vat_microcents = ?,
            avg_cost_excl_vat_cents      = ?,
            avg_cost_incl_vat_cents      = ?
      WHERE id = ?`,
  ).run(
    opts.quantityOnHand,
    opts.avgCostExclVatMicrocents,
    incl,
    microcentsToCents(opts.avgCostExclVatMicrocents),
    microcentsToCents(incl),
    opts.productId,
  );
}

/**
 * A purchase line on an existing purchase, carrying a per-base cost rate in
 * microcents. `productsRepo.listForValuation` reads the latest of these as the
 * product's last purchase cost.
 */
export function insertPurchaseItem(
  db: DatabaseSync,
  opts: {
    purchaseId: string;
    productId: string;
    productName: string;
    quantityBase: number;
    unitCostExclVatBaseMicrocents: number;
  },
): string {
  const itemId = id("purchase-item");
  db.prepare(
    `INSERT INTO purchase_items (
       id, purchase_id, store_id, product_id, product_name_snapshot,
       uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
       quantity_in_uom, quantity_base,
       unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
       unit_cost_excl_vat_base_cents, unit_cost_incl_vat_base_cents,
       unit_cost_excl_vat_base_microcents, unit_cost_incl_vat_base_microcents,
       vat_rate_id_snapshot, vat_rate_bps_snapshot,
       line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
     ) VALUES (?, ?, ?, ?, ?, 'each', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    itemId,
    opts.purchaseId,
    STORE_ID,
    opts.productId,
    opts.productName,
    opts.quantityBase,
    opts.quantityBase,
    microcentsToCents(opts.unitCostExclVatBaseMicrocents),
    microcentsToCents(opts.unitCostExclVatBaseMicrocents),
    microcentsToCents(opts.unitCostExclVatBaseMicrocents),
    microcentsToCents(opts.unitCostExclVatBaseMicrocents),
    opts.unitCostExclVatBaseMicrocents,
    opts.unitCostExclVatBaseMicrocents,
    VAT_STD_ID,
    VAT_STD_BPS,
    0,
    0,
  );
  return itemId;
}

// ----------------------------------------------------------------------------
// Supplier / accounts-payable fixtures (WP-05)
//
// These insert rows in the SHAPE the Rust posting commands produce, which since
// WP-05 means the sign convention `trg_supplier_ledger_sign_discipline`
// enforces: a purchase liability is positive, a payment and a credit note are
// negative. A fixture that got that wrong would be refused by the trigger here
// exactly as it would be in production — which is the point.
// ----------------------------------------------------------------------------

export function seedSupplier(
  db: DatabaseSync,
  opts: { id: string; name: string; isActive?: boolean },
): string {
  db.prepare(
    `INSERT INTO suppliers (id, store_id, name, is_active) VALUES (?, ?, ?, ?)`,
  ).run(opts.id, STORE_ID, opts.name, opts.isActive === false ? 0 : 1);
  return opts.id;
}

export type LedgerEntryTypeFixture =
  | "purchase"
  | "payment"
  | "credit_note"
  | "opening_balance"
  | "adjustment";

/**
 * One supplier-ledger row. `amountSignedCents` is the signed amount as
 * `post_supplier_payment` derives and persists it, not a magnitude.
 */
export function insertLedgerEntry(
  db: DatabaseSync,
  opts: {
    supplierId: string;
    entryType: LedgerEntryTypeFixture;
    amountSignedCents: number;
    entryDate: string;
    postedAt?: string;
    relatedPurchaseId?: string | null;
    paymentReference?: string | null;
    notes?: string | null;
  },
): string {
  const entryId = id("ledger");
  db.prepare(
    `INSERT INTO supplier_ledger (
       id, store_id, supplier_id, entry_type, amount_cents, entry_date,
       related_purchase_id, payment_reference, notes, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entryId,
    STORE_ID,
    opts.supplierId,
    opts.entryType,
    opts.amountSignedCents,
    opts.entryDate,
    opts.relatedPurchaseId ?? null,
    opts.paymentReference ?? null,
    opts.notes ?? null,
    opts.postedAt ?? `${opts.entryDate}T10:00:00.000Z`,
  );
  return entryId;
}

/**
 * A posted supplier purchase plus the invoice liability it raised — the pair
 * `post_purchase` writes in one transaction. The ledger amount IS the
 * purchase's VAT-inclusive total, which is the invariant WP-05 enforces.
 */
export function insertSupplierPurchase(
  db: DatabaseSync,
  opts: {
    supplierId: string;
    purchaseDate: string;
    subtotalExclVat: number;
    vat: number;
    supplierReference?: string | null;
  },
): { purchaseId: string; ledgerEntryId: string } {
  const purchaseId = id("purchase");
  const row = db.prepare("SELECT COALESCE(MAX(purchase_number), 0) AS n FROM purchases").get() as {
    n: number;
  };
  const total = opts.subtotalExclVat + opts.vat;
  db.prepare(
    `INSERT INTO purchases (
       id, store_id, supplier_id, purchase_type, supplier_reference,
       purchase_number, purchase_date,
       subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
       status, posted_at
     ) VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, 'posted', ?)`,
  ).run(
    purchaseId,
    STORE_ID,
    opts.supplierId,
    opts.supplierReference ?? null,
    row.n + 1,
    opts.purchaseDate,
    opts.subtotalExclVat,
    opts.vat,
    total,
    `${opts.purchaseDate}T10:00:00.000Z`,
  );
  const ledgerEntryId = insertLedgerEntry(db, {
    supplierId: opts.supplierId,
    entryType: "purchase",
    amountSignedCents: total,
    entryDate: opts.purchaseDate,
    relatedPurchaseId: purchaseId,
  });
  return { purchaseId, ledgerEntryId };
}

// ============================================================================
// Credit memos / sales returns (WP-06)
// ============================================================================

/**
 * The `sale_items.id`s of one sale, in insertion order.
 *
 * `insertSale` mints them itself, exactly as `post_sale` does, so a return
 * fixture has to read back the line it means to send back.
 */
export function saleItemIds(db: DatabaseSync, saleId: string): string[] {
  const rows = db
    .prepare("SELECT id FROM sale_items WHERE sale_id = ? ORDER BY rowid")
    .all(saleId) as { id: string }[];
  return rows.map((r) => r.id);
}

export interface CreditMemoLineFixture {
  /** The `sale_items` row coming back. */
  saleItemId: string;
  productId: string;
  /** The memo line's own snapshots, which may differ from a later sale's. */
  productName?: string;
  productSku?: string | null;
  /** Base-unit quantity returned, as `quantity_base` stores it. */
  quantityBase: number;
  /** Prorated line figures, matching what `post_credit_memo` persists. */
  subtotalExclVat: number;
  vat: number;
  totalInclVat: number;
  lineDiscount?: number;
  /** COGS actually reversed. Must be 0 when the line is not restocked. */
  cogsReversed?: number;
  /** Default true. False writes the goods off. */
  returnToStock?: boolean;
  /** True when the original sale line moved no stock. Forces no restock. */
  isService?: boolean;
  vatRateId?: string;
  vatBps?: number;
}

export interface CreditMemoRefundFixture {
  method: string;
  currency: "USD" | "LBP";
  nativeUsdCents?: number;
  nativeLbp?: number;
  usdEquivalent: number;
}

export interface CreditMemoFixture {
  /** The sale this memo reverses. Its lines must belong to that sale. */
  saleId: string;
  postedAt: string;
  shiftId?: string | null;
  status?: "posted" | "voided";
  reason?: string | null;
  lines: CreditMemoLineFixture[];
  refunds: CreditMemoRefundFixture[];
}

/**
 * Insert a credit memo exactly as `post_credit_memo` would have persisted it.
 *
 * The header totals are SUMMED from the lines, and the refund total from the
 * refunds, because that is what the command does — a fixture that stated them
 * independently could hold a shape the real backend cannot produce.
 *
 * The memo is built as a DRAFT and promoted at the end, for the same reason the
 * command does it that way: since migration 011 seals a posted memo completely,
 * a posted header takes no child rows at all. A fixture that inserted a posted
 * header first would be taking a shortcut the production code cannot take —
 * which is exactly the shape of the defect the seal closes, so the harness is
 * not allowed one either.
 */
export function insertCreditMemo(db: DatabaseSync, memo: CreditMemoFixture): string {
  const memoId = id("memo");
  const subtotal = memo.lines.reduce((s, l) => s + l.subtotalExclVat, 0);
  const vat = memo.lines.reduce((s, l) => s + l.vat, 0);
  const total = memo.lines.reduce((s, l) => s + l.totalInclVat, 0);
  const discount = memo.lines.reduce((s, l) => s + (l.lineDiscount ?? 0), 0);
  // Only RESTOCKED lines reverse cost, exactly as the command counts them: a
  // written-off return gives the money back and leaves the cost consumed.
  const cogsReversed = memo.lines.reduce((s, l) => {
    const isService = l.isService ?? false;
    const restock = isService ? false : (l.returnToStock ?? true);
    return s + (restock ? (l.cogsReversed ?? 0) : 0);
  }, 0);
  const refundTotal = memo.refunds.reduce((s, r) => s + r.usdEquivalent, 0);

  db.prepare(
    `INSERT INTO sales_credit_memos (
       id, store_id, original_sale_id, credit_memo_number,
       shift_id, cashier_user_id,
       exchange_rate_lbp_per_usd, exchange_rate_id, reason,
       subtotal_excl_vat_cents, vat_total_cents, discount_cents, total_incl_vat_cents,
       cogs_reversed_cents, refund_total_usd_cents,
       status, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    memoId,
    STORE_ID,
    memo.saleId,
    nextCreditMemoNumber(db),
    memo.shiftId ?? null,
    USER_ID,
    RATE_LBP_PER_USD,
    RATE_ID,
    memo.reason ?? null,
    subtotal,
    vat,
    discount,
    total,
    cogsReversed,
    refundTotal,
    // Draft first: the children go in below, and the real status and
    // `posted_at` are set once the document is complete.
    "draft",
    null,
  );

  for (const line of memo.lines) {
    const isService = line.isService ?? false;
    const restock = isService ? false : (line.returnToStock ?? true);
    db.prepare(
      `INSERT INTO sales_credit_memo_lines (
         id, credit_memo_id, store_id, original_sale_item_id, product_id,
         product_name_snapshot, product_sku_snapshot,
         vat_rate_id_snapshot, vat_rate_bps_snapshot,
         quantity_base, quantity_in_uom, uom_code_snapshot,
         factor_num_snapshot, factor_den_snapshot,
         unit_price_excl_vat_cents, unit_price_incl_vat_cents,
         line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
         line_discount_cents,
         unit_cogs_excl_vat_microcents, unit_cogs_excl_vat_cents,
         line_cogs_excl_vat_cents,
         is_service, return_to_stock
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'each', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id("memoline"),
      memoId,
      STORE_ID,
      line.saleItemId,
      line.productId,
      line.productName ?? "Returned item",
      line.productSku ?? null,
      line.vatRateId ?? VAT_STD_ID,
      line.vatBps ?? VAT_STD_BPS,
      line.quantityBase,
      line.quantityBase,
      Math.round(line.subtotalExclVat / line.quantityBase),
      Math.round(line.totalInclVat / line.quantityBase),
      line.subtotalExclVat,
      line.vat,
      line.totalInclVat,
      line.lineDiscount ?? 0,
      // Same pair the command maintains: a microcent RATE and its rounded
      // cents mirror, derived from the line amount the test states.
      Math.round(centsToMicrocents(line.cogsReversed ?? 0) / line.quantityBase),
      microcentsToCents(
        Math.round(centsToMicrocents(line.cogsReversed ?? 0) / line.quantityBase),
      ),
      restock ? (line.cogsReversed ?? 0) : 0,
      isService ? 1 : 0,
      restock ? 1 : 0,
    );
  }

  for (const r of memo.refunds) {
    db.prepare(
      `INSERT INTO sales_credit_memo_refunds (
         id, credit_memo_id, store_id, method, currency,
         amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id("refund"),
      memoId,
      STORE_ID,
      r.method,
      r.currency,
      r.nativeUsdCents ?? 0,
      r.nativeLbp ?? 0,
      r.usdEquivalent,
    );
  }

  // Promote, exactly as the posting command's last statement does. From here
  // the memo and its children are sealed.
  db.prepare(
    `UPDATE sales_credit_memos SET status = ?, posted_at = ?
      WHERE id = ? AND status = 'draft'`,
  ).run(memo.status ?? "posted", memo.postedAt, memoId);

  return memoId;
}

function nextCreditMemoNumber(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(credit_memo_number), 0) AS n FROM sales_credit_memos")
    .get() as { n: number };
  return row.n + 1;
}
