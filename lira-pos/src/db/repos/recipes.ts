/**
 * Recipe read models and command wrappers (WP-B2-A).
 *
 * READS are TypeScript, because a read has nothing to be atomic about. WRITES
 * are three `invoke` calls into `src-tauri/src/recipes.rs`, because saving a
 * recipe is a compound write and `tauri-plugin-sql` gives no usable
 * `BEGIN`/`COMMIT` across statements — the same reason `catalog.rs` exists.
 *
 * NOTHING HERE IS AN AUTHORITY. The editor's preview comes from
 * `lib/recipeCost.ts`, which mirrors the Rust; the figures a row actually
 * holds come back from the command that wrote them. Every rule about whether a
 * recipe may be saved or activated is decided in Rust, inside the transaction,
 * and most of them again by migration 021's triggers.
 */
import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type { Quantity } from "../../lib/recipeQuantity";
import type { ComponentCostSource } from "../../lib/recipeCost";
import type { Microcents } from "../../lib/cost";

export type RecipeStatus = "draft" | "active" | "retired";

/** How a component's frozen conversion relates to the catalogue today. */
export type ConversionState = "current" | "drifted" | "unavailable";

/**
 * Is this a value that arrived from the database with its integer precision
 * intact?
 *
 * A `number` decoded from SQLite is a double. Up to
 * `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991) every integer is
 * representable exactly; past it, two different stored integers can decode to
 * the same `number`, and `BigInt(thatNumber)` then produces a large, exact,
 * WRONG value. That is worse than refusing: it is a precise-looking answer to
 * a question the data can no longer be asked.
 *
 * Migration 021 bounds every conversion part at 10^6, so nothing inside the
 * envelope comes near this. It is checked anyway, because `product_uoms` has
 * no such bound — its only CHECK is `> 0` — and a factor written by an
 * importer or a future screen reaches this code through the same join.
 */
function isExactInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * Do two rational conversions describe the SAME factor?
 *
 * `1000/1` and `2000/2` are one conversion: a kilogram is a thousand grams
 * however the row spells it, and a recipe's physical quantity is unchanged by
 * a rewrite that cancels. So the test is EQUIVALENCE, not equality of the
 * stored parts.
 *
 * CROSS-MULTIPLIED IN BIGINT, never divided. A quotient comparison would make
 * `1/3` and `100000/300000` agree or disagree depending on the arithmetic
 * rather than on the data. `number` cross-multiplication was exact for
 * everything migration 021 admits — both products are at most 10^12 — but
 * `product_uoms` itself bounds a factor at nothing more than `> 0`, so a
 * factor from an importer or a future screen can produce a cross-product above
 * `Number.MAX_SAFE_INTEGER`, where the comparison silently stops being exact.
 * BigInt removes the ceiling, and `isExactInteger` removes the one thing
 * BigInt cannot fix: an input that had already lost precision before it got
 * here.
 *
 * Throws [`UnsafeConversionError`] on such an input rather than guessing.
 * `mapComponent` catches it and reports the component as `"unavailable"`,
 * which is the honest classification: the conversion cannot be compared, so
 * nothing can be said about whether it still holds.
 */
export class UnsafeConversionError extends Error {}

export function sameConversion(
  aNum: number,
  aDen: number,
  bNum: number,
  bDen: number,
): boolean {
  for (const value of [aNum, aDen, bNum, bDen]) {
    if (!isExactInteger(value)) {
      throw new UnsafeConversionError(
        `A unit conversion of ${aNum}/${aDen} or ${bNum}/${bDen} is outside the range JavaScript ` +
          `represents exactly, so it cannot be compared.`,
      );
    }
  }
  return BigInt(aNum) * BigInt(bDen) === BigInt(bNum) * BigInt(aDen);
}

/**
 * One ingredient line of a stored recipe.
 *
 * `factorNum`/`factorDen` are the recipe's OWN snapshot, not the ingredient's
 * current conversion. `catalogFactorNum`/`catalogFactorDen` are what the
 * catalogue says today, and `conversionState` says how the two relate —
 * readable rather than silent on purpose: a published recipe's physical
 * quantities are immune to a factor edit, so the only remaining problem is
 * that the two can differ, and a difference the owner can see is a decision
 * they can make.
 *
 * THREE STATES, NOT TWO. The first version of this reported a boolean, and a
 * MISSING unit row — the ingredient's unit deactivated or deleted since —
 * came back as `false`, i.e. healthy, because a `LEFT JOIN` miss leaves both
 * catalogue columns NULL and `NULL !== 1000` is not a disagreement the check
 * was looking for. A unit that no longer exists is the worse problem of the
 * two: the recipe cannot be re-saved against it at all.
 */
export interface RecipeComponentRow {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string | null;
  quantity: Quantity;
  uomCode: string;
  factorNum: number;
  factorDen: number;
  catalogFactorNum: number | null;
  catalogFactorDen: number | null;
  /**
   * `"current"`  — the catalogue still states this exact conversion.
   * `"drifted"`  — the unit exists and now means something else.
   * `"unavailable"` — the unit is gone or deactivated.
   */
  conversionState: ConversionState;
  /** True for `"drifted"` and `"unavailable"` alike: anything but healthy. */
  conversionDrifted: boolean;
  wasteBps: number;
  sortOrder: number;
  /** `null` means NO COST BASIS EXISTS. It is not zero. */
  unitCostExclVatMicrocents: Microcents | null;
  costSource: ComponentCostSource;
  componentIsActive: boolean;
}

export interface RecipeRow {
  id: string;
  storeId: string;
  productId: string;
  version: number;
  yieldQuantityBase: number;
  status: RecipeStatus;
  activatedAt: string | null;
  retiredAt: string | null;
  notes: string | null;
  createdAt: string;
  components: RecipeComponentRow[];
}

/**
 * What `Products` needs per row to decide what to show without a round trip.
 *
 * `activeVersion` is `null` whenever `hasActive` is false, which is the pair a
 * caller has to read TOGETHER: a product whose only recipes are retired has
 * history and no authoritative version, and showing it as active-with-a-blank
 * -version is how a badge comes to claim something the data does not say.
 */
export interface RecipeSummary {
  productId: string;
  hasDraft: boolean;
  hasActive: boolean;
  activeVersion: number | null;
  retiredCount: number;
}

interface HeaderSql {
  id: string;
  store_id: string;
  product_id: string;
  version: number;
  yield_quantity_base: number;
  status: RecipeStatus;
  activated_at: string | null;
  retired_at: string | null;
  notes: string | null;
  created_at: string;
}

interface ComponentSql {
  id: string;
  component_product_id: string;
  component_name: string;
  component_sku: string | null;
  component_is_active: number;
  quantity_num: number;
  quantity_den: number;
  uom_code: string;
  factor_num_snapshot: number;
  factor_den_snapshot: number;
  catalog_factor_num: number | null;
  catalog_factor_den: number | null;
  waste_bps: number;
  sort_order: number;
  costing_method: string;
  standard_cost_excl_vat_microcents: number | null;
  avg_cost_excl_vat_microcents: number;
  avg_cost_incl_vat_microcents: number;
  has_cost_document: number;
}

/**
 * Resolve an ingredient's rate the way `recipes.rs::resolve_ingredient` does.
 *
 * Kept in step with the Rust by shape rather than by hope: the three cases are
 * the same three, in the same order, and the zero-average case asks the same
 * question — is there a `purchase` or `opening` movement behind this zero —
 * which the SQL below answers as `has_cost_document`. It is the predicate
 * WP-B1's P1-A correction established, reused rather than re-decided.
 *
 * `null` means no basis exists. MISSING EVIDENCE IS NOT A LEGITIMATE ZERO.
 */
function resolveRate(r: ComponentSql): {
  rate: Microcents | null;
  source: ComponentCostSource;
} {
  if (r.costing_method === "standard") {
    return { rate: r.standard_cost_excl_vat_microcents ?? null, source: "standard" };
  }
  if (r.avg_cost_excl_vat_microcents !== 0 || r.avg_cost_incl_vat_microcents !== 0) {
    return { rate: r.avg_cost_excl_vat_microcents, source: "purchase_average" };
  }
  return {
    rate: r.has_cost_document ? 0 : null,
    source: "purchase_average",
  };
}

const COMPONENT_SQL = `
  SELECT rc.id,
         rc.component_product_id,
         p.name            AS component_name,
         p.sku             AS component_sku,
         p.is_active       AS component_is_active,
         rc.quantity_num,
         rc.quantity_den,
         rc.uom_code,
         rc.factor_num_snapshot,
         rc.factor_den_snapshot,
         u.factor_num      AS catalog_factor_num,
         u.factor_den      AS catalog_factor_den,
         rc.waste_bps,
         rc.sort_order,
         p.costing_method,
         p.standard_cost_excl_vat_microcents,
         p.avg_cost_excl_vat_microcents,
         p.avg_cost_incl_vat_microcents,
         EXISTS (
           SELECT 1 FROM inventory_movements m
            WHERE m.store_id = rc.store_id
              AND m.product_id = rc.component_product_id
              AND m.movement_type IN ('purchase', 'opening')
              AND m.unit_cost_excl_vat_microcents >= 0
         )                 AS has_cost_document
    FROM recipe_components rc
    JOIN products p ON p.id = rc.component_product_id
    LEFT JOIN product_uoms u
           ON u.product_id = rc.component_product_id
          AND u.store_id   = rc.store_id
          AND u.uom_code   = rc.uom_code
          AND u.is_active  = 1
   WHERE rc.recipe_id = ?
   ORDER BY rc.sort_order, rc.id`;

function compareConversion(r: ComponentSql): ConversionState {
  if (r.catalog_factor_num === null || r.catalog_factor_den === null) {
    return "unavailable";
  }
  try {
    return sameConversion(
      r.catalog_factor_num,
      r.catalog_factor_den,
      r.factor_num_snapshot,
      r.factor_den_snapshot,
    )
      ? "current"
      : "drifted";
  } catch (e) {
    if (e instanceof UnsafeConversionError) return "unavailable";
    throw e;
  }
}

function mapComponent(r: ComponentSql): RecipeComponentRow {
  const { rate, source } = resolveRate(r);
  // The join is on an ACTIVE unit row, so a NULL here means the unit is gone
  // or deactivated — unavailable, not healthy.
  //
  // A conversion that cannot be COMPARED is unavailable too: `sameConversion`
  // throws on a factor that reached JavaScript without its precision, and
  // reporting that as `"current"` would be a clean bill of health for a figure
  // nothing can vouch for. The published snapshot is untouched either way.
  const conversionState: ConversionState = compareConversion(r);
  return {
    id: r.id,
    componentProductId: r.component_product_id,
    componentName: r.component_name,
    componentSku: r.component_sku,
    quantity: { num: r.quantity_num, den: r.quantity_den },
    uomCode: r.uom_code,
    factorNum: r.factor_num_snapshot,
    factorDen: r.factor_den_snapshot,
    catalogFactorNum: r.catalog_factor_num,
    catalogFactorDen: r.catalog_factor_den,
    conversionState,
    conversionDrifted: conversionState !== "current",
    wasteBps: r.waste_bps,
    sortOrder: r.sort_order,
    unitCostExclVatMicrocents: rate,
    costSource: source,
    componentIsActive: r.component_is_active === 1,
  };
}

function mapHeader(h: HeaderSql, components: RecipeComponentRow[]): RecipeRow {
  return {
    id: h.id,
    storeId: h.store_id,
    productId: h.product_id,
    version: h.version,
    yieldQuantityBase: h.yield_quantity_base,
    status: h.status,
    activatedAt: h.activated_at,
    retiredAt: h.retired_at,
    notes: h.notes,
    createdAt: h.created_at,
    components,
  };
}

export const recipesRepo = {
  /** Mint a recipe identity. The caller mints it once and re-uses it. */
  newRecipeId(): string {
    return newId();
  },

  /** Every version of one product's recipe, newest version first. */
  async listForProduct(args: {
    storeId: string;
    productId: string;
  }): Promise<RecipeRow[]> {
    const headers = await query<HeaderSql>(
      `SELECT id, store_id, product_id, version, yield_quantity_base, status,
              activated_at, retired_at, notes, created_at
         FROM recipes
        WHERE store_id = ? AND product_id = ?
        ORDER BY version DESC`,
      [args.storeId, args.productId],
    );
    const out: RecipeRow[] = [];
    for (const h of headers) {
      const rows = await query<ComponentSql>(COMPONENT_SQL, [h.id]);
      out.push(mapHeader(h, rows.map(mapComponent)));
    }
    return out;
  },

  /** One version by id, or `null`. */
  async findById(args: { storeId: string; recipeId: string }): Promise<RecipeRow | null> {
    const headers = await query<HeaderSql>(
      `SELECT id, store_id, product_id, version, yield_quantity_base, status,
              activated_at, retired_at, notes, created_at
         FROM recipes WHERE id = ? AND store_id = ?`,
      [args.recipeId, args.storeId],
    );
    const h = headers[0];
    if (!h) return null;
    const rows = await query<ComponentSql>(COMPONENT_SQL, [h.id]);
    return mapHeader(h, rows.map(mapComponent));
  },

  /**
   * Which products have a draft, an active version, or retired history.
   *
   * One query for the whole catalogue, because the Products list renders every
   * row and a per-row probe is how a list comes to take a second to open.
   */
  async summaries(storeId: string): Promise<Map<string, RecipeSummary>> {
    const rows = await query<{
      product_id: string;
      has_draft: number;
      has_active: number;
      active_version: number | null;
      retired_count: number;
    }>(
      `SELECT product_id,
              MAX(status = 'draft')   AS has_draft,
              MAX(status = 'active')  AS has_active,
              MAX(CASE WHEN status = 'active' THEN version END) AS active_version,
              SUM(status = 'retired') AS retired_count
         FROM recipes
        WHERE store_id = ?
        GROUP BY product_id`,
      [storeId],
    );
    return new Map(
      rows.map((r) => [
        r.product_id,
        {
          productId: r.product_id,
          hasDraft: r.has_draft === 1,
          hasActive: r.has_active === 1,
          activeVersion: r.active_version,
          retiredCount: r.retired_count ?? 0,
        },
      ]),
    );
  },

  /**
   * Candidate ingredients: active products of this store that are not
   * recipe-costed and own no recipe of their own.
   *
   * The one-level rule, applied to the PICKER as well as to the engine, so the
   * owner is not offered something that would then be refused. The engine
   * refuses it anyway — a picker is a convenience, never a guard.
   */
  async eligibleIngredients(args: {
    storeId: string;
    excludeProductId: string;
  }): Promise<
    {
      productId: string;
      name: string;
      sku: string | null;
      uoms: { uomCode: string; factorNum: number; factorDen: number; isBase: boolean }[];
      unitCostExclVatMicrocents: Microcents | null;
      costSource: ComponentCostSource;
    }[]
  > {
    const rows = await query<{
      id: string;
      name: string;
      sku: string | null;
      costing_method: string;
      standard_cost_excl_vat_microcents: number | null;
      avg_cost_excl_vat_microcents: number;
      avg_cost_incl_vat_microcents: number;
      has_cost_document: number;
    }>(
      `SELECT p.id, p.name, p.sku, p.costing_method,
              p.standard_cost_excl_vat_microcents,
              p.avg_cost_excl_vat_microcents,
              p.avg_cost_incl_vat_microcents,
              EXISTS (
                SELECT 1 FROM inventory_movements m
                 WHERE m.store_id = p.store_id
                   AND m.product_id = p.id
                   AND m.movement_type IN ('purchase', 'opening')
                   AND m.unit_cost_excl_vat_microcents >= 0
              ) AS has_cost_document
         FROM products p
        WHERE p.store_id = ?
          AND p.is_active = 1
          AND p.id <> ?
          AND p.costing_method <> 'recipe'
          AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.product_id = p.id)
        ORDER BY p.name`,
      [args.storeId, args.excludeProductId],
    );

    const uomRows = await query<{
      product_id: string;
      uom_code: string;
      factor_num: number;
      factor_den: number;
      is_base: number;
    }>(
      `SELECT product_id, uom_code, factor_num, factor_den, is_base
         FROM product_uoms
        WHERE store_id = ? AND is_active = 1
        ORDER BY is_base DESC, uom_code`,
      [args.storeId],
    );
    const byProduct = new Map<string, typeof uomRows>();
    for (const u of uomRows) {
      const list = byProduct.get(u.product_id) ?? [];
      list.push(u);
      byProduct.set(u.product_id, list);
    }

    return rows.map((r) => {
      const { rate, source } = resolveRate({
        costing_method: r.costing_method,
        standard_cost_excl_vat_microcents: r.standard_cost_excl_vat_microcents,
        avg_cost_excl_vat_microcents: r.avg_cost_excl_vat_microcents,
        avg_cost_incl_vat_microcents: r.avg_cost_incl_vat_microcents,
        has_cost_document: r.has_cost_document,
      } as ComponentSql);
      return {
        productId: r.id,
        name: r.name,
        sku: r.sku,
        uoms: (byProduct.get(r.id) ?? []).map((u) => ({
          uomCode: u.uom_code,
          factorNum: u.factor_num,
          factorDen: u.factor_den,
          isBase: u.is_base === 1,
        })),
        unitCostExclVatMicrocents: rate,
        costSource: source,
      };
    });
  },

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async saveDraft(args: {
    storeId: string;
    productId: string;
    recipeId: string;
    yieldQuantityBase: number;
    notes: string | null;
    components: {
      componentProductId: string;
      quantity: Quantity;
      uomCode: string;
      wasteBps: number;
    }[];
  }): Promise<{
    recipeId: string;
    version: number;
    perBaseUnitMicrocents: number | null;
    batchMicrocents: number | null;
    uncostedComponents: string[];
  }> {
    return invoke("save_recipe_draft", {
      payload: {
        storeId: args.storeId,
        productId: args.productId,
        recipeId: args.recipeId,
        yieldQuantityBase: args.yieldQuantityBase,
        notes: args.notes,
        components: args.components.map((c) => ({
          componentProductId: c.componentProductId,
          quantityNum: c.quantity.num,
          quantityDen: c.quantity.den,
          uomCode: c.uomCode,
          wasteBps: c.wasteBps,
        })),
      },
    });
  },

  async activate(args: { storeId: string; recipeId: string }): Promise<{
    recipeId: string;
    version: number;
    activatedAt: string;
    retiredRecipeId: string | null;
    perBaseUnitMicrocents: number;
  }> {
    return invoke("activate_recipe", { payload: args });
  },

  async retire(args: { storeId: string; recipeId: string }): Promise<{
    recipeId: string;
    retiredAt: string;
  }> {
    return invoke("retire_recipe", { payload: args });
  },
};
