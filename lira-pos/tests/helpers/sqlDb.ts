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

export function seedShift(
  db: DatabaseSync,
  opts: { id: string; openingUsdCents?: number; openingLbp?: number },
): string {
  db.prepare(
    `INSERT INTO shifts (
       id, store_id, opened_by_user_id, opened_at,
       opening_cash_usd_cents, opening_cash_lbp, status
     ) VALUES (?, ?, ?, '2026-03-01T08:00:00.000Z', ?, ?, 'open')`,
  ).run(opts.id, STORE_ID, USER_ID, opts.openingUsdCents ?? 0, opts.openingLbp ?? 0);
  return opts.id;
}

export interface SaleLineFixture {
  productId: string;
  productName: string;
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

/** Insert a sale exactly as `post_sale` would have persisted it. */
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'weighted_average', 'normal', ?, ?)`,
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
    sale.status ?? "posted",
    sale.postedAt,
  );

  for (const line of sale.lines) {
    db.prepare(
      `INSERT INTO sale_items (
         id, sale_id, store_id, product_id,
         product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
         quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
         line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
         line_discount_cents,
         unit_cogs_excl_vat_cents, unit_cogs_excl_vat_microcents,
         line_cogs_excl_vat_cents,
         quantity_in_uom, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'each', 1, 1)`,
    ).run(
      id("item"),
      saleId,
      STORE_ID,
      line.productId,
      line.productName,
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

  return saleId;
}

function nextReceiptNumber(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(receipt_number), 0) AS n FROM sales").get() as {
    n: number;
  };
  return row.n + 1;
}

export function insertPurchase(
  db: DatabaseSync,
  opts: {
    purchaseDate: string;
    subtotalExclVat: number;
    vat: number;
    status?: "posted" | "draft";
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
    opts.status ?? "posted",
    `${opts.purchaseDate}T10:00:00.000Z`,
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
