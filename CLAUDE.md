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
    migrations/      — 12 numbered SQL files; Rust registers them on app init
    seed.ts          — demo data
  lib/
    money.ts         — USD ↔ LBP conversion; integer-only arithmetic
    cost.ts          — fixed-point UNIT COST (microcents); mirrors src-tauri/src/cost.rs
    uom.ts           — Unit-of-Measure rational conversion (num/den)
    saleMath.ts      — sale line-item calculations
    purchaseMath.ts  — purchase line-item calculations
    creditMemoMath.ts— returns: cumulative proration; mirrors posting.rs
    vat.ts           — VAT application
    ids.ts           — UUID v4 generation
  state/             — Zustand stores

src-tauri/src/
  lib.rs             — Tauri entry point; registers migrations and invoke handlers
  cost.rs            — fixed-point UNIT COST arithmetic: scale, rounding, WAC, overflow
  posting.rs         — All transactional writes (purchase, sale, return, adjustment, payment)
  catalog.rs         — Transactional catalog writes (product + UoMs + barcodes)
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
| `sales_credit_memo_lines.unit_cogs_excl_vat_cents` | `sales_credit_memo_lines.unit_cogs_excl_vat_microcents` |

Rules: all cost arithmetic goes through `src-tauri/src/cost.rs` (or `src/lib/cost.ts`), never a hand-rolled multiply-and-divide. Rounding is half away from zero, in one helper. Cost becomes money exactly once, at `extended_cost_cents` — precise rate × base quantity, rounded once; never round the rate first. The `*_cents` columns are maintained by the posting commands as `round(rate)` for display and back-compatibility, and must never feed a calculation. The per-UoM invoice cost (`unit_cost_*_in_uom_cents`) stays in cents: it is what the supplier billed, exact to the cent.

**UoM conversions use rational fractions.** Each `product_uom` row has `conversion_num` / `conversion_den` to preserve precision when converting between units (e.g., kg → g).

**Transactions run in Rust, not JavaScript.** The seven `invoke` handlers in `posting.rs` (`post_purchase`, `post_sale`, `post_credit_memo`, `post_adjustment`, `post_supplier_payment`, `open_shift`, `close_shift`) are the only place that mutates financial and inventory state. This avoids JS connection-pool race conditions. Frontend repos are read-only query helpers.

**Compound CATALOG writes run in Rust too, for the same reason.** `catalog.rs` holds four more handlers — `save_product`, `add_product_barcode`, `set_primary_product_barcode`, `remove_product_barcode` — because saving a product is a compound write (a `products` row, one or two `product_uoms` rows, sometimes a barcode, and on an update a clear-then-set of the default sale UoM) and tauri-plugin-sql gives no usable BEGIN/COMMIT across statements. The half-states are UNLOADABLE, not merely untidy: `productsRepo.enrich` refuses a product with no base UoM or no default sale UoM, and it refuses it while loading the LIST, so one product broken by a duplicate SKU takes the whole Products page down. Reporting and read queries stay in TypeScript — a read has nothing to be atomic about.

**The database decides the UoM conversion, not the payload.** `post_sale`, `post_purchase` and (since WP-07) `post_adjustment` all resolve the product's own active `product_uoms` row — looked up by `(product_id, store_id, uom_code, is_active)` — and derive `quantity_base` from *its* factor. That single resolved conversion drives the per-base cost, the persisted snapshots, the inventory movement, `quantity_on_hand`, the weighted average and the last-purchase rate. A payload that declares a different factor, base quantity or `product_uoms` row id is **refused**, not silently normalized: the buyer priced the goods against the conversion they believed in. Client-supplied `quantity_base` / `factor_*_snapshot` / `product_uom_id_snapshot` remain on the wire for compatibility and are cross-checks only.

An **inventory adjustment is a UoM quantity**, not a base-unit one: the Inventory screen has the manager pick a `product_uoms` row, type a whole number and a direction. `post_adjustment` was the last command to still believe the client's conversion — it moved stock by the payload's `quantity_base_signed` and stamped the movement with the payload's factor, unchecked — so a request could say "−1 each" and move 1,000 base units, leaving an audit trail that actively denied the discrepancy it created. Since WP-07 it resolves, derives and refuses exactly as its two siblings do, and the movement row carries the resolved factor so the stock delta and the cost metadata always describe one conversion. Adjustments are still valued *at* the current weighted average and never move it: a quantity correction is not a cost event.

**An inventory adjustment's negative-stock policy is a decision about the DOCUMENT.** Greaz forbids an adjustment that leaves stock below zero, and that rule is applied once per product to the document's NET base delta, not per line. Nothing is written until every line is resolved, so each line of the same product reads the same opening quantity — two lines of −6 against an opening 10 each saw 10, each computed a resulting 4, and each passed, committing −2 under a rule that forbids it. The Inventory screen appends a line per pick with no merge, so a manager counting one shelf twice reached this. The resolved deltas are aggregated by product with `checked_add` and judged once; each line still writes its own movement row, so the audit trail records what was entered and still sums to the validated net.

**One open shift per store, and the shift is checked when a sale posts.** The shift scope is the store — `getOpenShift(storeId)` queries `(store_id, status='open')`, `device_id` is never populated, and the cashier is recorded but not scoped on. `open_shift` decides uniqueness in a single `INSERT ... WHERE NOT EXISTS` statement, backed by the partial unique index `ux_shifts_one_open_per_store`; `close_shift` computes the cash reconciliation and writes it in the same transaction that marks the shift closed, and a closed shift is immutable (`trg_shifts_no_update_after_close`). **A new sale must name an open shift of its store** — `post_sale` refuses one that does not, inside its own transaction and before any receipt number or row is written. The check runs *after* the idempotency resolution, so retrying a sale that already posted still returns its original receipt, including a historical row whose `shift_id` is NULL. `sales.shift_id` stays nullable in the schema: the rule governs what may be written from now on, and history is not rewritten.

**Tender is validated, never trusted; change is cash.** A payment row's `amount_usd_cents_equivalent` is *derived*: a USD tender's is itself, an LBP tender's is its lira at the rate locked on the sale, and that locked rate is matched against the `exchange_rates` row (scoped by store) before anything is written. Non-cash tender may never exceed the amount due, so a card overpayment is refused rather than written as drawer change, and the row absorbing an overpayment is always a cash row (USD cash preferred, else LBP cash, in that row's own currency). Expected drawer cash is `opening float + cash in − change out − cash refunds out` per currency (the refund term since WP-06), counting only `cash_usd`/`cash_lbp` rows in every term.

**One authoritative unit price per purchase line.** A supplier invoice quotes ONE price per unit, and `vat_pricing_mode` on the line says which side of the excl/incl pair that is — the payload's value (the Purchases page's per-line Incl/Excl toggle), or the product's own `products.vat_pricing_mode` when the payload omits it. The counterpart is *derived* by `post_purchase` with the application's own VAT rounding (`posting.rs::add_vat` / `strip_vat`, mirroring `lib/vat.ts` in integer arithmetic), and a declared counterpart that disagrees is **refused**. Exclusive mode → `unit_cost_excl_vat_in_uom_cents` is authoritative; inclusive mode → `unit_cost_incl_vat_in_uom_cents` is. At 0 bps the two must be the same figure. Rounding to whole cents means `add_vat` and `strip_vat` are not exact inverses, so the mode is what fixes the direction rather than the backend guessing. Without this, a line could declare "$20.00 net, $999.00 gross" at 11% and stock inventory at a $20 cost basis while raising $999 of supplier debt.

**A purchase's payable is derived, and a supplier invoice posts once.** The AP liability a purchase raises is the purchase's own VAT-inclusive total, and that total is *derived* by `post_purchase` from the authoritative inputs — the proven-coherent per-UoM cost pair and the quantity in that UoM — using the application's own convention (`lib/purchaseMath.ts`: extend the per-UoM cost by the quantity, VAT is the gross/net difference). The client's declared line subtotal/VAT/total are cross-checks only and a disagreement is refused, so there is no second amount a caller could book debt with. The purchase, its lines, its movements, its stock and cost updates and its `supplier_ledger` row commit in one transaction, and a failure rolls back the purchase number with everything else. The pricing-pair check is a pre-pass that runs before the purchase number is consumed, so a malformed line leaves nothing behind at all.

A supplier invoice reference may be POSTED once per `(store, supplier)`. The canonical normalized form is `purchases.supplier_reference_key`, a generated column defined as `NULLIF(TRIM(UPPER(supplier_reference), char(9,10,13,32)), '')` — trim + uppercase, the same convention migration 002 uses for `product_barcodes.lookup_value`. A blank or whitespace-only reference normalizes to NULL and constrains nothing. The rule is enforced by `post_purchase` before a purchase number is consumed, and by `trg_purchases_no_duplicate_supplier_invoice_{ins,upd}` as the backstop. It is a trigger rather than a unique index on purpose: a database that already holds a duplicate could not have the index created over it, and the only ways around that would be to rewrite or delete a real financial document. The rule governs writes from now on; history stands as recorded.

**Both AP commands are idempotent on identity.** `purchases.id` and `supplier_ledger.id` are document identities the caller mints once. Replaying one with the same canonical content reconciles to the row that already posted — one payable, one stock receipt, one cost blend, no receipt or purchase number consumed — and replaying it with materially different content is a conflict. This is *technical retry* idempotency and is kept strictly separate from *business duplicate-invoice* detection: two genuinely separate deliveries under two identities are two purchases, refused only if they quote the same invoice reference, and two separate payments of the same amount are two payments.

**Supplier-ledger sign is the backend's, not the caller's.** Positive means the shop owes more. `purchase` → +, `payment` → −, `credit_note` → −, while `opening_balance` and `adjustment` are deliberately bidirectional and take the caller's sign (the Supplier screen has an explicit +/− toggle for adjustments). `post_supplier_payment` takes a positive `amountMagnitudeCents` and applies the direction itself, so a payment sent with the wrong sign still pays the balance down instead of adding to it; the legacy signed `amountCents` stays on the wire and its magnitude is honoured, its sign is not. `trg_supplier_ledger_sign_discipline` enforces the same convention against every other writer, and also that an entry is filed against the supplier's own store.

**Supplier payments may not create an advance.** Greaz models no supplier advance or receivable, so `post_supplier_payment` refuses a `payment` larger than the outstanding payable, reading that payable inside the posting transaction rather than trusting a displayed figure. Partial payments are supplier-level, not invoice-allocated. A negative balance stays reachable through the two explicitly-signed instruments — a `credit_note` the supplier issued, or a signed-off `adjustment` — which is what the Supplier screen shows as "credit on file".

**Supplier payments are not drawer events.** A `supplier_ledger` payment records an amount and nothing else: no method, no currency, no shift. `close_shift` therefore counts only `cash_usd`/`cash_lbp` sale tender, and WP-05 left it that way deliberately. Giving supplier payments a tender model is an open product decision.

**A return is not a negative sale.** A customer return is a CREDIT MEMO — its own document in its own tables (`sales_credit_memos`, `sales_credit_memo_lines`, `sales_credit_memo_refunds`, migration 011) — and the sale it reverses stands exactly as posted. Nothing is written back onto it: "not returned / partially returned / fully returned" is **derived** by summing the memo lines that point at it, and `sales.sale_type` / `sales.original_sale_id` stay unused, as migration 001 left them. Negative `sales` rows were not an option: `sale_items.quantity` is `CHECK (> 0)`, every `sale_payments` amount is `CHECK (>= 0)`, and every report, shift summary and drawer query filters `status = 'posted'` WITHOUT filtering `sale_type` — so folding returns into `sales` would have changed the meaning of all of them, with the wrong sign, on the day it shipped. Returns are layered additively instead: `dailySales`, `productSales` and `getSalesSummary` are untouched and still GROSS, and the returns series (`dailyReturns`, `productReturns`, `getRefundSummary`, `getRefundBreakdown`) sits beside them, so net sales and net profit are visible subtractions rather than figures that quietly changed.

**Every amount on a credit memo comes from the original posted snapshot.** The price, the VAT rate and amount, the discount allocation, the COGS rate, the tender the sale took and the exchange rate it locked are all read from `sales`, `sale_items`, `sale_payments` and the sale's own inventory movements. Nothing is recomputed from today's product price, today's VAT rate, today's cost pool or today's exchange rate: a refund settles a transaction that already happened, on the terms it happened on. Whether a line may be restocked is decided by whether the SALE produced an inventory movement, not by `products.is_service` as it reads now — a product reclassified since cannot make a service out of goods that left the shelf.

**A memo's share of each COMPONENT is a difference of two cumulative figures.** Rounding each return independently makes the parts disagree with the whole: three returns of one unit from a 3-unit, $10.00 line each round $3.3333 to $3.33, and the customer is a cent short for ever, because a posted memo is immutable. So a memo's share is `cumulative(already returned + returning) − cumulative(already returned)`, where `cumulative(q) = round(original amount × q ÷ original quantity)` — `posting.rs::prorated_cumulative_cents`, mirrored for the register's preview by `lib/creditMemoMath.ts::returnedLineAmounts`.

It is applied to the components the sale PERSISTED: the line's subtotal, its VAT and its discount allocation. **The total is derived as `subtotal slice + VAT slice`, and VAT is never a residual.** Taking VAT as `total − subtotal` was the original design and it is wrong: each of those series is monotone, but their difference is not, so the two roundings can move opposite ways on one step. An 11-cent, 3-unit line of 10 net + 1 VAT gives cumulative totals 4, 7, 11 against cumulative subtotals 3, 7, 10 — so the second unit's residual VAT is `3 − 4 = −1`, a credit note that ADDS output VAT, and the non-negative-VAT guard refused a return the customer was entitled to. Allocating the components separately fixes it at the root: both originals are non-negative, so both series are monotone and every slice is non-negative, and each lands exactly on its own original at full return, so their sum lands exactly on the line total. The one boundary left is money's own resolution — a line worth under a cent per unit has steps that credit nothing, so it is returnable in one go rather than unit by unit.

COGS is prorated the same way but against the cumulative RESTOCKED quantity, so a line returned once as a write-off and once to the shelf reverses cost for the second unit only.

**Returned stock comes back at the cost it left at, and the average is re-blended.** The restock movement carries the original sale's microcent COGS rate, and `cost::restock_weighted_avg` blends it into the pool at full precision. Leaving the average alone would put the units back in the quantity without putting their cost back in the value, so every subsequent average would be wrong by that much. Two states have no honest answer, both reachable only from a pre-existing negative pool (the POS permits selling below zero): a resulting quantity still ≤ 0, and a blend that would come out negative against the `CHECK (>= 0)` column. In both, the quantity still goes back and the existing rate stands. A write-off return (`return_to_stock = false`) moves no stock, writes no movement and reverses no cost — the margin on discarded goods is lost, which is the truth about them — and a service line can never restock at all.

**A refund goes back the way it came, and only that far.** A credit memo may refund only a `(method, currency)` pair the original sale actually took, capped in THAT currency's own unit — USD cents for a USD leg, whole lira for a lira one — NET of any change the sale handed back, and cumulatively across every memo of that sale. So a card-only sale cannot be refunded in cash (which would empty the drawer against a payment that never filled it) and a cash-only sale cannot be credited to a card that was never charged. The split need not be proportional. `store_credit` is not a refund method at all: Greaz has no customer-credit ledger, so it would be a liability recorded nowhere. The refund legs must sum to the memo total EXACTLY — there is no unpaid-credit instrument and no change on a refund — and a lira leg's USD equivalent is derived at the SALE's locked rate, never taken from the client.

**A cash refund is a drawer event; a card refund is not.** Expected drawer cash is now `opening float + cash in − change out − cash refunds out`, per currency, and `post_credit_memo` reads it inside its own transaction from the same `drawer_cash_for_shift` definition `close_shift` reconciles against. A cash refund that would drive the drawer below zero in its currency is refused, with no manager override: a refund the till cannot fund is a cash problem, not a permissions problem. A new credit memo must name an open shift of its store — checked after the idempotency resolution and again just before the commit, the WP-04 ordering — so a replay of a memo that already posted still resolves after its shift has been closed and counted.

**A return is idempotent on its identity.** `sales_credit_memos.id` is the return identity the caller mints once. Replaying it reconciles to the memo that posted — one refund, one restock, one cost blend, no credit-memo number consumed — and replaying it with materially different content is a conflict. The canonical comparison is over the request's INPUTS (which sale, which lines, how much of each, restock or not, the refund legs), because every amount is derived from those plus the history at the time, and by replay time the memo's own lines are part of that history. Two genuinely separate partial returns are two memos under two identities, subject to the cumulative quantity and tender caps.

**Snapshots at post time.** `sale_items`, `purchase_items` and `sales_credit_memo_lines` snapshot price, VAT, COGS, and UoM at the moment of posting. These values never change after posting.

**Posted rows are immutable.** Database triggers prevent UPDATE/DELETE on posted sales, purchases, credit memos and inventory movements. Corrections are made via reversal rows, never edits.

**All three document families are sealed the same way** since migration 012: a posted sale, purchase or credit memo takes no new child row, no child UPDATE or DELETE, and no child reparented into or out of it. The reparenting guards test `id IN (OLD.parent_id, NEW.parent_id)`, because `sale_id` / `purchase_id` / `credit_memo_id` are ordinary updatable columns and a one-sided check on the OLD parent lets a child be moved into a settled document from a draft. The INSERT guards key on the parent's `posted_at`, which is why **every posting command builds a draft and promotes it last** — `post_sale` wrote `status = 'posted'` in its first statement until WP-07, which would have made that guard reject every sale. `supplier_ledger` needed nothing: it has been unconditionally append-only since migration 006, and WP-05's sign discipline is a BEFORE INSERT trigger, so a legitimate signed `adjustment` or `opening_balance` is still an ordinary insert.

A posted CREDIT MEMO is sealed harder than a posted sale, and deliberately so. Migration 001 lets a posted sale become `'voided'` if a listed set of columns is unchanged; migration 011 allows no UPDATE at all, no DELETE, and no new line or refund leg. Two reasons. A posted memo has already moved stock, re-blended the cost pool and taken cash out of the drawer, and WP-06 ships no void command — so a bare status flip would hide the refund from every `status = 'posted'` read model while leaving all three effects in place, which is a hole that balances nowhere rather than a void. And a column list is a denylist worn as an allowlist: the copied one omitted the shift, the cashier, the locked rate and the reason, so the statement that voided a memo could also re-point it at another drawer. The `voided_*` columns stay RESERVED for a future workflow that relaxes the trigger and writes the compensating entries in the same migration. And a memo line or refund leg NEVER changes `credit_memo_id` — not even between two drafts, which WP-06 permitted. `trg_credit_memo_lines_no_over_return` proves that a line belongs to an item of the memo's OWN original sale and that the quantity is still available, and it checks on INSERT only; so a line created under a draft against the sale it belongs to could be moved under a draft against a different sale and promoted, crediting a receipt that never sold the goods. Production reparents nothing, so forbidding it outright costs nothing and is cheaper than re-running those proofs on UPDATE. INSERT is guarded too, because adding a child to a settled document edits no existing row and so slips past an update guard — and the guard keys on the parent's `posted_at`, which is NULL throughout the command's draft construction phase.

**Stock and cost are not product metadata.** `products.quantity_on_hand` and `products.avg_cost_*` (microcents and their cents mirrors) are writable ONLY by the posting commands and `post_adjustment`, each of which writes an `inventory_movements` row alongside — which is what keeps `SUM(quantity_delta)` reconciling to `quantity_on_hand`. `save_product` cannot write either: there is no field for them on its payload, so the authority is removed rather than merely unused. The generic product UPDATE used to write them, and the Products page computed `quantityOnHand = form.isService ? 0 : existing` — so ticking “service” on a product holding ten units destroyed ten units of stock with no movement to account for it. Turning a stocked product that still holds stock into a service is therefore **refused**, reporting the quantity, and a zeroing movement is not fabricated in its place: the command does not know why the stock is going away, and a movement under an invented reason is worse than a refusal. The operator writes it off through the inventory-adjustment flow, which records the movement under a reason, and then reclassifies.

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

26 tables across 12 migrations. Key groups:

| Group | Tables |
|---|---|
| Catalog | `products`, `product_barcodes`, `product_uoms`, `units_of_measure`, `vat_rates` |
| Sales | `sales`, `sale_items`, `sale_payments` |
| Returns | `sales_credit_memos`, `sales_credit_memo_lines`, `sales_credit_memo_refunds` |
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
