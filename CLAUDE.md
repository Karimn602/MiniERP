# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lira POS** is an offline-first desktop Point of Sale and inventory management app for Lebanese retail. Built with Tauri 2 (Rust + Chromium shell), React 19, and SQLite. All data lives locally; no backend server. The "mini ERP" framing means it also covers purchasing, supplier ledgers, and accounting scaffolding.

## Commands

All commands run from `lira-pos/`:

```sh
npm run dev        # Start Vite dev server (port 1420) — frontend only, no Tauri shell
npm run tauri dev  # Full Tauri desktop app with hot-reload (needs Rust toolchain)
npm run build      # TypeScript check + Vite bundle
npm run tauri build # Full desktop build (produces installer)
```

There are no test or lint scripts. TypeScript strict mode is the primary safety net.

## Architecture

### Stack
- **Desktop shell**: Tauri 2 (Rust)
- **UI**: React 19, React Router 7, Tailwind CSS
- **State**: Zustand (two stores: `activeContext`, `lowStockBadge`)
- **Database**: SQLite via `@tauri-apps/plugin-sql` — single file, WAL mode, foreign keys ON

### Module Map

```
lira-pos/src/
  App.tsx            — 3-stage boot: DB ready → hydrate context → render router
  pages/             — Route components (PosRegister, Products, Purchases, Inventory, ...)
  components/        — AppShell (sidebar), BarcodeManager, pickers, ui/ primitives
  db/
    client.ts        — singleton SQLite connection
    migrate.ts       — bootstrap: PRAGMAs + schema validation on startup
    types.ts         — all TypeScript domain interfaces
    repos/           — typed data accessors (products, sales, purchases, suppliers, ...)
    migrations/      — 10 numbered SQL files; Rust registers them on app init
    seed.ts          — demo data
  lib/
    money.ts         — USD ↔ LBP conversion; integer-only arithmetic
    cost.ts          — fixed-point UNIT COST (microcents); mirrors src-tauri/src/cost.rs
    uom.ts           — Unit-of-Measure rational conversion (num/den)
    saleMath.ts      — sale line-item calculations
    purchaseMath.ts  — purchase line-item calculations
    vat.ts           — VAT application
    ids.ts           — UUID v4 generation
  state/             — Zustand stores

src-tauri/src/
  lib.rs             — Tauri entry point; registers migrations and invoke handlers
  cost.rs            — fixed-point UNIT COST arithmetic: scale, rounding, WAC, overflow
  posting.rs         — All transactional writes (purchase, sale, adjustment, payment)
```

### Critical Design Decisions

**Money is always integers.** USD stored as cents, LBP stored as whole lira. Never use floats for money. Exchange rates and VAT rates are stored as integer basis points (e.g., 1100 = 11%).

**Unit cost is a rate, not an amount — it is stored in microcents.** Money (line totals, VAT, tender, COGS amounts, the supplier ledger) is cents. A *unit cost* is money per base unit, and when the purchasing UoM dwarfs the base UoM that rate is legitimately below a cent: flour at $2.50/kg stocked in grams is $0.0025/g. So every per-unit cost column has a microcent sibling (`1 cent = 1,000,000 microcents`) which is the accounting source of truth:

| cents (display mirror) | microcents (authoritative) |
|---|---|
| `products.avg_cost_*_vat_cents` | `products.avg_cost_*_vat_microcents` |
| `inventory_movements.unit_cost_*_vat_cents` | `inventory_movements.unit_cost_*_vat_microcents` |
| `purchase_items.unit_cost_*_vat_base_cents` | `purchase_items.unit_cost_*_vat_base_microcents` |
| `sale_items.unit_cogs_excl_vat_cents` | `sale_items.unit_cogs_excl_vat_microcents` |

Rules: all cost arithmetic goes through `src-tauri/src/cost.rs` (or `src/lib/cost.ts`), never a hand-rolled multiply-and-divide. Rounding is half away from zero, in one helper. Cost becomes money exactly once, at `extended_cost_cents` — precise rate × base quantity, rounded once; never round the rate first. The `*_cents` columns are maintained by the posting commands as `round(rate)` for display and back-compatibility, and must never feed a calculation. The per-UoM invoice cost (`unit_cost_*_in_uom_cents`) stays in cents: it is what the supplier billed, exact to the cent.

**UoM conversions use rational fractions.** Each `product_uom` row has `conversion_num` / `conversion_den` to preserve precision when converting between units (e.g., kg → g).

**Transactions run in Rust, not JavaScript.** The six `invoke` handlers in `posting.rs` (`post_purchase`, `post_sale`, `post_adjustment`, `post_supplier_payment`, `open_shift`, `close_shift`) are the only place that mutates financial and inventory state. This avoids JS connection-pool race conditions. Frontend repos are read-only query helpers.

**The database decides the UoM conversion, not the payload.** `post_sale` and `post_purchase` both resolve the product's own active `product_uoms` row — looked up by `(product_id, store_id, uom_code, is_active)` — and derive `quantity_base` from *its* factor. That single resolved conversion drives the per-base cost, the persisted snapshots, the inventory movement, `quantity_on_hand`, the weighted average and the last-purchase rate. A payload that declares a different factor, base quantity or `product_uoms` row id is **refused**, not silently normalized: the buyer priced the goods against the conversion they believed in. Client-supplied `quantity_base` / `factor_*_snapshot` / `product_uom_id_snapshot` remain on the wire for compatibility and are cross-checks only.

**One open shift per store, and the shift is checked when a sale posts.** The shift scope is the store — `getOpenShift(storeId)` queries `(store_id, status='open')`, `device_id` is never populated, and the cashier is recorded but not scoped on. `open_shift` decides uniqueness in a single `INSERT ... WHERE NOT EXISTS` statement, backed by the partial unique index `ux_shifts_one_open_per_store`; `close_shift` computes the cash reconciliation and writes it in the same transaction that marks the shift closed, and a closed shift is immutable (`trg_shifts_no_update_after_close`). **A new sale must name an open shift of its store** — `post_sale` refuses one that does not, inside its own transaction and before any receipt number or row is written. The check runs *after* the idempotency resolution, so retrying a sale that already posted still returns its original receipt, including a historical row whose `shift_id` is NULL. `sales.shift_id` stays nullable in the schema: the rule governs what may be written from now on, and history is not rewritten.

**Tender is validated, never trusted; change is cash.** A payment row's `amount_usd_cents_equivalent` is *derived*: a USD tender's is itself, an LBP tender's is its lira at the rate locked on the sale, and that locked rate is matched against the `exchange_rates` row (scoped by store) before anything is written. Non-cash tender may never exceed the amount due, so a card overpayment is refused rather than written as drawer change, and the row absorbing an overpayment is always a cash row (USD cash preferred, else LBP cash, in that row's own currency). Expected drawer cash is `opening float + cash in − change out` per currency, counting only `cash_usd`/`cash_lbp` rows in both terms.

**One authoritative unit price per purchase line.** A supplier invoice quotes ONE price per unit, and `vat_pricing_mode` on the line says which side of the excl/incl pair that is — the payload's value (the Purchases page's per-line Incl/Excl toggle), or the product's own `products.vat_pricing_mode` when the payload omits it. The counterpart is *derived* by `post_purchase` with the application's own VAT rounding (`posting.rs::add_vat` / `strip_vat`, mirroring `lib/vat.ts` in integer arithmetic), and a declared counterpart that disagrees is **refused**. Exclusive mode → `unit_cost_excl_vat_in_uom_cents` is authoritative; inclusive mode → `unit_cost_incl_vat_in_uom_cents` is. At 0 bps the two must be the same figure. Rounding to whole cents means `add_vat` and `strip_vat` are not exact inverses, so the mode is what fixes the direction rather than the backend guessing. Without this, a line could declare "$20.00 net, $999.00 gross" at 11% and stock inventory at a $20 cost basis while raising $999 of supplier debt.

**A purchase's payable is derived, and a supplier invoice posts once.** The AP liability a purchase raises is the purchase's own VAT-inclusive total, and that total is *derived* by `post_purchase` from the authoritative inputs — the proven-coherent per-UoM cost pair and the quantity in that UoM — using the application's own convention (`lib/purchaseMath.ts`: extend the per-UoM cost by the quantity, VAT is the gross/net difference). The client's declared line subtotal/VAT/total are cross-checks only and a disagreement is refused, so there is no second amount a caller could book debt with. The purchase, its lines, its movements, its stock and cost updates and its `supplier_ledger` row commit in one transaction, and a failure rolls back the purchase number with everything else. The pricing-pair check is a pre-pass that runs before the purchase number is consumed, so a malformed line leaves nothing behind at all.

A supplier invoice reference may be POSTED once per `(store, supplier)`. The canonical normalized form is `purchases.supplier_reference_key`, a generated column defined as `NULLIF(TRIM(UPPER(supplier_reference), char(9,10,13,32)), '')` — trim + uppercase, the same convention migration 002 uses for `product_barcodes.lookup_value`. A blank or whitespace-only reference normalizes to NULL and constrains nothing. The rule is enforced by `post_purchase` before a purchase number is consumed, and by `trg_purchases_no_duplicate_supplier_invoice_{ins,upd}` as the backstop. It is a trigger rather than a unique index on purpose: a database that already holds a duplicate could not have the index created over it, and the only ways around that would be to rewrite or delete a real financial document. The rule governs writes from now on; history stands as recorded.

**Both AP commands are idempotent on identity.** `purchases.id` and `supplier_ledger.id` are document identities the caller mints once. Replaying one with the same canonical content reconciles to the row that already posted — one payable, one stock receipt, one cost blend, no receipt or purchase number consumed — and replaying it with materially different content is a conflict. This is *technical retry* idempotency and is kept strictly separate from *business duplicate-invoice* detection: two genuinely separate deliveries under two identities are two purchases, refused only if they quote the same invoice reference, and two separate payments of the same amount are two payments.

**Supplier-ledger sign is the backend's, not the caller's.** Positive means the shop owes more. `purchase` → +, `payment` → −, `credit_note` → −, while `opening_balance` and `adjustment` are deliberately bidirectional and take the caller's sign (the Supplier screen has an explicit +/− toggle for adjustments). `post_supplier_payment` takes a positive `amountMagnitudeCents` and applies the direction itself, so a payment sent with the wrong sign still pays the balance down instead of adding to it; the legacy signed `amountCents` stays on the wire and its magnitude is honoured, its sign is not. `trg_supplier_ledger_sign_discipline` enforces the same convention against every other writer, and also that an entry is filed against the supplier's own store.

**Supplier payments may not create an advance.** Greaz models no supplier advance or receivable, so `post_supplier_payment` refuses a `payment` larger than the outstanding payable, reading that payable inside the posting transaction rather than trusting a displayed figure. Partial payments are supplier-level, not invoice-allocated. A negative balance stays reachable through the two explicitly-signed instruments — a `credit_note` the supplier issued, or a signed-off `adjustment` — which is what the Supplier screen shows as "credit on file".

**Supplier payments are not drawer events.** A `supplier_ledger` payment records an amount and nothing else: no method, no currency, no shift. `close_shift` therefore counts only `cash_usd`/`cash_lbp` sale tender, and WP-05 left it that way deliberately. Giving supplier payments a tender model is an open product decision.

**Snapshots at post time.** `sale_items` and `purchase_items` snapshot price, VAT, COGS, and UoM at the moment of posting. These values never change after posting.

**Posted rows are immutable.** Database triggers prevent UPDATE/DELETE on posted sales, purchases, and inventory movements. Corrections are made via reversal rows, never edits.

**Weighted-average COGS.** `products.avg_cost_*_microcents` is recalculated on every purchase post using `(existing_qty * old_cost + new_qty * new_cost) / total_qty`, accumulated in i128 at full microcent precision and divided once. No component is rounded to cents on the way.

### Data Flow: POS Sale

1. Cashier scans barcode → `BarcodeManager` resolves `Product` + `ProductUom` via repos
2. `saleMath.ts` computes line totals, VAT, COGS per line
3. Payment collected as split tender (USD cash / LBP cash / card / bank transfer)
4. Frontend builds `PostSalePayload` and calls `tauri.invoke('post_sale', payload)`
5. `posting.rs:post_sale` runs a single SQLite transaction:
   - INSERT into `sales`, `sale_items`, `sale_payments`, `inventory_movements`
   - UPDATE `products.quantity_on_hand`
   - SET `sales.posted_at` (triggers immutability)
6. Frontend refreshes from repos; shows receipt

### Database Schema Highlights

23 tables across 10 migrations. Key groups:

| Group | Tables |
|---|---|
| Catalog | `products`, `product_barcodes`, `product_uoms`, `units_of_measure`, `vat_rates` |
| Sales | `sales`, `sale_items`, `sale_payments` |
| Purchasing | `purchases`, `purchase_items`, `suppliers`, `supplier_ledger` |
| Inventory | `inventory_movements` |
| Finance | `exchange_rates`, `shifts` |
| Accounting (Phase 3+, inactive) | `accounts`, `journal_entries`, `journal_lines` |
| Infrastructure | `stores`, `users`, `devices`, `sync_queue`, `app_settings` |

All primary keys are `TEXT` UUIDs. `sync_queue` is scaffolding for a future cloud sync phase.

## Lebanese Retail Specifics

- Default VAT rate: 11% (stored in `vat_rates` with temporal effective dates)
- Dual currency: USD is the base currency; LBP is the local tender
- Exchange rate locked at sale time (`sales.exchange_rate_id`) — not retroactive
- Products have both `price_excl_vat` and `price_incl_vat` in USD cents
