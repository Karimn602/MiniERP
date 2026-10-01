# Greaz POS test harness (WP-01, extended by WP-02 and WP-03)

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
| **B. Rust units** | `src-tauri/src/tests/pure.rs`, `cost.rs` | The four commands' pure validators, `prepare_sale` totals, change routing, line/discount reconciliation, base-quantity derivation; the whole `crate::cost` abstraction — scale, rounding, weighted average, overflow | Authoritative for pre-DB posting logic |
| **C. Rust posting integration** | `src-tauri/src/tests/` | Migrations, `post_sale`, `post_purchase`, `post_adjustment`, `post_supplier_payment`, whole-ledger reconciliation, immutability triggers, the cost lifecycle (`cost_precision.rs`), purchase UoM authority (`purchase_authority.rs`) | **Authoritative for the database and all posting behaviour** |
| **C2. TypeScript SQL / read-model** | `tests/integration/` | Repository SQL for reports, shift summaries, drawer reconciliation, inventory valuation | Authoritative for read-model queries only |

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
- **Immutability** — posted sales, sale items, payments, purchases, purchase
  items, inventory movements and supplier-ledger entries reject UPDATE and
  DELETE; the one carve-out (posted → voided) still refuses to rewrite money.
- **Migrations** — every migration applies to a virgin database, re-running is a
  no-op, and two independent databases end up with identical schema and
  checksums. Since WP-03 the UPGRADE path is covered too: migration 008 applies
  to a populated pre-WP-03 database, backfills every existing cost exactly
  (`cents × 1,000,000`, a change of units and not a recomputation), restores the
  three append-only triggers its backfill has to lift, is idempotent through the
  real runner, and leaves an upgraded database on byte-identical schema to a
  fresh install.

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
- **No concurrency tests.** The suite uses `max_connections(1)`; it cannot
  detect races between simultaneous posts. For checkout idempotency this leaves
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
- **`sync_queue`** is scaffolding; untested by design.
