import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  applyOfficialMenu,
  previewOfficialMenu,
  type ApplyOfficialMenuResult,
  type OfficialMenuPreview,
  type OfficialMenuPreviewItem,
} from "../lib/officialMenu";
import { MENU_CATEGORIES } from "../lib/menuCategories";
import { formatUsd } from "../lib/money";
import { addVat, formatBps, vatFromGross } from "../lib/vat";
import { useTranslation } from "../lib/i18n";
import type { VatRate } from "../db/types";
import { Button } from "./ui/Button";

interface Props {
  storeId: string;
  vatRates: VatRate[];
  onClose: () => void;
  onApplied: () => void;
}

type Mode = "inclusive" | "exclusive";

/**
 * The owner's one-time load of Greaz's official menu.
 *
 * The backend decides everything again inside its own transaction; this screen
 * is a preview and three decisions the backend refuses to make on its own:
 *
 *   1. THE TAX TREATMENT. The printed menu does not say whether its prices
 *      include VAT, so the rate and the side are chosen here, with no default,
 *      and the owner ticks that they are confirmed. Apply stays disabled until
 *      all three are given — and `official_menu_apply` refuses without them.
 *   2. SAME-NAMED ITEMS already on the Register: kept by default; replaced
 *      only if ticked.
 *   3. OTHER REGISTER ITEMS not on the official menu (old samples): left alone
 *      by default; taken off the Register only if ticked. Nothing is deleted.
 */
export function OfficialMenuDialog({ storeId, vatRates, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<OfficialMenuPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vatRateId, setVatRateId] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [hide, setHide] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyOfficialMenuResult | null>(null);

  useEffect(() => {
    let live = true;
    previewOfficialMenu(storeId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [storeId]);

  const rate = vatRates.find((r) => r.id === vatRateId) ?? null;

  /** What the customer pays for one item under the treatment chosen so far. */
  function customerPays(printed: number): { pays: number; vat: number } | null {
    if (!rate || !mode) return null;
    if (mode === "inclusive") return { pays: printed, vat: vatFromGross(printed, rate.rateBps) };
    const gross = addVat(printed, rate.rateBps);
    return { pays: gross, vat: gross - printed };
  }

  const grouped = useMemo(() => {
    if (!preview) return [];
    return MENU_CATEGORIES.map((c) => ({
      category: c,
      items: preview.items.filter((i) => i.category === c.id),
    })).filter((g) => g.items.length > 0);
  }, [preview]);

  const nameMatches = preview?.items.filter((i) => i.outcome === "name_match") ?? [];
  /** Existing products that will leave the Register — `official_menu.rs` uses
   *  the same rule: a kept match whose every existing item is leaving is added. */
  const going = new Set<string>([
    ...nameMatches.filter((i) => replace.has(i.sku)).flatMap((i) => i.existing.map((e) => e.productId)),
    ...hide,
  ]);
  const willCreate = (i: OfficialMenuPreviewItem) =>
    i.outcome === "create" ||
    (i.outcome === "name_match" &&
      (replace.has(i.sku) || i.existing.every((e) => going.has(e.productId))));
  const toCreate = preview?.items.filter(willCreate).length ?? 0;
  const toKeep = (preview?.items.length ?? 0) - toCreate;
  const ready = !!rate && !!mode && confirmed && !applying;
  const example = preview?.items.find((i) => i.sku === "GRZ-BUR-001") ?? preview?.items[0];
  const examplePrice = example ? customerPays(example.priceUsdCents) : null;

  async function handleApply() {
    if (!ready || !mode) return;
    setApplying(true);
    setApplyError(null);
    try {
      const r = await applyOfficialMenu({
        storeId,
        vatRateId,
        vatPricingMode: mode,
        taxTreatmentConfirmed: confirmed,
        replaceNameMatches: nameMatches
          .filter((i) => replace.has(i.sku))
          .map((i) => ({ sku: i.sku, existingProductIds: i.existing.map((e) => e.productId) })),
        hideProductIds: [...hide],
      });
      setResult(r);
      onApplied();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  function toggle(set: Set<string>, key: string, on: boolean): Set<string> {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  }

  function outcomeLabel(item: OfficialMenuPreviewItem): string {
    if (item.outcome === "sku_exists") return t("officialMenu.outcomeSkuExists");
    if (item.outcome === "name_match")
      return willCreate(item) ? t("officialMenu.outcomeReplace") : t("officialMenu.outcomeNameMatch");
    return t("officialMenu.outcomeCreate");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-sm"
      data-testid="official-menu-dialog"
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl animate-scale-in flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-fg">{t("officialMenu.title")}</h2>
            <p className="text-xs text-fg-muted">
              {t("officialMenu.subtitle", { count: String(preview?.items.length ?? 33) })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded p-1 text-fg-muted hover:bg-paper hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
          {loadError && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-danger-fg">{loadError}</p>
          )}
          {!preview && !loadError && <p className="text-fg-muted">{t("officialMenu.loading")}</p>}

          {/* ── Already loaded, or just loaded ── */}
          {(result?.record ?? preview?.applied) && (
            <div
              className="rounded-lg border border-good-line bg-good-bg p-4 text-good-fg"
              data-testid="official-menu-applied"
            >
              <p className="font-semibold">
                {t("officialMenu.appliedTitle", {
                  date: (result?.record ?? preview!.applied!).appliedAt.slice(0, 16).replace("T", " "),
                })}
              </p>
              <p className="mt-1 text-xs">
                {result
                  ? t("officialMenu.resultSummary", {
                      created: String(result.createdSkus.length),
                      kept: String(result.skippedExistingSkus.length + result.keptExistingByNameSkus.length),
                      hidden: String(result.hiddenProductIds.length),
                    })
                  : t("officialMenu.appliedSummary", {
                      created: String(preview!.applied!.created),
                    })}
              </p>
              <p className="mt-1 text-xs">
                {t("officialMenu.appliedTax", {
                  rate: formatBps((result?.record ?? preview!.applied!).vatRateBps),
                  mode:
                    (result?.record ?? preview!.applied!).vatPricingMode === "inclusive"
                      ? t("officialMenu.modeInclusiveShort")
                      : t("officialMenu.modeExclusiveShort"),
                })}
              </p>
            </div>
          )}

          {preview && !preview.applied && !result && (
            <>
              {/* ── 1. Tax treatment: required, never defaulted ── */}
              <section
                className="rounded-lg border border-warn-line bg-warn-bg p-4"
                data-testid="official-menu-tax"
              >
                <h3 className="font-semibold text-warn-fg">{t("officialMenu.taxTitle")}</h3>
                <p className="mt-1 text-xs text-warn-fg">{t("officialMenu.taxExplain")}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-fg">
                    {t("officialMenu.taxRate")}
                    <select
                      data-testid="official-menu-vat"
                      value={vatRateId}
                      onChange={(e) => setVatRateId(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
                    >
                      <option value="">{t("officialMenu.taxRatePlaceholder")}</option>
                      {vatRates.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({formatBps(r.rateBps)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="text-xs text-fg">
                    <legend className="font-medium">{t("officialMenu.taxSide")}</legend>
                    {(["inclusive", "exclusive"] as const).map((m) => (
                      <label key={m} className="mt-1 flex items-start gap-2">
                        <input
                          type="radio"
                          name="official-menu-mode"
                          data-testid={`official-menu-mode-${m}`}
                          checked={mode === m}
                          onChange={() => setMode(m)}
                          className="mt-0.5"
                        />
                        <span>
                          {m === "inclusive"
                            ? t("officialMenu.modeInclusive")
                            : t("officialMenu.modeExclusive")}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </div>
                {example && examplePrice && (
                  <p className="mt-3 text-xs font-medium text-fg" data-testid="official-menu-example">
                    {t("officialMenu.taxExample", {
                      name: example.name,
                      printed: formatUsd(example.priceUsdCents),
                      pays: formatUsd(examplePrice.pays),
                      vat: formatUsd(examplePrice.vat),
                    })}
                  </p>
                )}
                <label className="mt-3 flex items-start gap-2 text-xs font-medium text-fg">
                  <input
                    type="checkbox"
                    data-testid="official-menu-confirm"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t("officialMenu.taxConfirm")}</span>
                </label>
              </section>

              {/* ── 2. Same-named items already on the Register ── */}
              {nameMatches.length > 0 && (
                <section data-testid="official-menu-name-matches">
                  <h3 className="font-semibold text-fg">{t("officialMenu.nameMatchTitle")}</h3>
                  <p className="text-xs text-fg-muted">{t("officialMenu.nameMatchExplain")}</p>
                  <ul className="mt-2 space-y-1.5">
                    {nameMatches.map((i) => (
                      <li key={i.sku} className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          data-testid={`official-menu-replace-${i.sku}`}
                          checked={replace.has(i.sku)}
                          onChange={(e) => setReplace((s) => toggle(s, i.sku, e.target.checked))}
                          className="mt-0.5"
                        />
                        <span>
                          {t("officialMenu.nameMatchItem", {
                            official: `${i.name} (${i.sku}, ${formatUsd(i.priceUsdCents)})`,
                            existing: i.existing
                              .map((e) => `${e.name} (${e.sku ?? "—"}, ${formatUsd(e.priceInclVatCents)})`)
                              .join(", "),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* ── 3. Other Register items: old samples ── */}
              {preview.samples.length > 0 && (
                <section data-testid="official-menu-samples">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-fg">{t("officialMenu.samplesTitle")}</h3>
                    {preview.samples.some((s) => s.looksLikeSample) && (
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-ink underline"
                        onClick={() =>
                          setHide(
                            new Set(
                              preview.samples.filter((s) => s.looksLikeSample).map((s) => s.productId),
                            ),
                          )
                        }
                      >
                        {t("officialMenu.samplesTickMarked")}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-fg-muted">{t("officialMenu.samplesExplain")}</p>
                  <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {preview.samples.map((s) => (
                      <li key={s.productId} className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          data-testid={`official-menu-hide-${s.productId}`}
                          checked={hide.has(s.productId)}
                          onChange={(e) => setHide((h) => toggle(h, s.productId, e.target.checked))}
                          className="mt-0.5"
                        />
                        <span>
                          {s.name} <span className="text-fg-muted">({s.sku ?? "—"}, {formatUsd(s.priceInclVatCents)})</span>
                          {s.looksLikeSample && (
                            <span className="ms-1 rounded bg-paper px-1 text-[10px] text-fg-muted">
                              {t("officialMenu.sampleTag")}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}

          {/* ── The menu itself ── */}
          {preview && (
            <section data-testid="official-menu-items">
              <h3 className="font-semibold text-fg">{t("officialMenu.itemsTitle")}</h3>
              <div className="mt-2 space-y-3">
                {grouped.map(({ category, items }) => (
                  <div key={category.id}>
                    <p className="text-[11px] font-black uppercase text-fg-muted">
                      {t(category.labelKey)} · {items.length}
                    </p>
                    <table className="mt-1 w-full text-xs">
                      <tbody>
                        {items.map((i) => (
                          <tr key={i.sku} className="border-t border-line align-top" data-testid={`official-menu-row-${i.sku}`}>
                            <td className="w-7 py-1.5 text-base leading-none">{i.icon}</td>
                            <td className="py-1.5 pe-2">
                              <span className="font-medium text-fg">{i.name}</span>{" "}
                              <span className="text-fg-muted">{i.sku}</span>
                              {!i.sellable && (
                                <span className="ms-1 rounded bg-warn-bg px-1 text-[10px] text-warn-fg">
                                  {t("officialMenu.comingSoon")}
                                </span>
                              )}
                              {i.kind === "add_on" && (
                                <span className="ms-1 rounded bg-paper px-1 text-[10px] text-fg-muted">
                                  {t("officialMenu.kindAddOn")}
                                </span>
                              )}
                              {i.kind === "upgrade" && (
                                <span className="ms-1 rounded bg-paper px-1 text-[10px] text-fg-muted">
                                  {t("officialMenu.kindUpgrade")}
                                </span>
                              )}
                              {i.description && (
                                <p className="text-[11px] text-fg-muted">{i.description}</p>
                              )}
                            </td>
                            <td className="whitespace-nowrap py-1.5 pe-2 text-end font-semibold tabular-nums">
                              {formatUsd(i.priceUsdCents)}
                            </td>
                            <td className="whitespace-nowrap py-1.5 text-end">
                              <span
                                className={clsx(
                                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                  willCreate(i)
                                    ? "bg-good-bg text-good-fg"
                                    : "bg-paper text-fg-muted",
                                )}
                              >
                                {outcomeLabel(i)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
              <p className="mt-3 rounded-lg bg-paper p-3 text-xs text-fg-muted">
                {t("officialMenu.limits")}
              </p>
            </section>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-4">
          {preview && !preview.applied && !result ? (
            <>
              <p className="text-xs text-fg-muted" data-testid="official-menu-summary">
                {t("officialMenu.summary", {
                  create: String(toCreate),
                  keep: String(toKeep),
                  hide: String(hide.size),
                })}
              </p>
              <div className="flex items-center gap-2">
                {applyError && (
                  <span className="max-w-md text-xs text-danger-fg" role="alert">
                    {applyError}
                  </span>
                )}
                <Button variant="secondary" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={!ready}
                  data-testid="official-menu-apply"
                  onClick={() => void handleApply()}
                >
                  {applying ? t("officialMenu.applying") : t("officialMenu.apply")}
                </Button>
              </div>
            </>
          ) : (
            <div className="ms-auto">
              <Button variant="primary" onClick={onClose} data-testid="official-menu-close">
                {t("common.close")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
