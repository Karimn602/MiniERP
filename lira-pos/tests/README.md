# Greaz POS test harness (WP-01)

A financial regression suite. Its job is to make the later hardening work
packages safe: if a change breaks how money, stock, or VAT are recorded, one of
these tests fails.

## Commands

Run from `lira-pos/`:

```sh
npm test            # TypeScript: unit + SQL/read-model integration
npm run test:watch  # the same, in watch mode
npm run test:types  # type-check the tests as well as src/
npm run test:rust   # Rust: pure units + SQLite posting integration
npm run check:rust  # cargo check

npm run verify      # all of the above, plus the frontend build, in order
```

`npm run verify` runs `npm run build` before the cargo steps on purpose:
`tauri::generate_context!()` resolves `frontendDist: "../dist"` at compile time,
so cargo cannot build on a tree that has never been built.

## Layers

| Layer | Location | What it covers | Authority |
|---|---|---|---|
| **A. TypeScript units** | `tests/unit/` | Pure financial helpers: money, VAT, UoM, sale/purchase line math, discount allocation | Authoritative for `src/lib/` |
| **B. Rust units** | `src-tauri/src/tests/pure.rs` | `new_weighted_avg`, the four commands' pure validators, `prepare_sale` totals and change routing | Authoritative for pre-DB posting logic |
| **C. Rust posting integration** | `src-tauri/src/tests/` | Migrations, `post_sale`, `post_purchase`, `post_adjustment`, `post_supplier_payment`, whole-ledger reconciliation, immutability triggers | **Authoritative for the database and all posting behaviour** |
| **C2. TypeScript SQL / read-model** | `tests/integration/` | Repository SQL for reports, shift summaries, drawer reconciliation | Authoritative for read-model queries only |

### A note on what layer C2 is *not*

`tests/integration/` runs repository SQL against Node's built-in `node:sqlite`
with `src/db/client.ts` replaced (`tests/helpers/mockClient.ts`). That makes it
a **SQL / read-model integration layer**, not an end-to-end Tauri test:

- `@tauri-apps/plugin-sql` is not involved, so the plugin's own marshalling,
  connection pooling and migration tracking are not exercised.
- No Rust posting command runs. Rows are inserted by fixtures in
  `tests/helpers/sqlDb.ts`, shaped to match what `post_sale` actually persists.
- It applies the migration `.sql` files directly rather than through sqlx.

**The Rust temp-file suite is the authoritative database and posting
integration layer.** Anything about how a transaction is written belongs there.

## Temporary databases

**The production `greaz-pos.db` is never opened by any test.**

**Rust (layer C)** — `src-tauri/src/test_support.rs`:

- Each test calls `TempDb::new()`, which creates its own file at
  `%TEMP%/greaz-pos-tests/<uuid>.db`. No two tests share a database, so tests
  are order-independent and can run in parallel.
- `assert_not_production_db` runs on every creation and panics if the path is
  named like the production database or sits outside the temp root. Two tests
  in `migrations.rs` assert that this guard actually fires.
- Migrations are applied with `app_migrator()`, built from
  `crate::migrations()` — the very list `run()` registers with
  tauri-plugin-sql — converted the same way the plugin converts it
  (`MigrationType::ReversibleUp`, `no_tx = false`) and run through sqlx's real
  `Migrator::run`. The production runner and the tests therefore cannot drift.
- `PRAGMA foreign_keys = ON`, and `max_connections(1)`: a single connection is
  the most faithful, most deterministic representation of the app's
  transactional usage.
- `Drop` releases the pool *before* unlinking, then retries the unlink briefly
  (Windows will not delete a file with an open handle). A run leaves no files
  behind.

Two constraints worth knowing if you add tests:

- Async tests use `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`.
  On a current-thread runtime, `Drop` blocking on file removal starves the
  pool's own shutdown task and the cleanup silently fails.
- Never `block_on` inside `Drop` — it deadlocks when `Drop` runs while the
  test's runtime is shutting down.

**TypeScript (layer C2)** — every database is `:memory:`, enforced by
`assertInMemory` in `tests/helpers/sqlDb.ts`. Opening a file is impossible.

`vitest.config.ts` pins `TZ=UTC`, because `reports.ts` groups on
`date(posted_at, 'localtime')` and would otherwise give different answers on
different machines. (That timezone sensitivity is itself a latent issue; WP-01
only makes the tests deterministic, it does not change the SQL.)

## Invariants this suite protects

- **Sale reconciliation** — `subtotal_excl_vat + vat = total_incl_vat`; the
  persisted header equals `SUM(sale_items)`; `tendered − change = amount due`;
  header COGS equals the sum of the line snapshots.
- **Inventory reconciliation** — `SUM(inventory_movements.quantity_delta)`
  equals `products.quantity_on_hand` across opening stock, purchases, sales and
  adjustments; one movement per stocked sale line, none for services.
- **Service items** — never alter physical stock and carry no COGS, even when
  the product row holds an average cost.
- **VAT** — taxable lines decompose exactly; exempt lines carry zero; mixed-VAT
  transactions reconcile at header level.
- **Discounts** — the allocator distributes the header discount across lines to
  the exact cent, with no cent lost to proportional rounding; post-discount line
  parts still satisfy `excl + vat = total`.
- **COGS** — line snapshots are immutable once posted and survive later cost
  changes; `weighted_average` and `last_purchase` use their own cost bases, and
  `last_purchase` falls back to the weighted average without purchase history.
- **Purchases** — header reconciles to lines; weighted-average cost blends
  correctly; credit purchases raise the payable by exactly the gross total while
  opening stock raises nothing.
- **Immutability** — posted sales, sale items, payments, purchases, purchase
  items, inventory movements and supplier-ledger entries reject UPDATE and
  DELETE; the one carve-out (posted → voided) still refuses to rewrite money.
- **Migrations** — every migration applies to a virgin database, re-running is a
  no-op, and two independent databases end up with identical schema and
  checksums.

## Known-defect register

These tests state the invariant the system *should* uphold, are skipped or
`#[ignore]`d because the current implementation violates it, and are owned by a
later work package. **Each one has been confirmed to fail when enabled** — none
is dormant by accident.

To enable one: delete its `#[ignore = ...]` line (Rust) or change `it.skip` to
`it` (TypeScript) as part of the owning package.

| ID | Owner | Test | Invariant it will enforce |
|---|---|---|---|
| **GP-A01** | WP-02 | — (no ignored test; see below) | Checkout idempotency. The invariant cannot be stated yet — see "GP-A01" below for why, and for the control test that guards the fix. |
| **GP-A02** | WP-02 | `known_defects::gp_a02_base_quantity_must_be_derived_from_the_uom_factor` | `quantity_base` must be recomputed from `quantity_in_uom × num ÷ den`, not trusted from the payload. |
| **GP-A02** | WP-02 | `known_defects::gp_a02_the_stock_guard_must_validate_the_true_base_quantity` | The stock guard must compare the *true* base quantity against stock on hand. |
| **GP-A03** | WP-03 | `known_defects::gp_a03_fractional_base_unit_costs_must_survive_conversion` | A sub-cent per-base cost must survive. Today $2.50/kg with a gram base rounds to $0.00/g and all COGS is zero. **Needs a schema/representation change**, which WP-01 was forbidden to make. |
| **GP-A03** | WP-03 | `uom.test.ts` › `GP-A03 … preserves sub-cent per-base costs` | The same defect at the pure-helper level: `unitCostInUomToBase(250, 1000/1) === 0`. |
| **GP-A04** | WP-08 | `shifts.test.ts` › `getSalesSummary` › `GP-A04 … does not subtract the discount twice` | `netSalesExclVatCents` must not subtract the discount a second time. Lines are persisted post-discount, so `subtotal − discount` understates net sales (observed: 711 where 811 is correct). |
| **GP-A04** | WP-08 | `shifts.test.ts` › `shiftSummaryRepo` › `GP-A04 … does not subtract the discount twice` | The same defect in the date-scoped day summary. |
| **GP-A05** | WP-02 | `known_defects::gp_a05_a_stocked_product_must_always_move_stock` | A stocked product must produce its inventory movement and decrement stock regardless of a stale `isService` flag in the payload. `post_sale` uses the DB's `is_service` for the guard and COGS but the payload's for the movement. |
| **GP-A06** | WP-02 | `known_defects::gp_a06_a_line_whose_parts_do_not_sum_must_be_rejected` | The backend must reject a line whose `subtotal + vat ≠ total` instead of summing it into an immutable header. |
| **GP-A07** | WP-02 | `known_defects::gp_a07_line_discounts_must_sum_to_the_header_discount` | `SUM(sale_items.line_discount_cents)` must equal `sales.discount_cents`. The allocator gets this right; the backend never verifies it. |
| **GP-A08** | WP-06 | — (coverage gap, no test) | See below. |

Cross-package note: GP-A04's root cause is the post-discount persistence
convention that GP-A07 also touches. If WP-02 changes what `post_sale` stores,
re-check GP-A04's fixtures before WP-08 starts.

### GP-A01 — checkout idempotency (WP-02)

**There is deliberately no ignored test for this**, because the invariant
cannot be expressed against today's production contract without stating
something false.

The tempting formulation — *"two commercially identical sale requests must
produce only one sale"* — **is wrong, and must not be written.** Two customers
buying the same two coffees within a minute are two sales. A future
implementation that deduplicated on basket *content* to make such a test pass
would silently swallow the second customer's money. A red test must never be
allowed to force a bad fix.

The real problem is that Greaz has **no stable checkout identity**:
`db/repos/sales.ts::post` mints a fresh `saleId` (and fresh sale-item and
payment ids) on every call, so a retried checkout is indistinguishable at the
backend boundary from a brand-new one.

Two **passing** tests in `sales.rs` fence the area off:

- `two_identical_baskets_with_different_identities_both_post` — a control test.
  Two identical carts with distinct transaction identities must both post, both
  decrement stock, and both bank their tender. **This is what stops WP-02 from
  implementing content-based deduplication.**
- `replaying_a_payload_with_the_same_primary_keys_is_rejected_and_rolls_back` —
  a characterization of what the backend does today when the *exact same
  identifiers* are replayed: the `sales.id` primary key refuses the second row
  and the whole transaction rolls back (no stock movement, no receipt number
  consumed). **Scope: this is protection from duplicate primary identifiers
  only. It is not checkout idempotency and does not solve double-submit** —
  the real client mints a new `saleId` per attempt, so a retry never reaches
  this path.

**WP-02 must introduce or define a stable checkout/idempotency identity that
survives a retry** (issued before the first attempt, reused unchanged by every
retry of that checkout). Its regression test must prove *both* halves:

1. the **same** idempotency identity replayed → exactly one financial
   transaction and one stock effect;
2. two identical baskets with **different** idempotency identities → two
   legitimate sales.

WP-01 deliberately did not invent a test-only idempotency mechanism, and added
no idempotency field to production.

### GP-A08 — returns / credit memos (WP-06)

**There is nothing to characterize on this branch, and no test is registered
for it.** `sales.sale_type` permits `'credit_memo'` and `inventory_movements`
documents `'return_in'` / `'return_out'`, but no command writes either and no
repository reads them. WP-01 was instructed not to import or implement returns.

This is therefore a **documented coverage gap only** — no passing placeholder,
no skipped assertion. (An earlier draft asserted that no credit-memo rows
exist; that was dropped because an empty-table query keeps passing after
returns are implemented, so it senses nothing.)

WP-06 owns both the implementation and its regression coverage, and must add at
least:

- a credit-memo posting command with its own numbering,
- restocking movements that keep the inventory reconciliation invariant,
- COGS reversal at the **original** sale's snapshot cost, not today's,
- refund tenders that net correctly in shift and daily reports,
- a guard against returning more than the original receipt sold.

When that lands, add the tests against the real behaviour and move GP-A08 out
of the gap table.

## Toolchain verified

WP-01 was developed and verified against **Node 24.15.0**, npm 12.0.2, and
Rust 1.7x/cargo (`rustc 1.95.0`). Two notes on the TypeScript layer:

- `node:sqlite` is documented by Node as **Stability 1.2 (release candidate)**.
  It works reliably on 24.15.0 and keeps the harness dependency-free, but it is
  not yet a fully stable API; if a future Node changes it, layer C2 is the only
  thing affected. The authoritative database layer is Rust/sqlx and does not
  depend on it.
- The installed `@types/node` major does not match the Node runtime major.
  This is types-only, `npm run test:types` is clean, and it was left alone
  rather than churning dependencies inside a test-harness work package.

## Remaining gaps

Not covered by this harness, and worth knowing before relying on it:

- **No UI or component tests.** `PosRegister.tsx` cart state, scanning, and
  multi-cart behaviour are untested; only the discount helpers were extracted.
- **No end-to-end Tauri test.** Nothing exercises the real IPC boundary, the
  plugin's connection pool, or `App.tsx`'s three-stage boot.
- **No concurrency tests.** The suite uses `max_connections(1)`; it cannot
  detect races between simultaneous posts. This matters for GP-A01.
- **Timezone handling in reports** is pinned to UTC rather than tested. The
  `localtime` grouping in `reports.ts` is a latent correctness issue.
- **Repositories other than reports/shifts** — products, barcodes, suppliers,
  purchases read-side, movements — have no query coverage.
- **Accounting tables** (`accounts`, `journal_entries`, `journal_lines`) are
  created by migration 001 but nothing posts to them, so nothing is asserted.
- **`sync_queue`** is scaffolding; untested by design.
