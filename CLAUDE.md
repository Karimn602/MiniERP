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
    migrations/      — 7 numbered SQL files; Rust registers them on app init
    seed.ts          — demo data
  lib/
    money.ts         — USD ↔ LBP conversion; integer-only arithmetic
    uom.ts           — Unit-of-Measure rational conversion (num/den)
    saleMath.ts      — sale line-item calculations
    purchaseMath.ts  — purchase line-item calculations
    vat.ts           — VAT application
    ids.ts           — UUID v4 generation
  state/             — Zustand stores

src-tauri/src/
  lib.rs             — Tauri entry point; registers migrations and invoke handlers
  posting.rs         — All transactional writes (purchase, sale, adjustment, payment)
```

### Critical Design Decisions

**Money is always integers.** USD stored as cents, LBP stored as whole lira. Never use floats for money. Exchange rates and VAT rates are stored as integer basis points (e.g., 1100 = 11%).

**UoM conversions use rational fractions.** Each `product_uom` row has `conversion_num` / `conversion_den` to preserve precision when converting between units (e.g., kg → g).

**Transactions run in Rust, not JavaScript.** The four `invoke` handlers in `posting.rs` (`post_purchase`, `post_sale`, `post_adjustment`, `post_supplier_payment`) are the only place that mutates financial and inventory state. This avoids JS connection-pool race conditions. Frontend repos are read-only query helpers.

**Snapshots at post time.** `sale_items` and `purchase_items` snapshot price, VAT, COGS, and UoM at the moment of posting. These values never change after posting.

**Posted rows are immutable.** Database triggers prevent UPDATE/DELETE on posted sales, purchases, and inventory movements. Corrections are made via reversal rows, never edits.

**Weighted-average COGS.** `products.avg_cost_usd` is recalculated on every purchase post using `(existing_qty * old_cost + new_qty * new_cost) / total_qty`.

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

23 tables across 7 migrations. Key groups:

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
