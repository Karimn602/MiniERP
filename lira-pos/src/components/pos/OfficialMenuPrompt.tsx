import { useEffect, useState } from "react";
import { previewOfficialMenu } from "../../lib/officialMenu";
import { vatRatesRepo } from "../../db/repos/vatRates";
import type { VatRate } from "../../db/types";
import { useTranslation } from "../../lib/i18n";
import { Button } from "../ui/Button";
import { OfficialMenuDialog } from "../OfficialMenuDialog";

/** Per-device "Not now". A convenience only: the marker in the database is the truth. */
const DISMISS_KEY = "greaz_official_menu_prompt_dismissed";

function dismissed(storeId: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_KEY}:${storeId}`) === "1";
  } catch {
    return false;
  }
}

/**
 * The first-run prompt on the Register: "Greaz's official menu has not been
 * loaded yet". Shown to the OWNER only — loading the menu decides its tax
 * treatment, which is the owner's call (`ApplyOfficialMenu`) — and only until
 * the menu is loaded. It opens the same dialog the Products page does, so the
 * owner reviews and confirms the menu on the screen where they will sell it.
 *
 * Renders nothing for anyone else, and nothing if the status cannot be read:
 * a prompt must never get in the way of selling.
 */
export function OfficialMenuPrompt({
  storeId,
  isOwner,
  onMenuChanged,
}: {
  storeId: string | null;
  isOwner: boolean;
  onMenuChanged: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [vatRates, setVatRates] = useState<VatRate[]>([]);

  useEffect(() => {
    if (!storeId || !isOwner || dismissed(storeId)) {
      setPending(false);
      return;
    }
    let live = true;
    previewOfficialMenu(storeId)
      .then((p) => live && setPending(p.applied === null))
      .catch(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, [storeId, isOwner]);

  async function openDialog() {
    try {
      setVatRates(await vatRatesRepo.listActive());
    } catch {
      setVatRates([]);
    }
    setOpen(true);
  }

  if (!storeId || !isOwner || (!pending && !open)) return null;

  return (
    <>
      {pending && (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-chip border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn-fg"
          data-testid="official-menu-prompt"
        >
          <span className="font-semibold">{t("officialMenu.bannerText")}</span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => void openDialog()}>
              {t("officialMenu.bannerAction")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  localStorage.setItem(`${DISMISS_KEY}:${storeId}`, "1");
                } catch {
                  /* per-device convenience only */
                }
                setPending(false);
              }}
            >
              {t("officialMenu.bannerDismiss")}
            </Button>
          </span>
        </div>
      )}
      {open && (
        <OfficialMenuDialog
          storeId={storeId}
          vatRates={vatRates}
          onClose={() => setOpen(false)}
          onApplied={() => {
            setPending(false);
            onMenuChanged();
          }}
        />
      )}
    </>
  );
}
