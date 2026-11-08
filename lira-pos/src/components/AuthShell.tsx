import type { ReactNode } from "react";
import { SandboxBanner } from "./SandboxBanner";

/**
 * The frame every pre-till screen sits in: enrollment, login, the lock screen,
 * and the boot failure.
 *
 * One frame rather than four, because these screens are seen in sequence by the
 * same person at the same moment and a layout that shifts between them reads as
 * four different applications. It keeps the sandbox banner, so a training build
 * still says so before anybody has signed in — which is exactly when somebody
 * might mistake it for the real till.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  tone = "normal",
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "normal" | "danger";
}) {
  return (
    <div className="flex h-screen flex-col">
      <SandboxBanner />
      <div className="flex flex-1 items-center justify-center overflow-y-auto bg-paper p-6">
        <div className="w-full max-w-xl space-y-4">
          <div className="space-y-1 text-center">
            {/* The product name, so a locked till is identifiable across a
                room without reading the body text. */}
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-fg-muted">
              Greaz POS
            </div>
            <h1
              className={
                tone === "danger"
                  ? "text-2xl font-bold tracking-tight text-danger-fg"
                  : "text-2xl font-bold tracking-tight text-fg"
              }
            >
              {title}
            </h1>
            {subtitle ? (
              <div className="text-sm text-fg-muted">{subtitle}</div>
            ) : null}
          </div>

          <div
            className={
              tone === "danger"
                ? "rounded-lg border border-danger-line bg-surface p-6 shadow-soft"
                : "rounded-lg border border-line bg-surface p-6 shadow-soft"
            }
          >
            {children}
          </div>

          {footer ? (
            <div className="px-2 text-center text-xs leading-relaxed text-fg-muted">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
