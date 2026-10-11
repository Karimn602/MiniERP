import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * Panel surface. Radius and shadow are tokens, not fixed values: the approved
 * concepts differ in geometry as well as colour — Classic is the squarer
 * appearance (8px panels, tight warm shadow), Midnight the rounder one (14px,
 * a blacker shadow, because a diffuse one is invisible on #171617).
 */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-panel border border-line bg-surface shadow-panel",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="greaz-display text-sm uppercase text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx("p-5", className)}>{children}</div>;
}
