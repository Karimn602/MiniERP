-- ===========================================================================
-- GREAZ DEMONSTRATION MENU - DISPOSABLE DATABASES ONLY
-- ---------------------------------------------------------------------------
-- GENERATED FILE. Do not edit by hand.
--   source:    design-references/greaz-theme-references/greaz_menu_design_fixture.json
--   generator: lira-pos/dev/generate_greaz_menu_seed.py
--
-- This is a VISUAL AND WORKFLOW demonstration catalogue, not an import file.
-- Read the generator's header before using it. In short:
--
--   * ZERO COST on every product. The fixture specifies no cost, so every
--     COGS, margin and profit figure derived from this catalogue is
--     MEANINGLESS. Zero cost is the absence of costing, not evidence of it.
--     Nothing here demonstrates ingredient or recipe costing.
--
--   * ZERO STOCK on every product. Everything reads as out of stock until
--     real opening stock is received through a purchase or an adjustment.
--     Inventing an opening quantity would be inventing an asset.
--
--   * NOTHING IS A SERVICE. The fixture does not classify items, so every
--     product is a TRACKED INVENTORY product (is_service = 0). A real
--     service line - a delivery charge, say - must be classified by the
--     operator. Mis-marking food as a service would let it sell below zero
--     with no stock record at all.
--
--   * VAT TREATMENT IS AN ASSUMPTION. The fixture records printed menu
--     prices and says the VAT treatment is to be confirmed. These rows
--     treat the printed price as VAT-INCLUSIVE at the store standard rate.
--     Confirm before drawing any tax conclusion from this data.
--
--   * Combo upgrade and Smash Burger single are ABSENT. One is a modifier,
--     the other had no unambiguous price on the menu. Inventing a price is
--     not on the table; see specials_to_model_later in the fixture.
-- ===========================================================================

-- NO GUARD LIVES IN THIS FILE, and that is deliberate.
--
-- SQLite RAISE() is only legal inside a trigger, so a plain script cannot
-- refuse to run. Rather than fake one with a CHECK-violating temp table and
-- an unreadable error, the safety lives in dev/apply_greaz_menu_seed.py --
-- which can refuse by DATABASE PATH as well as by content, and can say why.
-- Applying this file by hand bypasses those checks. Do not.
--
-- The store and the standard VAT rate are resolved from the target database,
-- so the seed is portable to any disposable one. Both must already exist.

BEGIN;

-- GZ-BUR-DOUBLE  Burgers / Double Burger  $6.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-BUR-DOUBLE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-BUR-DOUBLE', 'Double Burger', '2 patties',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    600 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 600,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'burgers', '🍔'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-BUR-DOUBLE-UOM', 'GZ-BUR-DOUBLE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-BUR-TRIPLE  Burgers / Triple Burger  $8.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-BUR-TRIPLE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-BUR-TRIPLE', 'Triple Burger', '3 patties',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    800 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 800,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'burgers', '🍔'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-BUR-TRIPLE-UOM', 'GZ-BUR-TRIPLE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-BUR-CHICKEN  Burgers / Chicken Burger  $6.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-BUR-CHICKEN', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-BUR-CHICKEN', 'Chicken Burger', 'BBQ or buffalo sauce',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    600 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 600,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'burgers', '🍔'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-BUR-CHICKEN-UOM', 'GZ-BUR-CHICKEN', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-WRP-BONELESS  Wraps / Boneless Wrap  $6.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-WRP-BONELESS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-WRP-BONELESS', 'Boneless Wrap', 'As shown on printed menu',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    600 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 600,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'wraps', '🌯'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-WRP-BONELESS-UOM', 'GZ-WRP-BONELESS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-FRIES  Sides / Fries  $3.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-FRIES', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-FRIES', 'Fries', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    300 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 300,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🍟'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-FRIES-UOM', 'GZ-SID-FRIES', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-CHILI  Sides / Chili Fries  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-CHILI', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-CHILI', 'Chili Fries', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🍟'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-CHILI-UOM', 'GZ-SID-CHILI', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-LOADED  Sides / Loaded Fries  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-LOADED', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-LOADED', 'Loaded Fries', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🍟'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-LOADED-UOM', 'GZ-SID-LOADED', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-ONION  Sides / Onion Rings (7 pcs)  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-ONION', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-ONION', 'Onion Rings (7 pcs)', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🧅'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-ONION-UOM', 'GZ-SID-ONION', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-CHEESE  Sides / Cheese Balls (6 pcs)  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-CHEESE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-CHEESE', 'Cheese Balls (6 pcs)', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🧀'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-CHEESE-UOM', 'GZ-SID-CHEESE', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-WINGS  Sides / Wings (7 pcs)  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-WINGS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-WINGS', 'Wings (7 pcs)', 'BBQ / honey mustard / buffalo options; no modifier logic in this fixture',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🍗'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-WINGS-UOM', 'GZ-SID-WINGS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-SID-TENDERS  Sides / Chicken Tenders (4 pcs)  $5.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-SID-TENDERS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-SID-TENDERS', 'Chicken Tenders (4 pcs)', 'BBQ / honey mustard / buffalo options; no modifier logic in this fixture',
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    500 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 500,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'sides', '🍗'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-SID-TENDERS-UOM', 'GZ-SID-TENDERS', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-ADD-BACON  Add-ons / Beef Bacon  $2.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-ADD-BACON', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-ADD-BACON', 'Beef Bacon', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    200 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 200,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'addons', '🥓'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-ADD-BACON-UOM', 'GZ-ADD-BACON', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-ADD-MOZZ  Add-ons / Mozzarella Patty  $2.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-ADD-MOZZ', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-ADD-MOZZ', 'Mozzarella Patty', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    200 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 200,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'addons', '🧀'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-ADD-MOZZ-UOM', 'GZ-ADD-MOZZ', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-ADD-ONION  Add-ons / Onion Rings Add-on  $2.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-ADD-ONION', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-ADD-ONION', 'Onion Rings Add-on', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    200 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 200,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'addons', '🧅'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-ADD-ONION-UOM', 'GZ-ADD-ONION', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-ADD-CHEDDAR  Add-ons / Red Cheddar Slice  $1.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-ADD-CHEDDAR', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-ADD-CHEDDAR', 'Red Cheddar Slice', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    100 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 100,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'addons', '🧀'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-ADD-CHEDDAR-UOM', 'GZ-ADD-CHEDDAR', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-DRK-SOFT  Drinks / Soft Drink  $1.00 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-DRK-SOFT', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-DRK-SOFT', 'Soft Drink', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    100 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 100,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'drinks', '🥤'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-DRK-SOFT-UOM', 'GZ-DRK-SOFT', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

-- GZ-DRK-WATER  Drinks / Water  $0.50 incl-VAT (assumed)
INSERT INTO products (
  id, store_id, sku, name, description,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
  avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
  quantity_on_hand, reorder_point,
  is_active, is_service, category, icon
) VALUES (
  'GZ-DRK-WATER', (SELECT id FROM stores ORDER BY id LIMIT 1), 'GZ-DRK-WATER', 'Water', NULL,
  (SELECT id FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1), 'inclusive',
  CAST(ROUND(
    50 * 10000.0 / (10000 + (SELECT rate_bps FROM vat_rates WHERE is_exempt = 0 ORDER BY effective_from DESC, id LIMIT 1))
  ) AS INTEGER), 50,
  0, 0,          -- cost: NONE SUPPLIED. See the header.
  0, 0,
  0, NULL,       -- stock: NONE SUPPLIED. See the header.
  1, 0,          -- active; is_service = 0 for every row, deliberately
  'drinks', '💧'
);

INSERT INTO product_uoms (
  id, product_id, store_id, uom_code, factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  'GZ-DRK-WATER-UOM', 'GZ-DRK-WATER', (SELECT id FROM stores ORDER BY id LIMIT 1), 'each', 1, 1,
  1, 1, 1, 1
);

COMMIT;

-- 17 products, each with one 'each' UoM that is both base and default sale.