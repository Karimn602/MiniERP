import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { canSee, HOME_PATH, type AppScreen } from "../lib/permissions";
import { useActiveUser } from "../state/session";

/**
 * THE ROUTE GUARD — Gate 2B, Stage B.3. The third of three layers, and the
 * least important of them.
 *
 * The rail does not offer a cashier the Products screen; this stops them
 * REACHING it; and `authz.rs` refuses the write whichever of those two fails.
 * Only the third is a security control, and it is the only one that would still
 * be standing if this file were deleted.
 *
 * So why have it. Because the router is reachable without the rail: a redirect
 * from a removed route, a `<Navigate>` left behind by an earlier flow, a deep
 * link restored after a reload, or a screen that was legitimately open when the
 * owner changed somebody's role. In each of those the nav filter has no say.
 * Mounting Products for a cashier would then render a page whose every control
 * refuses — and worse, one that READS. Stage C is what will gate the read
 * channel; until then, not mounting the screen is what keeps a cashier from
 * seeing the kitchen's food cost.
 *
 * **It redirects rather than explaining.** A cashier cannot type a URL — there
 * is no address bar in the Tauri window — so arriving here is never something
 * they did on purpose, and a page saying "you are not allowed here" would be
 * answering a question nobody asked. They land on the register, which is where
 * a till should be.
 *
 * The one case that is NOT a redirect is the locked session: `useActiveUser()`
 * returns null while locked, so every guarded route would bounce to the
 * register behind the glass, and unlocking would put the operator somewhere
 * other than where they left off. A locked session is held in place instead,
 * rendering what was already there under the overlay.
 */
export function RequireRole({
  screen,
  children,
}: {
  screen: AppScreen;
  children: ReactNode;
}) {
  const user = useActiveUser();

  // Locked, or not yet resolved. Hold the screen: the lock is an overlay over a
  // mounted router and unlocking must return the operator to where they were.
  if (!user) return <>{children}</>;

  if (!canSee(user.role, screen)) return <Navigate to={HOME_PATH} replace />;

  return <>{children}</>;
}
