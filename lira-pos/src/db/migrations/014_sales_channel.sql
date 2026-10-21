-- ============================================================================
-- Migration v14 — sales channel: counter vs online / delivery (WP-4)
-- ----------------------------------------------------------------------------
-- One column on `sales`, recording WHERE the order came from. Greaz takes
-- orders online and the owner needs to know how many and how much; the orders
-- themselves are rung up on the till like any other, through the same product
-- selection, the same VAT, the same posting path and the same inventory.
--
-- WHAT THIS IS NOT
--
-- It is NOT a payment method, and nothing here or downstream may treat it as
-- one. An online order does not settle itself: no cash row is invented for it,
-- no card is charged, no receivable is raised, and no platform account exists.
-- The tender a sale took is recorded in `sale_payments`, exactly as before, and
-- the drawer is reconciled from those rows and no others. A shop whose delivery
-- platform pays weekly, net of commission, needs a real AR/settlement design —
-- that is a separate business requirement and is deliberately absent here
-- rather than approximated.
--
-- It is also NOT a customer, an address, a courier or a fee. Those are the
-- platform-integration scope the founder explicitly deferred.
--
-- WHY `NOT NULL DEFAULT 'counter'` RATHER THAN NULLABLE
--
-- Every sale has a channel: it was either rung up at the counter or it was not.
-- A NULL would be a third state meaning "we do not know", and every report
-- would then have to decide what to do with it — which is how a reporting
-- column grows a silent bucket that reconciles to nothing.
--
-- Historical rows get 'counter', which is a factual claim and not a guess: the
-- register had no channel control before this migration, so every sale already
-- in the database WAS taken at the counter. The default also keeps the column
-- backwards-compatible for any writer that does not know about it yet.
--
-- The CHECK is deliberate here, unlike `products.category` in migration 013.
-- The two columns look similar and are not: a menu section is presentational
-- master data that a restaurant changes at will, whereas a channel is a
-- REPORTING DIMENSION whose values the reports enumerate. A typo'd channel
-- would silently drop a sale out of both the Counter and the Online figure
-- while still counting in the overall total, so the sum of the parts would stop
-- matching the whole with nothing to show why. Two values, fixed, enforced.
--
-- A new channel (a phone order, a drive-through) is therefore a migration, and
-- that is the right cost: it has to be added to the reports in the same change.

ALTER TABLE sales ADD COLUMN channel TEXT NOT NULL DEFAULT 'counter'
  CHECK (channel IN ('counter', 'online_delivery'));

-- Every channel report is "this store, these dates, grouped by channel", and
-- all of them filter `status = 'posted'`. Ordered to match that access path.
CREATE INDEX IF NOT EXISTS idx_sales_store_channel_posted
  ON sales (store_id, channel, posted_at);

-- ----------------------------------------------------------------------------
-- A posted sale's channel is part of the record (immutability)
-- ----------------------------------------------------------------------------
-- Migration 001 lets a posted sale become 'voided' provided a listed set of
-- columns is unchanged, and that list is a denylist worn as an allowlist: a
-- column added later is, by default, one the void statement may rewrite. So a
-- "void" could also re-attribute a sale from Counter to Online, moving revenue
-- between two figures the owner reads against each other, on a row that is
-- supposed to be immutable.
--
-- Rather than rewrite migration 001's trigger — which would mean restating its
-- whole column list and keeping two copies of it in step — this adds one
-- narrow guard for the one new column. `trg_sales_no_update_after_post` still
-- governs everything else.
CREATE TRIGGER IF NOT EXISTS trg_sales_channel_is_immutable_after_post
BEFORE UPDATE OF channel ON sales
FOR EACH ROW
WHEN OLD.posted_at IS NOT NULL AND NEW.channel IS NOT OLD.channel
BEGIN
  SELECT RAISE(
    ABORT,
    'A posted sale''s channel cannot be changed. Report the correction instead.'
  );
END;
