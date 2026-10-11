import { useEffect } from "react";

/**
 * DESIGN PREVIEW — NOT PART OF THE APPLICATION.
 *
 * A regression harness, not a design. The POS Register asks the shell to let
 * it fill the viewport (`lg:flex-1 lg:min-h-0`), which required `AppShell`'s
 * routed wrapper to carry a definite height. Every OTHER page is an ordinary
 * block child of that wrapper and must keep scrolling the way it always has.
 *
 * This renders a block far taller than any viewport inside the real `AppShell`
 * so that can be checked: the last row must be reachable by scrolling, and
 * nothing may be clipped.
 */
export default function TallPreview() {
  // ?scroll=bottom proves the last row is reachable, which is the whole point
  // of this harness.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("scroll") !== "bottom") return;
    document.querySelector("main")?.scrollTo({ top: 99_999, behavior: "auto" });
  }, []);

  return (
    <div className="space-y-3">
      <h2 className="greaz-display text-2xl uppercase text-fg">
        Tall page scroll check
      </h2>
      <p className="text-sm text-fg-muted">
        A page that does not opt into filling the shell. Row 40 must be
        reachable by scrolling, and nothing may be cut off.
      </p>
      {Array.from({ length: 40 }, (_, i) => (
        <div
          key={i}
          className="rounded-panel border border-line bg-surface p-4 text-sm text-fg shadow-panel"
        >
          Row {i + 1} of 40
        </div>
      ))}
    </div>
  );
}
