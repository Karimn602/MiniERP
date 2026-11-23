import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  combinedChoiceNote,
  isChoiceComplete,
  pickCount,
  type ChoicePicks,
  type MenuChoiceGroup,
} from "../../lib/officialMenu";
import { useTranslation } from "../../lib/i18n";
import { Button } from "../ui/Button";

/**
 * Asks for an item's free sauce or dips before it joins the order.
 *
 * The answer becomes the line's kitchen note (see `lib/officialMenu.ts`): it
 * reaches the kitchen ticket and the posted line, and it carries no money.
 * Cancel adds nothing. A single-choice group adds on the click; a multi-pick
 * group (the Greaz Box's three dips) needs exactly its count, repeats allowed.
 */
export function MenuChoiceDialog({
  itemName,
  groups,
  onConfirm,
  onCancel,
}: {
  itemName: string;
  groups: MenuChoiceGroup[];
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [picks, setPicks] = useState<Record<string, ChoicePicks>>({});

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const complete = groups.every((g) => isChoiceComplete(g, picks[g.id] ?? {}));

  function set(groupId: string, option: string, n: number) {
    setPicks((prev) => {
      const g = { ...(prev[groupId] ?? {}) };
      if (n <= 0) delete g[option];
      else g[option] = n;
      return { ...prev, [groupId]: g };
    });
  }

  /** A single-pick option. Alone in the dialog, the click IS the answer. */
  function pickOne(group: MenuChoiceGroup, option: string) {
    if (groups.length === 1) {
      onConfirm(combinedChoiceNote(groups, { [group.id]: { [option]: 1 } }));
      return;
    }
    setPicks((prev) => ({ ...prev, [group.id]: { [option]: 1 } }));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4"
      data-testid="menu-choice-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-fg">{t("menuChoice.title", { name: itemName })}</h2>
        <p className="mt-0.5 text-xs text-fg-muted">{t("menuChoice.noCharge")}</p>

        {groups.map((g) => {
          const gp = picks[g.id] ?? {};
          const n = pickCount(gp);
          return (
            <div key={g.id} className="mt-4">
              <p className="text-xs font-semibold text-fg">
                {g.selectionCount === 1
                  ? t("menuChoice.pickOne")
                  : t("menuChoice.pickMany", { count: String(g.selectionCount) })}
              </p>
              {g.selectionCount === 1 ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {g.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      data-testid={`menu-choice-${o}`}
                      onClick={() => pickOne(g, o)}
                      className={clsx(
                        "rounded-chip border px-3 py-3 text-sm font-bold",
                        gp[o] ? "border-brand bg-brand text-brand-fg" : "border-line bg-paper text-fg hover:border-brand",
                      )}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <ul className="mt-2 space-y-1.5">
                    {g.options.map((o) => {
                      const k = gp[o] ?? 0;
                      return (
                        <li key={o} className="flex items-center justify-between rounded-chip border border-line bg-paper px-3 py-1.5 text-sm">
                          <span className="font-semibold text-fg">{o}</span>
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={`- ${o}`}
                              data-testid={`menu-choice-minus-${o}`}
                              disabled={k === 0}
                              onClick={() => set(g.id, o, k - 1)}
                              className="h-8 w-8 rounded-chip border border-line bg-surface font-bold disabled:opacity-40"
                            >
                              −
                            </button>
                            <span className="w-4 text-center tabular-nums">{k}</span>
                            <button
                              type="button"
                              aria-label={`+ ${o}`}
                              data-testid={`menu-choice-plus-${o}`}
                              disabled={n >= g.selectionCount || (!g.repeatAllowed && k >= 1)}
                              onClick={() => set(g.id, o, k + 1)}
                              className="h-8 w-8 rounded-chip border border-line bg-surface font-bold disabled:opacity-40"
                            >
                              +
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    {t("menuChoice.picked", { n: String(n), count: String(g.selectionCount) })}
                  </p>
                </>
              )}
            </div>
          );
        })}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          {!(groups.length === 1 && groups[0].selectionCount === 1) && (
            <Button
              variant="primary"
              disabled={!complete}
              data-testid="menu-choice-add"
              onClick={() => onConfirm(combinedChoiceNote(groups, picks))}
            >
              {t("menuChoice.add")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
