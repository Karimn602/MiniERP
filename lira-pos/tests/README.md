# Greaz POS test harness (WP-01, extended by WP-02, WP-03, WP-04 and WP-05)

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
| **A. TypeScript units** | `tests/unit/` | Pure financial helpers: money, VAT, UoM, the fixed-point cost scale (`cost.test.ts`), sale/purchase line math, discount allocation; the register's checkout submission gate and identity registry | Authoritative for `src/lib/` |
| **B. Rust units** | `src-tauri/src/tests/pure.rs`, `cost.rs` | The four commands' pure validators, `prepare_sale` totals, change routing, line/discount reconciliation, base-quantity derivation, `prepare_purchase`'s derived line money, the purchase cost pair's VAT derivation, supplier-ledger sign authority; the whole `crate::cost` abstraction — scale, rounding, weighted average, overflow | Authoritative for pre-DB posting logic |
| **C. Rust posting integration** | `src-tauri/src/tests/` | Migrations, `post_sale`, `post_purchase`, `post_adjustment`, `post_supplier_payment`, `open_shift`, `close_shift`, whole-ledger reconciliation, immutability triggers, the cost lifecycle (`cost_precision.rs`), purchase UoM authority (`purchase_authority.rs`), shift lifecycle and concurrency (`shifts.rs`), tender/change/rate authority (`tenders.rs`), purchase→AP reconciliation, duplicate invoices and purchase identity (`supplier_ap.rs`), supplier-payment sign/overpayment/identity (`supplier_payments.rs`) | **Authoritative for the database and all posting behaviour** |
| **C2. TypeScript SQL / read-model** | `tests/integration/` | Repository SQL for reports, shift summaries, drawer reconciliation, inventory valuation, the supplier balance (`supplierLedger.test.ts`); the `invoke` wire format of the shift commands | Authoritative for read-model queries only |

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
- `seed_product` also creates the product's base `product_uoms` row, exactly as
  `productsRepo.create` does, because `post_sale` resolves the sale UoM against
  that table. `seed_product_uom` adds a derived one (e.g. `box` = 12 base).
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
  header COGS equals the sum of the line snapshots. Enforced at the posting
  boundary since WP-02: a line whose parts do not sum, or which charges VAT at
  an exempt rate, is refused rather than summed into an immutable header.
- **Checkout idempotency** — `sales.id` is the checkout identity. Replaying it
  with the same canonical transaction returns the sale that exists (one sale,
  one receipt number, one stock effect, one tender) without consuming a receipt
  number; replaying it with materially different content is a conflict and is
  refused; two identical baskets under different identities are two sales. An
  unresolved posting attempt pins its identity — the cart cannot be cleared or
  closed until the attempt settles, so a lost answer can still be retried
  against the sale it may already have created.
- **Authoritative posting inputs** — on BOTH sides of the ledger, the conversion
  comes from the product's own `product_uoms` row: `post_sale` since WP-02
  (GP-A02) and `post_purchase` since WP-03. The UoM code is a lookup key scoped
  by `product_id` and `is_active`, the base quantity is derived from the resolved
  factor, and that one resolved factor drives the per-base cost, the persisted
  snapshots, the movement, stock, the weighted average and the last-purchase
  rate. A payload declaring a different factor, base quantity or `product_uoms`
  row id is refused, not normalized. `products.is_service` decides whether a sale
  line moves stock. None of it can be overridden by the payload.
- **Discount reconciliation** — `SUM(sale_items.line_discount_cents)` equals
  `sales.discount_cents`, enforced at the boundary.
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
- **Unit cost precision** — a unit cost is a RATE in microcents
  (1 cent = 1,000,000), not an amount in cents, so a cost below a cent per base
  unit survives: flour bought at $2.50/kg and stocked in grams costs $0.0025/g,
  not $0.00. One scale constant, one rounding rule (half away from zero), one
  monetary boundary (`extended_cost_cents`: rate × quantity, rounded once).
  Whole-cent costs give byte-identical results to the pre-WP-03 code, and a cost
  or inventory value too large to represent errors instead of wrapping.
- **COGS** — line snapshots are immutable once posted and survive later cost
  changes; the header equals the sum of the rounded line amounts, so reports
  that group by product reconcile to the day's total; `weighted_average` and
  `last_purchase` use their own cost bases at full precision, and
  `last_purchase` falls back to the weighted average without purchase history.
- **Purchases** — header reconciles to lines; weighted-average cost blends
  correctly; credit purchases raise the payable by exactly the gross total while
  opening stock raises nothing.
- **Shift lifecycle** — at most one OPEN shift per store, the scope the
  application has always queried by. Enforced transactionally by `open_shift`
  and in the engine by the partial unique index
  `ux_shifts_one_open_per_store`, so two concurrent opens resolve into exactly
  one open shift. `close_shift` computes the reconciliation and writes it in one
  transaction, so the stored snapshot IS the state that was marked closed. A
  failed close writes no part of a reconciliation, and a closed shift is
  immutable (`trg_shifts_no_update_after_close`), so a second Close cannot
  overwrite a count somebody signed off.
- **Sale ↔ shift** — a NEW sale must name an open shift of its own store.
  `post_sale` verifies inside its own transaction that the shift is given, that
  it exists, that it belongs to the sale's store and that it is still open —
  at the top and again immediately before the commit. A sale never commits
  into a closed shift or into no shift at all, and a close never omits a sale
  that committed into the shift it closed. Replay is exempt by design and the
  ordering is what makes that true: a replay writes nothing, so it still
  reconciles to its original receipt after the shift has been counted, and even
  when the historical row carries a NULL `shift_id` from before the rule
  existed. `sales.shift_id` stays nullable; the rule governs writes, not
  history.
- **Tender authority** — a payment row cannot contradict itself. `method`
  decides the currency where its name names one, the native amount must be the
  one that currency is denominated in, and
  `amount_usd_cents_equivalent` is DERIVED: a USD tender's equivalent is itself,
  an LBP tender's is its lira at the rate locked on the sale. That locked rate is
  itself verified against the `exchange_rates` row named by `exchange_rate_id`,
  scoped by store, before anything is written — so every LBP equivalent in the
  database was computed from one stored rate and no client figure.
- **Change is cash** — non-cash tender may never exceed the amount due, and the
  row that absorbs an overpayment is always a cash row (USD cash preferred, then
  LBP cash, expressed in that row's own currency at the locked rate). A card
  overpayment is refused outright rather than written as drawer change. Expected
  drawer cash is `opening float + cash in − change out` per currency, counting
  only `cash_usd` / `cash_lbp` rows in BOTH terms — so a card can neither inflate
  nor reduce physical cash, including on rows an earlier release wrote. Variance
  is `counted − expected`: negative short, positive over.
- **One authoritative unit price per purchase line** — a supplier invoice quotes
  ONE price per unit. `vat_pricing_mode` names which side of the line's
  excl/incl pair that is (the payload's, or `products.vat_pricing_mode` when the
  payload is silent), and the counterpart is DERIVED with the application's own
  VAT rounding — `posting.rs::add_vat` / `strip_vat`, mirroring `lib/vat.ts` in
  integer arithmetic — then cross-checked, with a disagreement refused. At 0 bps
  the two sides must be one figure. `add_vat` and `strip_vat` are not exact
  inverses at cent precision, so the mode fixes the direction instead of the
  backend guessing: at 11% the pair (50, 55) is a coherent gross-quoted invoice
  and an impossible net-quoted one. The check is a pre-pass, so a malformed pair
  leaves no document, goods, debt, cost blend or sequence advance behind — not
  even transiently. Without it a line could declare "$20.00 net, $999.00 gross"
  and stock inventory at a $20 cost basis while billing the shop $999.
- **Purchase ↔ AP** — a posted purchase raises a payable of exactly its own
  VAT-inclusive total, and that total is DERIVED from the per-UoM invoice cost
  and the quantity in that UoM, the way `lib/purchaseMath.ts` derives it. The
  client's declared line subtotal/VAT/total are a cross-check and a
  disagreement is refused, so there is no second amount a caller can book debt
  with. A normal purchase's supplier must belong to the purchase's store. The
  purchase, its lines, its movements, its stock and cost updates and its
  `supplier_ledger` row are one transaction: a failure leaves no document, no
  goods, no debt, no cost blend, and does not consume a purchase number. An
  `opening` batch raises nothing.
- **One posted purchase per supplier invoice** — for a non-blank reference, the
  same `(store, supplier, normalized reference)` may be POSTED once.
  `purchases.supplier_reference_key` is the canonical normalized form — trim +
  uppercase, the convention migration 002 already uses for
  `product_barcodes.lookup_value` — and a blank or whitespace-only reference
  normalizes to NULL and constrains nothing, so unnumbered receipts never
  collide. `post_purchase` checks before a purchase number is consumed and
  reports which purchase already holds the bill;
  `trg_purchases_no_duplicate_supplier_invoice_{ins,upd}` is the backstop for
  direct writers and for the interleaved case. Two suppliers may both number an
  invoice "1001". A refused duplicate changes nothing — not stock, not the cost
  pool, not the payable, not the sequence.
- **AP retry identity** — `purchases.id` and `supplier_ledger.id` are document
  identities. Replaying one with the same canonical content reconciles to the
  row that already posted (one payable, one stock receipt, one cost blend, one
  purchase number) and replaying it with materially different content is a
  conflict. Technical retry idempotency is kept strictly apart from business
  duplicate-invoice detection: two deliveries of the same goods under different
  identities and different invoice numbers are two legitimate purchases, and two
  separate payments of the same amount are two payments. Child row ids
  (`purchase_item_id`) are request noise and are excluded from replay equality,
  as are the derived per-base costs.
- **Supplier-ledger sign** — positive means the shop owes more. `purchase` → +,
  `payment` → −, `credit_note` → −; `opening_balance` and `adjustment` are
  deliberately bidirectional and take the caller's sign. For the fixed-direction
  types the backend applies the sign itself from a positive
  `amountMagnitudeCents`, so a payment sent with the wrong sign still pays the
  balance down instead of adding to it. The legacy signed `amountCents` stays on
  the wire: its magnitude is honoured, its sign is not, and when both fields
  arrive they must agree about how much money moved.
  `trg_supplier_ledger_sign_discipline` enforces the same convention against
  every other writer, plus that an entry is filed against the supplier's own
  store. `post_supplier_payment` cannot write a `purchase` entry at all — only a
  purchase document may raise a payable.
- **No supplier advances** — a `payment` larger than the outstanding payable is
  refused, and the payable it is measured against is read inside the posting
  transaction, never taken from a displayed figure. Partial payment is
  supplier-level (there is no invoice allocation model), works to the cent, and
  lands exactly on zero. Two payments racing one balance cannot together
  overpay. A negative balance stays reachable through the two explicitly-signed
  instruments — a `credit_note` the supplier issued or a signed-off
  `adjustment` — which is the "credit on file" state the Supplier screen already
  displays.
- **One supplier balance** — `supplierLedgerRepo.getBalance`, `listBalances`,
  `decorateSuppliersWithBalances`, the `supplier_balances` view and
  `posting.rs::current_supplier_balance` all compute `SUM(amount_cents)` over
  the same rows, so the figure a buyer pays against is the figure the posting
  command checks. Invoice liabilities reconcile to the posted purchase totals
  that raised them; a supplier with no activity reads as zero rather than
  missing; no read path reverses a sign.
- **Immutability** — posted sales, sale items, payments, purchases, purchase
  items, inventory movements and supplier-ledger entries reject UPDATE and
  DELETE; the one carve-out (posted → voided) still refuses to rewrite money.
  Since WP-04, closed shifts too.
- **Migrations** — every migration applies to a virgin database, re-running is a
  no-op, and two independent databases end up with identical schema and
  checksums. Since WP-03 the UPGRADE path is covered too: migration 008 applies
  to a populated pre-WP-03 database, backfills every existing cost exactly
  (`cents × 1,000,000`, a change of units and not a recomputation), restores the
  three append-only triggers its backfill has to lift, is idempotent through the
  real runner, and leaves an upgraded database on byte-identical schema to a
  fresh install. Migration 009 is covered the same way: it applies to a
  populated v8 database, leaves a single open shift and each store's own open
  shift alone, deterministically closes the older of several open shifts for one
  store without inventing a cash count for a drawer nobody counted, keeps closed
  and voided shifts unconstrained, preserves migration 008's restored triggers,
  and converges on byte-identical schema with a fresh install. Migration 010
  likewise: it applies to a populated v9 database, needs no backfill because the
  normalized reference is a generated column, upgrades a database that ALREADY
  holds a duplicate invoice without deleting, rewriting or annotating either
  financial document (the rule binds writes from then on), leaves a
  historically wrong-signed ledger row alone while refusing a new one, is
  idempotent through the real runner, disturbs none of the earlier guards, and
  converges on byte-identical schema with a fresh install.

## Known-defect register

These tests state the invariant the system *should* uphold, are skipped or
`#[ignore]`d because the current implementation violates it, and are owned by a
later work package. **Each one has been confirmed to fail when enabled** — none
is dormant by accident.

To enable one: delete its `#[ignore = ...]` line (Rust) or change `it.skip` to
`it` (TypeScript) as part of the owning package.

| ID | Owner | Test | Invariant it will enforce |
|---|---|---|---|
| **GP-A04** | WP-08 | `shifts.test.ts` › `getSalesSummary` › `GP-A04 … does not subtract the discount twice` | `netSalesExclVatCents` must not subtract the discount a second time. Lines are persisted post-discount, so `subtotal − discount` understates net sales (observed: 711 where 811 is correct). |
| **GP-A04** | WP-08 | `shifts.test.ts` › `shiftSummaryRepo` › `GP-A04 … does not subtract the discount twice` | The same defect in the date-scoped day summary. |
| **GP-A08** | WP-06 | — (coverage gap, no test) | See below. |

Cross-package note for WP-08: GP-A04's root cause is the post-discount
persistence convention. WP-02 did **not** change it — `post_sale` still stores
post-discount line values and the header discount alongside them; it only
started *verifying* that the two agree. GP-A04's fixtures are unaffected.

### Fixed by WP-05 — now enforced, must not regress

| ID | Where the coverage lives | What is now enforced |
|---|---|---|
| **GZ-HI-05** | `supplier_ap.rs` (38 tests), `supplier_payments.rs` (25 tests), `migrations.rs` › "Migration 010" (6 tests), `pure.rs` › "Supplier-ledger sign authority", "Purchase line money" and "VAT arithmetic" (21 tests), `supplierLedger.test.ts` (13 tests) | One authoritative unit price per line, with the VAT counterpart derived and cross-checked; a purchase's payable is its own derived VAT-inclusive total, raised atomically with the goods; one supplier invoice reference posts once per supplier per store; both AP commands are idempotent on a document identity; the ledger sign is the backend's; a payment cannot exceed the outstanding payable; one balance arithmetic end to end. |

#### Three rules that look alike and are not

The hardest part of this package to keep straight, so it is worth stating
plainly. There are three separate "is this the same thing twice?" questions, and
collapsing any two of them breaks something real:

1. **Technical retry idempotency** keys on the identity the caller minted —
   `purchases.id`, `supplier_ledger.id`. It exists for the lost answer: the
   transaction committed, the client never saw the reply, the user presses the
   button again. The answer is "here is the document you already posted".
2. **Business duplicate-invoice detection** keys on the supplier's own
   reference. It exists for the paper on the counter: the same bill keyed twice,
   under two identities, possibly by two people. The answer is "purchase #N
   already holds that invoice".
3. **Neither of them is content deduplication.** Two separate deliveries of the
   same goods at the same price are two purchases. Two $40 payments to one
   supplier in a week are two payments. A rule that collapsed those would leave
   a shop still owing money it has already handed over — which is why
   `two_deliveries_of_the_same_goods_under_different_identities_both_post` and
   `two_separate_payments_of_the_same_amount_both_post` are tests and not
   footnotes.

#### Why the duplicate guard is a trigger and not a unique index

A partial unique index would be the stronger, declarative mechanism, and WP-04
used exactly that for `ux_shifts_one_open_per_store`. It is not available here,
because a unique index is a statement about the rows that already exist as much
as about the next one. Nothing before this release stopped a shop keying one
supplier invoice twice, `CREATE UNIQUE INDEX` over that data fails, and this is
a startup migration — so the failure mode is "the application will not open" for
precisely the shop whose books are already wrong. The only ways around it are to
rewrite or delete one of two real financial documents.

WP-04 could repair its drift (close the older of two open shifts) because
closing an uncounted shift and saying so in `notes` is a truthful record.
Nothing equivalent is true of a supplier invoice: there is no honest way to
restate which of two posted purchases the shop "really" received.

So the rule is a BEFORE INSERT/UPDATE trigger, which constrains only the write
in front of it. Historical duplicates stay visible, queryable and intact —
`migration_010_upgrades_a_database_that_already_held_a_duplicate_invoice`
asserts all three — and the shop cannot add a third.

It is not a weaker guarantee against the concurrent case. SQLite permits one
write transaction at a time, and the guard's `EXISTS` runs inside the
transaction doing the writing: a rival either committed before this transaction
took its read snapshot, in which case the `EXISTS` sees it, or it did not, in
which case it cannot commit until this one ends.
`two_concurrent_entries_of_one_invoice_cannot_both_commit` and
`two_payments_racing_the_same_balance_cannot_together_overpay` race two real
pools through `TempDb::rival_pool` and assert that at most one commits.

Both races assert `winners <= 1` rather than `== 1`, which is a deliberate
difference from the WP-04 shift races. "Neither" is a failure when opening a
shift — it leaves a cashier unable to trade. It is not a failure for a refused
bill or a refused payment: the buyer retries. Both tests go on to prove the
path still works afterwards, so "always fails" cannot pass them.

#### The normalized reference, defined twice

`purchases.supplier_reference_key` is a VIRTUAL generated column, so the
normalization has one definition, needs no backfill — which matters, because
backfilling a column on `purchases` would mean lifting the posted-purchase
immutability trigger over a shop's whole history — and cannot drift from what a
writer remembers to compute.

SQLite does not expose a VIRTUAL generated column through `NEW`, though: inside
a trigger it reads as NULL. So each duplicate trigger recomputes the key inline
from `NEW.supplier_reference`, with the identical expression. That is two copies
of one rule, and
`the_duplicate_guard_normalizes_exactly_as_the_stored_key_does` is what holds
them in step — it compares the stored column against the trigger's expression
row by row over a spread of awkward references.

The expression is
`NULLIF(TRIM(UPPER(x), char(9,10,13,32)), '')`. The explicit character set is
load-bearing: SQLite's one-argument `TRIM` strips spaces only, so a reference
pasted in with a trailing newline would not match the same reference typed by
hand. char(9,10,13,32) is tab, newline, carriage return and space — the
whitespace `String.prototype.trim()` strips on the JavaScript side of the same
convention (`lib/barcode.ts::normalizeBarcode`). `UPPER` folds ASCII only, which
is fine and symmetric: both sides of every comparison go through the same
expression, and Arabic is caseless.

#### What WP-05 deliberately left alone

- **Supplier payments are still not drawer events, and that is a decision, not
  an omission.** A `supplier_ledger` payment row records an amount in USD cents
  and nothing else — no method, no currency, no shift. Nothing says whether a
  given payment was lira out of this till, a bank transfer, or a cheque posted
  last week. Subtracting every supplier payment from expected cash would make
  the drawer look short by every payment that never touched it, and would
  attribute payments to whichever shift happened to be open when somebody typed
  them in. `close_shift` therefore still counts only `cash_usd`/`cash_lbp` sale
  tender, exactly as WP-04 left it, and `drawer_cash_for_shift`'s doc comment
  now says so in those terms. Giving supplier payments a tender model is a
  product decision: it needs a method, a currency, a shift attribution and a UI,
  and it is listed under *Remaining gaps*.
- **No invoice-level allocation.** Payment is against the supplier's open
  balance, which is the model the application already has — there is no
  allocation table, no "apply to invoice" affordance, and no aging. Part F of
  the brief explicitly permits the supplier-level model, and inventing an AP
  aging subsystem for a single-store restaurant pilot would be the wrong trade.
- **No "paid now" field on the Purchase screen.** The purchase posts the full
  liability and payment is a separate transactional action from the Supplier
  screen (MODEL 2 of the brief). Nothing in the UI labels a purchase as paid —
  there is no payment status on the purchase at all — so the retained model is
  already honest about what it knows. Adding an immediate-payment field is a UX
  decision nobody has asked for.
- **GP-A04** (report/shift discount double subtraction) is untouched and its two
  tests stay skipped. It belongs to WP-08.
- **Returns and credit memos** (GP-A08) remain WP-06. `credit_note` on the
  supplier ledger is a *supplier* credit and is unrelated to a customer return.
- **Purchase void.** `purchases.status` allows `'voided'` and migration 005's
  trigger permits posted → voided, but no command does it, so nothing reverses a
  payable. The duplicate rule is scoped to posted purchases, which means a
  voided invoice releases its reference — the behaviour a void ought to have
  when one is implemented. Recorded under *Remaining gaps*.

### Fixed by WP-04 — now enforced, must not regress

| ID | Where the coverage lives | What is now enforced |
|---|---|---|
| **GZ-HI-03** | `shifts.rs` (28 tests), `migrations.rs` › "Migration 009" (6 tests), `pure.rs` › the two shift-validator tests, `shifts.test.ts` › "the shift lifecycle commands" (3 tests) | Shift open and close are transactional Rust commands. One open shift per store, enforced by a single `INSERT … WHERE NOT EXISTS` statement and by `ux_shifts_one_open_per_store`; the close snapshot is computed and written in the same transaction that marks the shift closed; a NEW sale must name an open shift of its store, verified inside the posting transaction; a closed shift is immutable. |
| **GZ-HI-04** | `tenders.rs` (16 tests), `pure.rs` › "Tender authority" and "Change is a cash movement" (6 tests), `shifts.test.ts` › `getDrawerExpectation` (6 tests), `shifts.rs` › the drawer tests | A payment row cannot contradict itself; the USD equivalent is derived from the native amount and the locked rate; only cash can generate change; expected drawer cash counts cash rows only, in both the money-in and change-out terms. |

#### The fixture shift

`builders::sale_payload` attributes its sale to `test_support::SHIFT_ID`, and
every fixture that posts a sale calls `seed_open_shift`. A shift is not seed
data — migration 001 seeds the store, the user, the VAT rates and the units of
measure, but a cashier opens a shift — so leaving the call out is how a test
says *this store has no open shift*, which is now a posting error rather than a
quiet success. `sales.rs::close_the_fixture_shift` retires it for the two tests
that name shifts of their own, because a store may hold only one open shift.

`builders::seed_posted_sale_without_shift` writes a posted NULL-shift sale
directly. It has to: an unattributed new sale is exactly what `post_sale` now
refuses, so the historical row the replay path must keep honouring cannot be
produced through the command.

#### The shift scope, and why the constraint is `store_id`

WP-04 enforces the model the application already had rather than choosing a new
one. Four things in the code say the scope is the store and nothing finer:

- `shiftsRepo.getOpenShift(storeId)` selects on `(store_id, status = 'open')`
- migration 001 indexes exactly that pair (`idx_shifts_store_status`)
- `shifts.device_id` has never been populated — `state/activeContext.ts`
  hard-codes `deviceId: null` and no `devices` row is ever created
- the cashier is recorded (`opened_by_user_id`) but never scoped on: any cashier
  rings up against the store's open shift

So `ux_shifts_one_open_per_store` is a partial unique index on `store_id` where
`status = 'open'`. A per-device or per-cashier scope would have been a different
operating model, not a fix to this one.

`migration_009_leaves_each_store_its_own_open_shift` pins the other half of that
decision: two stores trading at once is correct, not drift.

#### Three tests that document deliberate boundaries

- `a_retry_still_reconciles_after_its_shift_has_been_closed` — the shift check
  sits *after* the idempotency check on purpose. A replay writes nothing, so a
  cashier retrying a sale that is already banked gets the original receipt back
  rather than an error about a drawer that has since been counted. Moving that
  check earlier would break WP-02's GP-A01 guarantee.
- `a_historical_null_shift_sale_can_still_be_replayed` and
  `a_historical_null_shift_identity_still_fails_canonical_comparison` — the two
  halves of the replay exemption. The first cut of WP-04 validated `shift_id`
  only when present, so a payload that simply omitted it posted; the release
  gate caught it. A NEW sale now requires an open shift of its store, but a
  retry of a sale that already posted must still return its original receipt —
  including a row written before the rule existed, whose `shift_id` is NULL.
  The exemption is exactly that: a replay writes nothing. It is not a hole in
  the canonical comparison, which is why the second test reuses a NULL-shift
  identity for different content, a different tender, and a newly attached
  shift, and requires a conflict for each.
- `a_non_cash_tender_can_never_be_over_collected`, last case — cash handed over,
  then the card swiped for the *whole* bill and the cash given straight back
  ("put it all on the card") is ALLOWED. The card is charged exactly what is
  owed, both cash movements really happened, and the drawer nets to zero. That is
  why the rule is "non-cash may not exceed the amount due" rather than "the
  tender must equal the amount due".

#### How the concurrency tests work

`shifts.rs` has the suite's first real races. They use
`TempDb::rival_pool()` — a second connection pool against the same database
file, configured exactly as `posting::pool` configures production (same
`sqlite://…?mode=rwc` URL, same `PRAGMA foreign_keys = ON`, sqlx's default
five-second busy timeout). `TempDb`'s own pool holds one connection, which makes
posting tests deterministic but serialises everything before SQLite sees it, so
two commands on it could never contend.

Nothing in the rival pool is made more forgiving than the real application, so a
lock error a test sees is one a cashier could see. Each race therefore asserts
the *set* of acceptable serialisations rather than a single winner:

- `two_simultaneous_opens_cannot_both_produce_an_open_shift` — exactly one
  succeeds, the store ends with exactly one open shift, and the loser leaves no
  row at all.
- `two_simultaneous_closes_reconcile_the_shift_exactly_once` — exactly one
  succeeds; the persisted count, expected figure and variance are the winner's
  and agree with each other.
- `a_sale_racing_a_close_resolves_into_one_of_two_valid_outcomes` — either the
  sale committed and the close that followed counted it, or the shift closed and
  the sale was refused with no row behind it. A lock error on either side is a
  legitimate loser. Whatever happens, the shift is asserted to be *wholly* open
  or *wholly* closed — never half-reconciled.

This narrows, but does not close, the "no concurrency tests" gap recorded under
**Remaining gaps**: these three cover the shift boundary. Concurrent posts of the
same checkout identity are still unproven, and general busy/lock retry behaviour
is WP-07.

#### What WP-04 deliberately left alone

- **GP-A04** (report/shift discount double subtraction) is untouched and its two
  tests stay skipped. It belongs to WP-08.
- `shiftsRepo.getSalesSummary` and `shiftSummaryRepo` keep their current
  semantics, including that defect.
- Refunds and credit memos (WP-06) and petty cash / cash-in / cash-out are *not*
  in the expected-drawer calculation, because no flow produces them yet.
  `posting.rs::drawer_cash_for_shift` names each one, so the package that adds a
  flow knows where its drawer effect belongs. Supplier payments were examined by
  WP-05 and deliberately left out too — see *What WP-05 deliberately left
  alone* above: a payment row has no method, no currency and no shift, so there
  is nothing to attribute to a drawer yet.
- **Shift DELETE is not guarded.** Migration 009's
  `trg_shifts_no_update_after_close` blocks UPDATE on a closed shift but not
  DELETE. Not a WP-04 issue: there is no production delete path, and
  `sales.shift_id REFERENCES shifts(id) ON DELETE RESTRICT` already protects
  any shift that has sales. A shift with no sales could still be deleted by a
  direct statement. Recorded here for WP-07 / database hardening.

### Fixed by WP-03 — now enforced, must not regress

| ID | Where the coverage lives | What is now enforced |
|---|---|---|
| **GP-A03** | `known_defects::gp_a03_*` (enabled), `cost.rs` (20 tests), `cost_precision.rs` (16 tests), `migrations.rs` › "Migration 008" (5 tests), `cost.test.ts` (25 tests), `uom.test.ts` › the two `GP-A03` tests, `purchaseMath.test.ts` › "per-base unit cost precision", `valuation.test.ts` | A unit cost is a microcent rate throughout: derived once at microcent scale from the invoice's per-UoM cost, blended by the weighted average without intermediate rounding, read back by `last_purchase` at full precision, and turned into money exactly once per line. |
| **Purchase UoM authority** | `purchase_authority.rs` (16 tests) | `post_purchase` resolves the product's own active `product_uoms` row and derives the base quantity from ITS factor. One resolved conversion drives cost, snapshots, movement, stock, weighted average and last-purchase rate; a contradictory factor, base quantity or UoM row id refuses the whole invoice atomically. Found by the WP-03 release-gate review: precision over a client-supplied quantity is precision over a quantity nobody received. |

Two notes on how the GP-A03 characterizations changed when they were enabled —
both tighten the assertion rather than relax it:

- The Rust test asserted `avg_cost_excl_vat_cents > 0`. It now names
  `avg_cost_excl_vat_microcents` and pins the **exact** rate (250,000 µ¢ for
  $2.50/kg in grams). The cents column still rounds $0.0025 to 0, because it is
  now a display mirror — which is the point: nothing costs from it. The money
  assertion (`line_cogs_excl_vat_cents == 125` for 500 g) is unchanged from the
  original characterization.
- The TypeScript test asserted `unitCostInUomToBase(250, 1000/1) > 0`, i.e. that
  a cents-returning function preserve a sub-cent value — which it cannot. It now
  targets `unitCostInUomToBaseMicrocents`, the helper the purchase path actually
  uses, with the exact expected rate; a second test pins
  `unitCostInUomToBase(250, …) === 0` deliberately, to record that the old
  behaviour is still there and is still display-only.

Two fixtures changed when purchase authority landed, and the change is worth
understanding: `purchases.rs::store_with_supplier_and_products` and the GP-A03
fixture in `known_defects.rs` both purchased in a derived UoM (`box`, `kg`) that
was never seeded on the product. Those payloads were only ever accepted because
the backend trusted the client's factor. Both fixtures now seed the row via
`seed_product_uom`; **no assertion was relaxed**, and the GP-A03 expectations are
unchanged.

`purchase_authority.rs` was confirmed to detect the defect: with the two mismatch
guards disabled, `an_understated_client_base_quantity_is_refused_atomically`,
`a_client_factor_that_contradicts_the_product_is_refused_atomically`,
`the_base_quantity_mismatch_error_names_the_authoritative_conversion` and
`one_bad_line_rolls_back_the_entire_multi_line_purchase` all fail.

### Fixed by WP-02 — now enforced, must not regress

These were ignored known defects. They are live tests now; the audit IDs are
kept in the test names so the register stays greppable.

| ID | Where the coverage lives | What is now enforced |
|---|---|---|
| **GP-A01** | `sales.rs` › "Checkout idempotency" (6 tests) and "Replay conflict detection" (12 tests), `checkout.test.ts` (23 tests) | `sales.id` is the checkout identity and `post_sale` is idempotent on it; a reused identity carrying materially different content is a conflict. An unresolved attempt pins the identity. See below. |
| **GP-A02** | `known_defects::gp_a02_*`, `sales.rs` › "Authoritative UoM / base quantity" (5 tests), `pure.rs` › `base_quantity_*` | The base quantity is derived from the product's own `product_uoms` factor and drives the guard, the movement, the decrement and the COGS basis. A UoM the product does not actively sell in, and a payload quantity that contradicts the conversion, are both refused. |
| **GP-A05** | `known_defects::gp_a05_*`, `sales.rs` › `the_database_decides_whether_a_line_moves_stock_not_the_payload` | `products.is_service` decides whether a line moves stock. A stale `isService: true` cannot suppress a stocked product's movement, and a stale `false` cannot invent one for a service. |
| **GP-A06** | `known_defects::gp_a06_*`, `sales.rs` › "Line / header financial reconciliation" (3 tests), `pure.rs` | Per line, `subtotal + VAT = total` in exact integer cents, and an exempt (0 bps) line carries no VAT. Refused before the transaction opens. |
| **GP-A07** | `known_defects::gp_a07_*`, `sales.rs` › "Discount reconciliation" (3 tests), `pure.rs` | `SUM(line_discount_cents) == sales.discount_cents`. The allocator was already exact; the boundary now verifies it. |

WP-02 deliberately did **not** touch the VAT split itself. Both legitimate
decompositions in the codebase — per-unit-then-multiply (`lib/saleMath.ts`) and
total-then-strip (`lib/discount.ts`) — can differ by a cent while both
reconciling, so the boundary enforces the additive identity and not a
re-derivation from the rate.

### GP-A01 — checkout idempotency (fixed in WP-02)

WP-01 recorded no ignored test for this, because the invariant could not be
stated against the contract of the time without stating something false. The
tempting formulation — *"two commercially identical sale requests must produce
only one sale"* — **is wrong and must never be written.** Two customers buying
the same two coffees within a minute are two sales; deduplicating on basket
*content* would silently swallow the second customer's money.

#### The identity rule

`sales.id` **is** the checkout identity. Everything follows from that:

| Situation | Outcome |
|---|---|
| Same identity, same canonical transaction | The existing posted result is returned. One sale, one receipt number, one stock effect, one tender. |
| Same identity, materially different canonical transaction | **Conflict — the request is refused.** Nothing is written and the posted sale is left exactly as it was. |
| Same identity, existing sale not in `posted` state (e.g. voided) | Refused. A voided sale cannot be resurrected by replaying its identity. |
| Same basket, different identity | A legitimate separate sale. Both post, both decrement stock, both bank their tender. |

Idempotency is keyed on the identity **alone**. Content is never used to decide
that two requests are the same checkout — only to detect the opposite mistake,
one identity reused for a transaction nobody rang up under it.

- `pages/PosRegister.tsx` issues one identity per cart on its first Post press,
  keeps it in the cart (so a parked cart keeps it across a reload), reuses it
  unchanged for every retry of that attempt, and retires it once the sale
  posts. It is *kept* on failure, so a retry after a fixed error — or after an
  answer the client never saw — is the same checkout.
- `posting.rs::post_sale` looks the identity up **before** it writes anything,
  and in particular before `next_receipt_number` is consumed, so a replay costs
  the receipt sequence nothing. The read happens inside the transaction, which
  is then rolled back rather than committed, because a replay writes nothing.

Two tests fence the area off:

- `sales.rs::two_identical_baskets_with_different_identities_both_post` — the
  control test. **This is what stops a future change from sliding into
  content-based deduplication.**
- `sales.rs::a_new_checkout_identity_posts_normally_after_a_replayed_one` — a
  retry storm must not affect the next customer's receipt number.

`replaying_a_payload_with_the_same_primary_keys_is_rejected_and_rolls_back` was
WP-01's characterization of the old behaviour (the `sales.id` primary key
refusing a second row). WP-02 replaced it: that replay is now the supported
retry path, so the test became
`replaying_the_same_checkout_identity_posts_exactly_one_sale`.

#### What "the same canonical transaction" compares

`posting.rs::CanonicalSale` reduces both the incoming payload and the persisted
sale to the same shape, and `sale_replay_matches_existing` compares them field
by field, naming the first material difference in the error. The comparison
covers the **materially relevant persisted content**, not just the headline
total — two carts can share a total and still be different transactions:

| Group | Compared |
|---|---|
| Attribution | `store_id`, `shift_id`, `cashier_user_id`, `device_id` |
| Exchange-rate context | `exchange_rate_id`, `exchange_rate_lbp_per_usd` |
| Costing | `cogs_method` |
| Notes | `notes` — part of the persisted transaction contract, so a replay may not rewrite it |
| Header money | `subtotal_excl_vat_cents`, `vat_total_cents`, `total_incl_vat_cents`, `discount_cents` |
| Per line | `product_id`, `uom_code`, `quantity_in_uom` |
| Per line — price | `unit_price_excl_vat_cents`, `unit_price_incl_vat_cents` |
| Per line — VAT | `vat_rate_id`, `vat_rate_bps`, `line_vat_cents`, `line_subtotal_excl_vat_cents`, `line_total_incl_vat_cents` |
| Per line — discount | `line_discount_cents`, so moving a discount between lines is a conflict even when the header is unchanged |
| Per tender row | `method`, `currency`, `amount_native_usd_cents`, `amount_native_lbp`, `amount_usd_cents_equivalent`, `reference` |

Lines and payments are **sorted before comparison**, so equality is multiset
equality: row order alone never makes an honest retry fail, and a repeated line
is not collapsed into one.

`sales.rs` › "Replay conflict detection" (12 tests) exercises this group by
group — swapping cash for card at the same USD value, changing a tender
currency or native amount, changing a payment reference, changing the exchange
rate, changing the COGS method, repricing lines while holding the total
constant, moving the discount between lines, changing a VAT code, and changing
shift or cashier attribution — and asserts each is refused **and** that the
posted sale, its receipt number and `quantity_on_hand` are untouched. Two more
assert the sorting rules: order alone is never a conflict, and repeated lines
compare as a multiset.

#### Fields deliberately excluded from replay equality

Comparing these would reject honest retries, so they are left out by design:

| Excluded | Why |
|---|---|
| `sale_item_id`, `payment_id` | Regenerated per request by `db/repos/sales.ts::post`. Request noise, not business content. |
| The client's `quantity_base` | Non-authoritative since GP-A02 — the backend derives the base quantity from `product_uoms`. `quantity_in_uom` + `uom_code` are compared instead, and the authoritative base follows from them. |
| The client's `is_service` | Non-authoritative since GP-A05 — `products.is_service` decides. A parked cart may legitimately carry a stale value. |
| `cogs_total_cents` and per-line COGS | Read from product cost at post time. A retry after an intervening purchase would legitimately recompute them. |
| `change_given_*` | Derived from tender minus amount due, so it is recomputed, not compared. |
| `receipt_number`, `posted_at` | Assigned by the first post. The replay's job is to *return* them, not to match them. |

#### Clear / Close while a post is in flight

An **unresolved** posting attempt prevents the affected cart from being cleared
or closed, and its checkout identity must survive until the attempt definitively
settles. This is the rule that makes a lost response safe: if the backend
committed but the answer never arrived, the cart must still hold the identity
that names that sale, so the retry reconciles to it instead of ringing the same
basket up again under a fresh identity.

`lib/checkout.ts::createCheckoutRegistry` implements it:

- `beginAttempt(cartId)` takes the cart's identity (minting one if needed) and
  marks the attempt unresolved.
- `settleAttempt(cartId)` marks it resolved — success *or* failure. It is
  idempotent, so `PosRegister`'s `finally` can call it unconditionally and no
  path leaves a cart wedged as "posting".
- `retire(cartId)` **refuses** while an attempt is unresolved, returning `false`
  and changing nothing. Clear and Close are also disabled in the UI for a
  posting cart, but the rule lives in the registry so no future caller can
  retire an identity an in-flight post may still need.

On settlement:

- **Success** retires the identity — that checkout is finished, so the next
  basket in that cart is a new transaction.
- **Failure** preserves it for retry — the next Post press is the *same*
  checkout, which is exactly what makes a retry after a fixed error, or after a
  lost answer, safe.

Other carts stay fully usable while one is posting.

`checkout.test.ts` › "cart controls during an unresolved post" (12 tests) covers
this: clear and close are blocked with the identity intact, direct `retire` is
refused, the identity is unchanged for the whole unresolved window, success
retires it, failure keeps it available, clear and close work normally once
settled, other carts are unaffected, `settleAttempt` is idempotent, and the
lost-response scenario runs end to end.

#### Frontend submission safety

`lib/checkout.ts::createSubmissionGate` (`checkout.test.ts` holds 23 tests in
total, across the gate, the registry and the cart controls) is a second,
**non-authoritative** layer: a synchronous gate so a double-click, rapid F5, or
a click and an F5 in the same frame cannot launch two independent attempts
before React rerenders. `submitting` is React state and is invisible to a
second handler in the same tick, so it cannot do this job. The gate is a
convenience — it lives in one renderer process and cannot see a retry that
arrives after a reload or from another window — and the backend remains the
authority.

#### Remaining limitation — true concurrency

Two *genuinely simultaneous* backend posts of the same identity, where both
transactions read "no such sale" before either inserts, **cannot both commit**:

- Duplicate financial and inventory effects are prevented. The `sales.id`
  primary key makes a second sale row impossible.
- The losing transaction rolls back **in full**, including its receipt-number
  advancement: `next_receipt_number` increments the `app_settings` counter
  inside the same transaction, so a rolled-back loser leaves the sequence where
  it was.
- But the loser may receive an **error** rather than automatically reconciling
  to the winner's result, which is what a sequential replay would get.

That last point is a **UX gap, not a correctness gap**, and remains a later
hardening item. The register's submission gate makes the interleaving
unreachable from a single window, and the suite cannot reach it either: layer C
uses `max_connections(1)` by design (see *Remaining gaps*).

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
  multi-cart behaviour are untested. The pure pieces have been extracted and
  are covered: the discount helpers (WP-01) and the checkout submission gate
  and identity registry (WP-02, `lib/checkout.ts`). Nothing tests that the page
  *wires* them correctly — that a second click really reaches the gate, that the
  identity really reaches the payload, or that the Clear and Close buttons are
  really disabled while a cart is posting. The registry refuses to retire an
  in-flight identity regardless, so the invariant holds even if the UI guard is
  wired wrongly; only the disabled-button affordance is unverified.
- **No end-to-end Tauri test.** Nothing exercises the real IPC boundary, the
  plugin's connection pool, or `App.tsx`'s three-stage boot.
- **Concurrency is covered at the shift and AP boundaries only.** Most of the
  suite uses `max_connections(1)`. Since WP-04, `shifts.rs` opens a second real
  pool via `TempDb::rival_pool()` and races two opens, two closes, and a sale
  against a close; since WP-05, `supplier_ap.rs` races two entries of one
  supplier invoice and `supplier_payments.rs` races two payments against one
  balance. Everything else still cannot detect races between simultaneous
  posts. For checkout idempotency this leaves
  one case unproven: two *genuinely concurrent* posts of the same identity,
  where both transactions read "no such sale" before either inserts. Both
  cannot commit — the `sales.id` primary key makes a duplicate sale impossible,
  so duplicate financial and inventory effects are prevented and the loser
  rolls back in full, including its receipt-number advancement. The loser may
  however surface an error instead of automatically reconciling to the winner's
  result. That is a UX gap rather than a correctness one, it remains a later
  hardening item, and the register's submission gate makes the interleaving
  unreachable from a single window. See *GP-A01 — Remaining limitation* above.
- **Timezone handling in reports** is pinned to UTC rather than tested. The
  `localtime` grouping in `reports.ts` is a latent correctness issue.
- **Repositories other than reports/shifts** — products, barcodes, suppliers,
  purchases read-side, movements — have no query coverage.
- **Accounting tables** (`accounts`, `journal_entries`, `journal_lines`) are
  created by migration 001 but nothing posts to them, so nothing is asserted.
- **Migration 008's backfill multiplication is not range-guarded.** It computes
  `old_cents * 1000000` in SQLite, which would leave INTEGER range only above
  roughly **$92.23 billion** in a single legacy unit-cost field; SQLite would
  promote the result to REAL rather than error. Classified non-blocking by the
  WP-03 release-gate review — it is unreachable with any realistic production
  data — and recorded here as a later defensive-hardening item. The *runtime*
  path is already guarded: `cost::cents_to_microcents` and every other helper in
  `crate::cost` use checked i128 arithmetic and error rather than wrap.
- **`post_adjustment` does not resolve its UoM against `product_uoms`.** It takes
  `quantity_base_signed` and the factor snapshot from the payload, the way
  `post_purchase` used to. Adjustments are a manager-entered correction rather
  than a document from outside the system, and WP-03's scope was explicitly
  limited to the purchase boundary, so this was left alone. The cost it snapshots
  *is* authoritative (read from `products`, at microcent precision).
- **The legacy `*_cents` cost mirrors.** Since WP-03 every cost column has a
  microcent sibling that is the accounting value, and the posting commands keep
  the cents column as `round(rate)` beside it. Tests assert the mirror is
  maintained, but nothing *prevents* a future query from costing off the mirror
  and silently reintroducing GP-A03. The mirrors are documented at every
  declaration; retiring them is a later package's call.
- **Supplier payments have no tender model.** A `supplier_ledger` payment row is
  an amount and a free-text reference: no method, no currency, no shift. So the
  shop cannot record that a supplier was paid in lira out of the till, and
  `close_shift` cannot attribute such a payment to a drawer. WP-05 examined this
  and deliberately did not guess — see *What WP-05 deliberately left alone*. The
  work is a product decision plus a schema change (method, currency,
  `shift_id`), a UI, and the drawer term in `drawer_cash_for_shift`.
- **No AP aging, and no invoice-level allocation.** Payment is against the
  supplier's open balance. Nothing records which invoice a payment settled, so
  nothing can report "what is 30 days overdue". Adequate and intentional for a
  single-store pilot; it is the thing to revisit if the shop starts carrying
  many open invoices per supplier.
- **Nothing reverses a payable.** `purchases.status` allows `'voided'` and the
  schema permits posted → voided, but no command performs it, so a purchase
  entered in error can only be offset by a supplier `adjustment` — which records
  the right balance but not the right story. The duplicate-invoice rule is
  already scoped to posted purchases, so a void would correctly release its
  reference for re-entry.
- **The forms' identity reuse is not unit-tested.** `post_purchase` and
  `post_supplier_payment` are idempotent on an identity the caller supplies, and
  `Purchases.tsx` / `SupplierDetail.tsx` hold that identity in a `useRef` for the
  life of the form so a retry reuses it. The backend half is covered thoroughly;
  that the *page* mints the id once and not per attempt is unverified, for the
  same reason the rest of the UI is — there is no component-test harness. A
  regression there would reintroduce duplicate purchases only for retries that
  the duplicate-invoice rule does not independently catch, i.e. bills with no
  reference.
- **The purchase pricing mode is not persisted.** `post_purchase` resolves it,
  derives the cost pair with it and then writes only the pair — there is no
  `purchase_items.vat_pricing_mode` column. Nothing is lost economically (the
  pair IS the price, and a posted line's two figures reconcile under its own
  snapshotted rate), and the canonical replay comparison already compares both
  unit costs, so repricing the authoritative side conflicts. The one thing it
  means is that a retry which restates the same pair under the other mode
  reconciles as the same bill rather than conflicting — which is correct, since
  it is the same money and the replay writes nothing. Adding the column would be
  a migration for an audit nicety, not for an invariant.
- **Non-ASCII invoice references fold case only on the ASCII part.** The
  duplicate rule compares `UPPER()`-folded text, and SQLite's `UPPER` is
  ASCII-only. "café-1" and "CAFÉ-1" are therefore treated as different invoice
  references. Both sides of every comparison go through the same expression so
  nothing is inconsistent, and Arabic — the other script a Lebanese supplier
  invoice is numbered in — is caseless, so this is a theoretical gap rather than
  a practical one.
- **`sync_queue`** is scaffolding; untested by design.
