/**
 * Recipe editor (WP-B2-A).
 *
 * A PROPERTY OF A PRODUCT, so it opens from the Products row rather than from
 * a nav item of its own: the sidebar is unchanged and the 1366x768 vertical
 * budget is not spent on a sixth destination. It renders as an overlay panel
 * because the Products page already uses its right column for the product
 * form, and a recipe is a bigger thing than a field.
 *
 * WHAT IT IS AND IS NOT
 *
 * It computes a LIVE PREVIEW through `lib/recipeCost.ts`, which mirrors
 * `src-tauri/src/recipe_cost.rs`. The preview is not an authority and nothing
 * is decided by it: Save and Activate both go to Rust, which re-resolves every
 * ingredient inside its own transaction, and migration 021's triggers bind any
 * other writer. The figures shown after a save are the ones the command
 * returned, not the ones this file computed.
 *
 * LAYOUT
 *
 * Built for 1366x768 at 125% Windows scaling, which is a 1093x614 CSS
 * viewport: the panel caps at `max-h-[88vh]` with its own scroll region, the
 * ingredient rows are a grid that collapses to one column under `md`, and the
 * cost summary is sticky at the foot so the number the owner is working
 * towards never scrolls away. Every colour is a semantic token, so Classic and
 * Midnight both work without a second code path, and every string goes through
 * `t()` so Arabic reads right-to-left with the rest of the application.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { useTranslation } from "../lib/i18n";
import { formatUsd } from "../lib/money";
import { formatUnitCostUsd, microcentsToCents } from "../lib/cost";
import {
  formatQuantity,
  parseQuantity,
  QuantityParseError,
  type Quantity,
} from "../lib/recipeQuantity";
import { recipeCost, type RecipeCostComponent } from "../lib/recipeCost";
import {
  recipesRepo,
  type RecipeRow,
  type RecipeStatus,
} from "../db/repos/recipes";

/** One row being edited. The quantity is held as TYPED TEXT until it parses. */
interface DraftLine {
  key: string;
  componentProductId: string;
  quantityInput: string;
  uomCode: string;
  wastePercentInput: string;
}

type Ingredient = Awaited<ReturnType<typeof recipesRepo.eligibleIngredients>>[number];

interface Props {
  storeId: string;
  productId: string;
  productName: string;
  /** The product's base unit code, which is what a batch yield is counted in. */
  baseUomCode: string;
  onClose: () => void;
  /** Called after any write, so the Products list can refresh its badges. */
  onChanged: () => void;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `line-${keySeq}`;
}

function wasteBpsFrom(input: string): number | null {
  const text = input.trim();
  if (text === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const bps = Math.round(Number(text) * 100);
  return bps >= 0 && bps < 10_000 ? bps : null;
}

function statusTone(status: RecipeStatus): "good" | "warn" | "neutral" {
  if (status === "active") return "good";
  if (status === "draft") return "warn";
  return "neutral";
}

export function RecipeEditor({
  storeId,
  productId,
  productName,
  baseUomCode,
  onClose,
  onChanged,
}: Props) {
  const { t } = useTranslation();

  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [versions, setVersions] = useState<RecipeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [recipeId, setRecipeId] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [yieldInput, setYieldInput] = useState("1");
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [picks, rows] = await Promise.all([
        recipesRepo.eligibleIngredients({ storeId, excludeProductId: productId }),
        recipesRepo.listForProduct({ storeId, productId }),
      ]);
      setIngredients(picks);
      setVersions(rows);

      // Editing resumes the existing DRAFT if there is one; otherwise it
      // starts a new version seeded from the ACTIVE one, which is what "edit
      // the recipe" means when a published version cannot be touched.
      const draft = rows.find((r) => r.status === "draft");
      const active = rows.find((r) => r.status === "active");
      const seed = draft ?? active ?? null;
      setRecipeId(draft ? draft.id : recipesRepo.newRecipeId());
      setYieldInput(String(seed?.yieldQuantityBase ?? 1));
      setNotes(seed?.notes ?? "");
      setLines(
        (seed?.components ?? []).map((c) => ({
          key: nextKey(),
          componentProductId: c.componentProductId,
          quantityInput: formatQuantity(c.quantity),
          uomCode: c.uomCode,
          wastePercentInput: c.wasteBps === 0 ? "" : String(c.wasteBps / 100),
        })),
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [productId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(
    () => new Map(ingredients.map((i) => [i.productId, i])),
    [ingredients],
  );

  const draftVersion = versions.find((r) => r.status === "draft");
  const activeVersion = versions.find((r) => r.status === "active");

  // -------------------------------------------------------------------------
  // Live preview. A VERDICT, never a figure with a fallback.
  // -------------------------------------------------------------------------
  const preview = useMemo(() => {
    const parsed: RecipeCostComponent[] = [];
    const problems: string[] = [];

    for (const line of lines) {
      const ing = byId.get(line.componentProductId);
      if (!ing) {
        problems.push(t("recipes.errPickIngredient"));
        continue;
      }
      const uom = ing.uoms.find((u) => u.uomCode === line.uomCode);
      if (!uom) {
        problems.push(t("recipes.errPickUnit", { name: ing.name }));
        continue;
      }
      let quantity: Quantity;
      try {
        quantity = parseQuantity(line.quantityInput);
      } catch (e) {
        problems.push(
          e instanceof QuantityParseError ? e.message : t("recipes.errQuantity"),
        );
        continue;
      }
      const wasteBps = wasteBpsFrom(line.wastePercentInput);
      if (wasteBps === null) {
        problems.push(t("recipes.errWaste", { name: ing.name }));
        continue;
      }
      parsed.push({
        componentProductId: ing.productId,
        componentName: ing.name,
        quantity,
        uomCode: uom.uomCode,
        factorNum: uom.factorNum,
        factorDen: uom.factorDen,
        wasteBps,
        unitCostExclVatMicrocents: ing.unitCostExclVatMicrocents,
        costSource: ing.costSource,
      });
    }

    const yieldBase = /^\d+$/.test(yieldInput.trim()) ? Number(yieldInput.trim()) : NaN;
    if (!Number.isInteger(yieldBase) || yieldBase < 1) {
      problems.push(t("recipes.errYield"));
    }

    if (problems.length > 0 || parsed.length === 0) {
      return { problems, outcome: null, parsed };
    }
    return { problems, outcome: recipeCost(parsed, yieldBase), parsed };
  }, [byId, lines, t, yieldInput]);

  /** Which ingredients, by name, have no cost basis at all. */
  const uncosted = useMemo(
    () =>
      preview.parsed
        .filter((c) => c.unitCostExclVatMicrocents === null)
        .map((c) => c.componentName),
    [preview.parsed],
  );

  const editingPublished = Boolean(activeVersion) && !draftVersion && lines.length > 0;
  const canSave = !busy && preview.problems.length === 0 && lines.length > 0;
  const canActivate =
    canSave &&
    Boolean(draftVersion) &&
    uncosted.length === 0 &&
    preview.outcome?.kind === "costed";

  // -------------------------------------------------------------------------
  // Writes. Every one of them goes to Rust.
  // -------------------------------------------------------------------------
  async function save(): Promise<string | null> {
    setActionError(null);
    setSavedNote(null);
    setBusy(true);
    try {
      const yieldBase = Number(yieldInput.trim());
      const result = await recipesRepo.saveDraft({
        storeId,
        productId,
        recipeId,
        yieldQuantityBase: yieldBase,
        notes: notes.trim() || null,
        components: preview.parsed.map((c) => ({
          componentProductId: c.componentProductId,
          quantity: c.quantity,
          uomCode: c.uomCode,
          wasteBps: c.wasteBps,
        })),
      });
      setSavedNote(
        result.uncostedComponents.length > 0
          ? t("recipes.savedIncomplete", {
              version: String(result.version),
              names: result.uncostedComponents.join(", "),
            })
          : t("recipes.savedComplete", {
              version: String(result.version),
              cost: formatUnitCostUsd(result.perBaseUnitMicrocents ?? 0),
            }),
      );
      await load();
      onChanged();
      return result.recipeId;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndActivate() {
    const id = await save();
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await recipesRepo.activate({ storeId, recipeId: id });
      setSavedNote(
        t("recipes.activated", {
          version: String(result.version),
          cost: formatUnitCostUsd(result.perBaseUnitMicrocents),
        }),
      );
      await load();
      onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function retire(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await recipesRepo.retire({ storeId, recipeId: id });
      setSavedNote(t("recipes.retired"));
      await load();
      onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const costed = preview.outcome?.kind === "costed" ? preview.outcome.cost : null;
  const refusal = preview.outcome?.kind === "refused" ? preview.outcome.reason : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("recipes.title", { name: productName })}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
        {/* Head */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-fg-muted">
              {t("recipes.eyebrow")}
            </div>
            <h2 className="truncate text-lg font-extrabold text-fg">
              {t("recipes.title", { name: productName })}
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">{t("recipes.subtitle")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-sm text-fg-muted">{t("recipes.loading")}</p>
          ) : loadError ? (
            <p className="rounded border border-danger-line bg-danger-bg p-2 text-sm text-danger-fg">
              {loadError}
            </p>
          ) : (
            <div className="space-y-4">
              {/* B2-A boundary, said once and plainly. */}
              <p className="rounded border border-line bg-paper p-2 text-xs text-fg-muted">
                {t("recipes.notYetSellingCost")}
              </p>

              {editingPublished && (
                <p className="rounded border border-warn-line bg-warn-bg p-2 text-xs text-warn-fg">
                  {t("recipes.editingCreatesNewVersion", {
                    version: String((activeVersion?.version ?? 0) + 1),
                  })}
                </p>
              )}

              {/* ---- Ingredients ---- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-extrabold text-fg">
                    {t("recipes.ingredients")}
                  </h3>
                  <Button
                    size="sm"
                    disabled={busy || ingredients.length === 0}
                    onClick={() =>
                      setLines((ls) => [
                        ...ls,
                        {
                          key: nextKey(),
                          componentProductId: ingredients[0]?.productId ?? "",
                          quantityInput: "",
                          uomCode: ingredients[0]?.uoms[0]?.uomCode ?? "",
                          wastePercentInput: "",
                        },
                      ])
                    }
                  >
                    {t("recipes.addIngredient")}
                  </Button>
                </div>

                {ingredients.length === 0 && (
                  <p className="rounded border border-line bg-paper p-2 text-xs text-fg-muted">
                    {t("recipes.noEligibleIngredients")}
                  </p>
                )}

                {lines.length === 0 ? (
                  <p className="rounded border border-line bg-paper p-3 text-xs text-fg-muted">
                    {t("recipes.emptyLines")}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {lines.map((line, index) => {
                      const ing = byId.get(line.componentProductId);
                      const contribution = costed?.contributions[
                        preview.parsed.findIndex(
                          (c) => c.componentProductId === line.componentProductId,
                        )
                      ];
                      const missingCost =
                        ing !== undefined && ing.unitCostExclVatMicrocents === null;
                      return (
                        <li
                          key={line.key}
                          className="rounded-md border border-line bg-paper p-2"
                        >
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
                            <div className="md:col-span-5">
                              <label className="block text-[11px] font-extrabold text-fg">
                                {t("recipes.colIngredient")}
                              </label>
                              <select
                                className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
                                value={line.componentProductId}
                                onChange={(e) => {
                                  const pick = byId.get(e.target.value);
                                  setLines((ls) =>
                                    ls.map((l, i) =>
                                      i === index
                                        ? {
                                            ...l,
                                            componentProductId: e.target.value,
                                            uomCode: pick?.uoms[0]?.uomCode ?? "",
                                          }
                                        : l,
                                    ),
                                  );
                                }}
                              >
                                {ingredients.map((i) => (
                                  <option key={i.productId} value={i.productId}>
                                    {i.name}
                                    {i.sku ? ` (${i.sku})` : ""}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="md:col-span-2">
                              <Input
                                label={t("recipes.colQuantity")}
                                inputMode="decimal"
                                placeholder="150"
                                value={line.quantityInput}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l, i) =>
                                      i === index
                                        ? { ...l, quantityInput: e.target.value }
                                        : l,
                                    ),
                                  )
                                }
                              />
                            </div>

                            <div className="md:col-span-2">
                              <label className="block text-[11px] font-extrabold text-fg">
                                {t("recipes.colUnit")}
                              </label>
                              <select
                                className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
                                value={line.uomCode}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l, i) =>
                                      i === index ? { ...l, uomCode: e.target.value } : l,
                                    ),
                                  )
                                }
                              >
                                {(ing?.uoms ?? []).map((u) => (
                                  <option key={u.uomCode} value={u.uomCode}>
                                    {u.uomCode}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="md:col-span-2">
                              <Input
                                label={t("recipes.colWaste")}
                                inputMode="decimal"
                                placeholder="0"
                                suffix="%"
                                value={line.wastePercentInput}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l, i) =>
                                      i === index
                                        ? { ...l, wastePercentInput: e.target.value }
                                        : l,
                                    ),
                                  )
                                }
                              />
                            </div>

                            <div className="flex items-end justify-end md:col-span-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setLines((ls) => ls.filter((_, i) => i !== index))
                                }
                                aria-label={t("recipes.removeIngredient")}
                              >
                                &times;
                              </Button>
                            </div>
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                            <span className="text-fg-muted">
                              {t("recipes.unitCost")}{" "}
                              {ing && ing.unitCostExclVatMicrocents !== null
                                ? formatUnitCostUsd(ing.unitCostExclVatMicrocents)
                                : "—"}
                            </span>
                            {contribution && (
                              <span className="font-medium text-fg">
                                {t("recipes.lineCost")}{" "}
                                {formatUnitCostUsd(contribution.contributionMicrocents)}
                              </span>
                            )}
                            {missingCost && (
                              <span className="text-warn-fg">
                                {t("recipes.lineNoCost")}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* ---- Batch ---- */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Input
                  label={t("recipes.yieldLabel", { unit: baseUomCode })}
                  inputMode="numeric"
                  value={yieldInput}
                  onChange={(e) => setYieldInput(e.target.value)}
                  hint={t("recipes.yieldHint")}
                />
                <Input
                  label={t("recipes.notesLabel")}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              {/* ---- Versions ---- */}
              {versions.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-extrabold text-fg">
                    {t("recipes.versions")}
                  </h3>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {versions.map((v) => (
                      <li
                        key={v.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <span className="flex items-center gap-2">
                          <Badge tone={statusTone(v.status)}>
                            {t(`recipes.status.${v.status}`)}
                          </Badge>
                          <span className="font-medium text-fg">
                            {t("recipes.versionLabel", { version: String(v.version) })}
                          </span>
                          <span className="text-fg-muted">
                            {t("recipes.componentCount", {
                              count: String(v.components.length),
                            })}
                          </span>
                        </span>
                        <span className="flex items-center gap-3 text-fg-muted">
                          {v.activatedAt && (
                            <span>
                              {t("recipes.activatedAt", {
                                when: v.activatedAt.slice(0, 10),
                              })}
                            </span>
                          )}
                          {v.retiredAt && (
                            <span>
                              {t("recipes.retiredAt", { when: v.retiredAt.slice(0, 10) })}
                            </span>
                          )}
                          {/* Unavailable is the worse of the two and is said
                              in its own words: a drifted unit can be re-saved
                              against, a missing one cannot. */}
                          {v.components.some((c) => c.conversionState === "unavailable") ? (
                            <span className="text-warn-fg">
                              {t("recipes.conversionUnavailable")}
                            </span>
                          ) : (
                            v.components.some((c) => c.conversionState === "drifted") && (
                              <span className="text-warn-fg">
                                {t("recipes.conversionDrifted")}
                              </span>
                            )
                          )}
                          {v.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => void retire(v.id)}
                            >
                              {t("recipes.retire")}
                            </Button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Foot — sticky, because this is the figure the owner is working towards */}
        <div className="space-y-2 border-t border-line bg-paper px-5 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="text-sm">
              {costed ? (
                <>
                  <div className="text-[11px] font-extrabold uppercase tracking-wide text-fg-muted">
                    {t("recipes.costPerServing", { unit: baseUomCode })}
                  </div>
                  <div className="text-xl font-extrabold tabular-nums text-fg">
                    {formatUnitCostUsd(costed.perBaseUnitMicrocents)}
                  </div>
                  <div className="text-[11px] text-fg-muted">
                    {t("recipes.batchCost", {
                      cost: formatUsd(microcentsToCents(costed.batchMicrocents)),
                    })}
                  </div>
                </>
              ) : uncosted.length > 0 ? (
                <div className="text-warn-fg">
                  {t("recipes.cannotCost", { names: uncosted.join(", ") })}
                </div>
              ) : (
                <div className="text-fg-muted">{t("recipes.noCostYet")}</div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" disabled={!canSave} onClick={() => void save()}>
                {t("recipes.saveDraft")}
              </Button>
              <Button
                variant="primary"
                disabled={!canSave}
                onClick={() => void saveAndActivate()}
                title={
                  uncosted.length > 0 ? t("recipes.activateBlocked") : undefined
                }
              >
                {t("recipes.saveAndActivate")}
              </Button>
            </div>
          </div>

          {refusal && (
            <p className="rounded border border-danger-line bg-danger-bg p-2 text-xs text-danger-fg">
              {refusal}
            </p>
          )}
          {preview.problems.length > 0 && (
            <ul className="space-y-0.5 text-xs text-warn-fg">
              {[...new Set(preview.problems)].map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {actionError && (
            <p className="rounded border border-danger-line bg-danger-bg p-2 text-xs text-danger-fg">
              {actionError}
            </p>
          )}
          {savedNote && !actionError && (
            <p className={clsx("text-xs", canActivate ? "text-fg-muted" : "text-fg-muted")}>
              {savedNote}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
