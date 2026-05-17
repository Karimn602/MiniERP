-- ============================================================================
-- Migration v7 — selectable sale costing method
-- ----------------------------------------------------------------------------
-- Stores which COGS calculation method was used when the sale was posted.
-- Existing sales default to weighted-average because that was the original
-- behavior before this migration.
-- ============================================================================

ALTER TABLE sales
  ADD COLUMN cogs_method TEXT NOT NULL DEFAULT 'weighted_average'
  CHECK (cogs_method IN ('weighted_average', 'last_purchase'));