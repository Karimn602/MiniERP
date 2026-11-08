//! BACKEND AUTHORIZATION — Gate 2B, Stage B.
//!
//! WHY THIS IS THE STAGE THAT MATTERS
//!
//! Stage A.1 gave Greaz a credential, a session and a lock, and admitted the
//! OWNER only — because a role that decides nothing is not a permission, and a
//! staff account with owner powers and a different name on it is worse than no
//! staff account at all. It creates the belief that a cashier cannot refund,
//! which is how an unexplained shortfall goes unlooked-for.
//!
//! This module is what makes the three roles real. After it, a cashier may ring
//! a sale and may not reprice the menu, and that is enforced in Rust rather than
//! by a hidden button.
//!
//! THE MATRIX IS DATA IN RUST, NOT A TABLE
//!
//! Three roles and twenty-six operations belong in a `match`, reviewable in a
//! diff, not in a `role_permissions` table. Two reasons, and the second is the
//! stronger one: a table would be configuration nothing can configure (there is
//! no command to write it), and a table is READABLE AND WRITABLE BY WHATEVER
//! CAN REACH THE DATABASE FILE — so the policy would live in the one place this
//! application cannot defend. A `match` compiled into the binary cannot be
//! edited at the till.
//!
//! [`permits`] is an EXHAUSTIVE match on purpose. Adding an `Operation` without
//! deciding its policy does not compile, which is the only way a matrix stays
//! complete as the application grows — and the alternative, a `_ => false`
//! catch-all, is how a new operation silently becomes owner-only, or worse, how
//! a `_ => true` makes it everybody's.
//!
//! THE CHECK RUNS INSIDE THE TRANSACTION, AND RE-READS THE ROLE
//!
//! [`authorize_tx`] does not trust the role on the [`Actor`]. The actor was
//! resolved when the command started; the transaction may commit a moment
//! later, and in between an owner may have changed somebody's role or
//! deactivated them. So the role and the `active` flag are read again, from
//! the database, inside the same transaction that is about to write — which is
//! the same discipline `post_supplier_payment` applies to the payable and
//! `post_credit_memo` to the drawer. A permission decided against a snapshot
//! the transaction cannot see is a permission decided against the past.
//!
//! WHERE IT IS CALLED, AND WHY THE ORDER IS LOAD-BEARING
//!
//! After the idempotency resolution, and before anything is written. The
//! ordering is not a detail:
//!
//!   * A REPLAY must reconcile to the document that already posted, whoever is
//!     signed in now and whatever they may now do. The frozen checkout attempt
//!     is the only thing between a lost response and a double charge, and it is
//!     replayed by whoever is at the till when the application comes back —
//!     which may be the next shift's cashier. Refusing that replay on a
//!     permission the original cashier had and this one does not would turn the
//!     one recovery path into a double charge.
//!   * A NEW document must be refused before a receipt, purchase or memo number
//!     is consumed, so a refusal costs the sequence nothing.
//!
//! `posting.rs` already resolves identity first, deliberately, with comments
//! saying why. This slots in behind it and moves nothing.

use sqlx::Row;

use crate::auth::{Actor, Role};

/// Every operation this application authorizes.
///
/// One variant per DECISION, not per command: `save_product` appears twice
/// because changing a price and changing a cost are different decisions with
/// different answers, and `close_shift` appears twice because closing your own
/// is routine and closing somebody else's is supervision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Operation {
    // --- front of house -------------------------------------------------
    PostSale,
    /// A discount above [`DISCOUNT_WITHOUT_APPROVAL_CENTS`]. See the constant
    /// for why this is an amount and not a role.
    PostSaleLargeDiscount,
    OpenShift,
    CloseOwnShift,
    CloseAnotherShift,
    DriverRemittance,

    // --- corrections and money out --------------------------------------
    PostCreditMemo,
    PostAdjustment,
    DriverLedgerAdjustment,

    // --- the menu and what it costs -------------------------------------
    SaveProduct,
    /// Changing a product's COST or costing method. Owner only — see
    /// [`permits`].
    SaveProductCost,
    ProductBarcode,
    RecipeDraft,
    RecipeActivate,
    RecipeRetire,

    // --- buying side ----------------------------------------------------
    PostPurchase,
    SupplierPayment,
    SupplierSave,
    DriverSave,

    // --- configuration --------------------------------------------------
    ExchangeRateSave,

    // --- administration -------------------------------------------------
    UserAdmin,
    ResetAnotherCredential,

    // --- reading (enforced in Stage C; the policy is decided here so the
    //     matrix is complete and Stage C has nothing to invent) -----------
    ReadCostAndMargin,
    ReadProfitReports,
    ReadAnotherShiftHistory,
    ReadAuthAudit,
}

impl Operation {
    /// The name recorded in `auth_audit.operation` on a refusal.
    ///
    /// Stable strings rather than `{:?}`, because these end up in a security
    /// log somebody reads months later and a rename should be a deliberate act.
    pub(crate) fn audit_name(self) -> &'static str {
        match self {
            Operation::PostSale => "post_sale",
            Operation::PostSaleLargeDiscount => "post_sale.large_discount",
            Operation::OpenShift => "open_shift",
            Operation::CloseOwnShift => "close_shift.own",
            Operation::CloseAnotherShift => "close_shift.another",
            Operation::DriverRemittance => "post_driver_remittance",
            Operation::PostCreditMemo => "post_credit_memo",
            Operation::PostAdjustment => "post_adjustment",
            Operation::DriverLedgerAdjustment => "driver_ledger.adjustment",
            Operation::SaveProduct => "save_product",
            Operation::SaveProductCost => "save_product.cost",
            Operation::ProductBarcode => "product_barcode",
            Operation::RecipeDraft => "save_recipe_draft",
            Operation::RecipeActivate => "activate_recipe",
            Operation::RecipeRetire => "retire_recipe",
            Operation::PostPurchase => "post_purchase",
            Operation::SupplierPayment => "post_supplier_payment",
            Operation::SupplierSave => "supplier_save",
            Operation::DriverSave => "driver_save",
            Operation::ExchangeRateSave => "exchange_rate_save",
            Operation::UserAdmin => "users_admin",
            Operation::ResetAnotherCredential => "credential_reset.other",
            Operation::ReadCostAndMargin => "read.cost_and_margin",
            Operation::ReadProfitReports => "read.profit_reports",
            Operation::ReadAnotherShiftHistory => "read.shift_history.another",
            Operation::ReadAuthAudit => "read.auth_audit",
        }
    }

    /// A sentence for the person who was refused.
    ///
    /// Each one says WHO can do the thing, because "permission denied" at a
    /// till leaves a cashier with nothing to do but ask the next person along,
    /// and the whole value of a role system is that they know who to ask.
    pub(crate) fn refusal(self, role: Role) -> String {
        let who = match self {
            Operation::SaveProductCost
            | Operation::UserAdmin
            | Operation::ResetAnotherCredential => "the owner",
            _ => "a manager or the owner",
        };
        let what = match self {
            Operation::PostSale => "post this sale",
            Operation::PostSaleLargeDiscount => "give a discount this large",
            Operation::OpenShift => "open a shift",
            Operation::CloseOwnShift => "close this shift",
            Operation::CloseAnotherShift => "close somebody else's shift",
            Operation::DriverRemittance => "take a driver's hand-over",
            Operation::PostCreditMemo => "give a refund",
            Operation::PostAdjustment => "change the stock count",
            Operation::DriverLedgerAdjustment => "adjust a driver's balance",
            Operation::SaveProduct => "change the menu",
            Operation::SaveProductCost => "change what an item costs",
            Operation::ProductBarcode => "change a barcode",
            Operation::RecipeDraft | Operation::RecipeActivate | Operation::RecipeRetire => {
                "change a recipe"
            }
            Operation::PostPurchase => "enter a supplier delivery",
            Operation::SupplierPayment => "pay a supplier",
            Operation::SupplierSave => "change a supplier",
            Operation::DriverSave => "change a driver",
            Operation::ExchangeRateSave => "set the exchange rate",
            Operation::UserAdmin => "manage staff accounts",
            Operation::ResetAnotherCredential => "reset somebody else's passphrase",
            Operation::ReadCostAndMargin => "see costs and margins",
            Operation::ReadProfitReports => "see the profit reports",
            Operation::ReadAnotherShiftHistory => "see somebody else's shift",
            Operation::ReadAuthAudit => "see the sign-in history",
        };
        let as_role = match role {
            Role::Owner => "the owner",
            Role::Manager => "a manager",
            Role::Cashier => "a cashier",
        };
        format!(
            "You cannot {what} as {as_role}. Ask {who} to do it. \
             Nothing has been changed."
        )
    }
}

/// The largest discount a cashier may give without a manager.
///
/// AN AMOUNT, NOT A ROLE, and that is the judgement call worth defending: a
/// cashier rounding thirty cents off a cold coffee is daily practice in a
/// restaurant and making them fetch a manager for it would mean the manager's
/// passphrase is shared within a week. Thirty per cent off is not daily
/// practice. So the role governs the SIZE, and the small kindnesses stay
/// available to the person actually facing the customer.
///
/// A constant rather than a setting, deliberately: a configurable threshold
/// needs an owner-only `app_settings` write command and a screen to set it, and
/// that is a feature. Making it configurable later changes this line and adds
/// those two things; leaving it hard-coded now does not have to be undone.
pub(crate) const DISCOUNT_WITHOUT_APPROVAL_CENTS: i64 = 500;

/// THE MATRIX.
///
/// Exhaustive on both axes. `#[deny(...)]` is not needed: a missing arm is a
/// compile error, which is the point.
///
/// Two judgement calls are worth stating because they will be questioned.
///
/// **COST EDITING IS OWNER-ONLY while prices are manager-allowed.** A price is
/// an operating decision — the manager who runs the evening should be able to
/// reprice a special. A cost is the basis of every margin figure in the
/// business and, under `costing_method = 'standard'`, has no document behind
/// it: it is purely an assertion. WP-B1 made that argument when it restricted
/// Manual Cost to non-stock items, and it applies again here. A manager who can
/// type a cost can make any item look profitable.
///
/// **A CASHIER MAY TAKE A DRIVER'S HAND-OVER but may not adjust his balance.**
/// Counting cash a driver brings back is front-of-house work and the amount is
/// bounded by what he owes. Writing a balance down by hand is a correction, and
/// corrections are supervision.
pub(crate) fn permits(role: Role, operation: Operation) -> bool {
    use Operation::*;
    use Role::*;

    match (role, operation) {
        // --- the owner does everything, intentionally -------------------
        (Owner, _) => true,

        // --- front of house: a cashier's actual job ---------------------
        (Manager | Cashier, PostSale) => true,
        (Manager | Cashier, OpenShift) => true,
        (Manager | Cashier, CloseOwnShift) => true,
        (Manager | Cashier, DriverRemittance) => true,

        // --- supervision ------------------------------------------------
        (Manager, CloseAnotherShift) => true,
        (Cashier, CloseAnotherShift) => false,

        (Manager, PostSaleLargeDiscount) => true,
        (Cashier, PostSaleLargeDiscount) => false,

        // --- money out and corrections ----------------------------------
        (Manager, PostCreditMemo) => true,
        (Cashier, PostCreditMemo) => false,

        (Manager, PostAdjustment) => true,
        (Cashier, PostAdjustment) => false,

        (Manager, DriverLedgerAdjustment) => true,
        (Cashier, DriverLedgerAdjustment) => false,

        // --- the menu ---------------------------------------------------
        (Manager, SaveProduct) => true,
        (Cashier, SaveProduct) => false,

        // The one thing a manager may NOT do to a product. See the note above.
        (Manager | Cashier, SaveProductCost) => false,

        (Manager, ProductBarcode) => true,
        (Cashier, ProductBarcode) => false,

        (Manager, RecipeDraft | RecipeActivate | RecipeRetire) => true,
        (Cashier, RecipeDraft | RecipeActivate | RecipeRetire) => false,

        // --- buying side ------------------------------------------------
        (Manager, PostPurchase) => true,
        (Cashier, PostPurchase) => false,

        (Manager, SupplierPayment) => true,
        (Cashier, SupplierPayment) => false,

        (Manager, SupplierSave) => true,
        (Cashier, SupplierSave) => false,

        (Manager, DriverSave) => true,
        (Cashier, DriverSave) => false,

        // --- configuration ----------------------------------------------
        // The rate is the one setting that reaches a posted figure: `post_sale`
        // validates a lira tender against the `exchange_rates` row, so whoever
        // writes that row decides what a lira is worth. Not a cashier.
        (Manager, ExchangeRateSave) => true,
        (Cashier, ExchangeRateSave) => false,

        // --- administration ---------------------------------------------
        // OWNER ONLY, and resolved conservatively. The Gate 2 design's §7
        // matrix says owner-only; its §9 recovery table mentions a manager
        // resetting a cashier. The two disagree, so this takes the stricter
        // reading — a manager who can reset a cashier's passphrase can sign in
        // as that cashier, and attribution is the thing Stage B exists to make
        // trustworthy. If the shop wants manager resets, that is a deliberate
        // change to this line plus an audit row naming the manager.
        (Manager | Cashier, UserAdmin) => false,
        (Manager | Cashier, ResetAnotherCredential) => false,

        // --- reading (Stage C enforces; the policy is settled here) ------
        (Manager, ReadCostAndMargin | ReadProfitReports) => true,
        (Cashier, ReadCostAndMargin | ReadProfitReports) => false,

        (Manager, ReadAnotherShiftHistory) => true,
        (Cashier, ReadAnotherShiftHistory) => false,

        // The security log names who failed to sign in and when. Owner only:
        // a manager reading it learns which accounts are being probed, and a
        // cashier reading their own failed attempts learns how many remain
        // before the lockout.
        (Manager | Cashier, ReadAuthAudit) => false,
    }
}

/// THE COMMAND BOUNDARY. Everything a writable command needs before it may
/// touch the database, resolved in one place.
///
/// Replaces the bare `posting::pool(&app, &state)` call that every
/// transactional command used to open with. Four things happen here and each
/// one closes something the previous stage left open:
///
///   1. **The window is checked.** Stage A.1 bound only the `auth_*` commands
///      to the primary window; the twenty database commands took an
///      `AppHandle` and consulted the process-wide session, so a second Tauri
///      webview would have inherited the owner's authority. Independent review
///      raised that as a P2 and it was deferred HERE deliberately, because the
///      fix is this same signature change and doing it twice would have been
///      two risky passes over twenty commands instead of one.
///   2. **The startup and session gates run**, through `pool_for_state` —
///      unchanged, and still in that order, so a failed database reports itself
///      rather than asking for a passphrase.
///   3. **The actor is resolved FROM THE SESSION.** Not from the payload. This
///      is the whole point of Stage B: a caller can no longer name its own
///      actor or its own role.
///   4. **The operation is authorized and a refusal is logged**, before any
///      transaction opens, so a refusal consumes no receipt number.
pub(crate) async fn begin(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    state: &tauri::State<'_, crate::posting::DbState>,
    operation: Operation,
) -> Result<(sqlx::SqlitePool, Actor), String> {
    use tauri::Manager;

    crate::auth::require_primary_window_label(window.label())?;

    let sessions = app.state::<crate::auth::SessionState>();
    let pool = crate::posting::pool(app, state).await?;
    let actor = sessions.current_actor().await?;

    authorize(&pool, &actor, operation).await?;
    Ok((pool, actor))
}

/// The role and store as the DATABASE has them, not as the actor claims.
///
/// `Err` is already an operator-facing sentence: these three states mean the
/// account changed under the person using it, and the only sensible instruction
/// is to sign in again.
async fn stored_identity<'e, E>(executor: E, actor: &Actor) -> Result<Role, String>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query("SELECT role, active, store_id FROM users WHERE id = ?")
        .bind(&actor.user_id)
        .fetch_optional(executor)
        .await
        .map_err(|e| format!("cannot confirm who is signed in: {e}"))?;

    let Some(row) = row else {
        return Err(
            "The account that was signed in no longer exists. Sign out and sign in again. \
             Nothing has been changed."
                .to_string(),
        );
    };

    if row.try_get::<i64, _>("active").unwrap_or(0) != 1 {
        return Err(
            "That account is no longer active. Sign out and sign in again. \
             Nothing has been changed."
                .to_string(),
        );
    }

    let stored_store: String = row
        .try_get("store_id")
        .map_err(|e| format!("cannot read the stored store: {e}"))?;
    if stored_store != actor.store_id {
        // The session's store and the user's row disagree. Nothing in the
        // application can produce this, which is exactly why it is refused
        // rather than reconciled to one of the two.
        return Err(
            "This account belongs to another shop. Sign out and sign in again. \
             Nothing has been changed."
                .to_string(),
        );
    }

    let stored_role: String = row
        .try_get("role")
        .map_err(|e| format!("cannot read the stored role: {e}"))?;
    Role::from_db(&stored_role)
}

/// AUTHORIZE AT THE COMMAND BOUNDARY, and record a refusal durably.
///
/// Called before the transaction opens. Two jobs:
///
///   * **Refuse early.** A refused operation costs nothing: no transaction, no
///     consumed receipt or purchase number, no partial work to roll back.
///   * **Audit durably.** This is the only place a `permission_denied` row CAN
///     be written, and the reason is worth stating because the obvious
///     implementation is wrong. A row inserted by [`authorize_tx`] would be
///     inside the transaction that is about to be rolled back, so the rollback
///     would take the evidence with it — an audit log that records only the
///     refusals that somehow succeeded. SQLite also permits one writer at a
///     time, so a second connection cannot write while that transaction is
///     open. Hence: audit here, where no transaction is in flight.
///
/// [`authorize_tx`] then re-checks inside the transaction and is the authority.
/// This one is the fast path and the log.
pub(crate) async fn authorize(
    pool: &sqlx::SqlitePool,
    actor: &Actor,
    operation: Operation,
) -> Result<(), String> {
    let role = stored_identity(pool, actor).await?;
    if permits(role, operation) {
        return Ok(());
    }

    let refusal = operation.refusal(role);
    record_denial(pool, actor, operation, role).await;
    Err(refusal)
}

/// AUTHORIZE AGAIN, INSIDE THE TRANSACTION. This one is the boundary.
///
/// Call after the idempotency resolution and before anything is written — see
/// the module header for why that order is load-bearing.
///
/// It re-reads the role rather than trusting the [`Actor`] or the pre-check,
/// because the pre-check ran before the transaction opened and a role can
/// change in between. The same discipline `post_supplier_payment` applies to
/// the payable and `post_credit_memo` to the drawer: a decision that must hold
/// at COMMIT is read inside the transaction that commits.
///
/// It writes NO audit row, for the reason [`authorize`] gives. A refusal that
/// only this check catches — a role changed in the window between the two — is
/// correctly refused and goes unlogged; that is a known and acceptable gap,
/// recorded here rather than papered over, and it is far better than a log
/// whose rows disappear with their rollbacks.
pub(crate) async fn authorize_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    actor: &Actor,
    operation: Operation,
) -> Result<(), String> {
    let role = stored_identity(&mut **tx, actor).await?;
    if permits(role, operation) {
        Ok(())
    } else {
        Err(operation.refusal(role))
    }
}

/// THE ACTOR ON A NEW DOCUMENT COMES FROM THE SESSION, and a payload that
/// disagrees is REFUSED.
///
/// WHAT THIS REPLACES. Every `*_user_id` column was bound straight from the
/// request: `sales.cashier_user_id`, `shifts.opened_by_user_id`,
/// `purchases.created_by_user_id`, `inventory_movements.created_by_user_id` and
/// the rest. No command checked the value against `users`, checked `active`, or
/// consulted `role` — the foreign key guaranteed only that it was SOME user id,
/// and `NULL` was always available. So the attribution on every posted
/// financial document in the shop's history is a claim by the caller, and
/// because `activeContext.ts` picked whichever owner sorted first, that claim
/// was the same hardcoded owner on every row.
///
/// THE CROSS-CHECK PATTERN IS THIS CODEBASE'S OWN, applied again. The database
/// decides, the client's copy is a cross-check, and a disagreement is refused
/// rather than silently normalised — exactly how `post_sale` already treats
/// `quantity_base`, `factor_*_snapshot` and `product_uom_id_snapshot`, and how
/// `post_purchase` treats a declared VAT counterpart. Keeping the field on the
/// wire is what lets a frozen checkout attempt replay unchanged.
///
/// `None` is accepted and filled from the session: a caller that declines to
/// name an actor is not asserting a false one. A caller that names SOMEBODY
/// ELSE is refused, because accepting it silently would be the defect this
/// function exists to remove, and refusing it is how a stale screen or a
/// hand-built request gets found.
pub(crate) fn attribute(actor: &Actor, declared: Option<&str>) -> Result<String, String> {
    match declared {
        None => Ok(actor.user_id.clone()),
        Some(claimed) if claimed == actor.user_id => Ok(actor.user_id.clone()),
        Some(_) => Err(
            "This request names a different person than the one signed in. \
             Nothing has been changed. Sign out and sign in again, then try once more."
                .to_string(),
        ),
    }
}

/// The same, for a column that is `NOT NULL` and whose payload field is a plain
/// `String` rather than an `Option` — `shifts.opened_by_user_id` and
/// `closed_by_user_id`.
///
/// An EMPTY string counts as "not named", because that is what a form field
/// nobody filled in sends, and treating it as a claim about a user whose id is
/// `""` would refuse a shift nobody can otherwise open.
pub(crate) fn attribute_required(actor: &Actor, declared: &str) -> Result<String, String> {
    if declared.trim().is_empty() {
        Ok(actor.user_id.clone())
    } else {
        attribute(actor, Some(declared))
    }
}

/// Record a refused operation. Best-effort, like `auth::audit`.
///
/// A failure to record a refusal must not become a second, different error on
/// the operator's screen — they were refused, and that is what they need to be
/// told. A failure is printed instead, because the renderer cannot read this
/// table by design.
async fn record_denial(
    pool: &sqlx::SqlitePool,
    actor: &Actor,
    operation: Operation,
    role: Role,
) {
    let outcome = sqlx::query(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, operation, detail)
         VALUES (?, ?, ?, 'permission_denied', ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&actor.store_id)
    .bind(crate::auth::now_iso_for_audit())
    .bind(&actor.user_id)
    .bind(operation.audit_name())
    .bind(format!("refused for role `{}`", role.as_str()))
    .execute(pool)
    .await;

    if let Err(e) = outcome {
        eprintln!(
            "[authz] WARNING: could not record the refusal of `{}`: {e}",
            operation.audit_name()
        );
    }
}

/// Every operation, for the test matrix to enumerate.
///
/// Listed by hand so that adding an `Operation` and forgetting it here is
/// caught by `tests::authorization::the_matrix_covers_every_operation`, which
/// compares this against the enum's own count. A `strum`-style derive would
/// remove the duplication and also remove the check.
#[cfg(test)]
pub(crate) const ALL_OPERATIONS: &[Operation] = &[
    Operation::PostSale,
    Operation::PostSaleLargeDiscount,
    Operation::OpenShift,
    Operation::CloseOwnShift,
    Operation::CloseAnotherShift,
    Operation::DriverRemittance,
    Operation::PostCreditMemo,
    Operation::PostAdjustment,
    Operation::DriverLedgerAdjustment,
    Operation::SaveProduct,
    Operation::SaveProductCost,
    Operation::ProductBarcode,
    Operation::RecipeDraft,
    Operation::RecipeActivate,
    Operation::RecipeRetire,
    Operation::PostPurchase,
    Operation::SupplierPayment,
    Operation::SupplierSave,
    Operation::DriverSave,
    Operation::ExchangeRateSave,
    Operation::UserAdmin,
    Operation::ResetAnotherCredential,
    Operation::ReadCostAndMargin,
    Operation::ReadProfitReports,
    Operation::ReadAnotherShiftHistory,
    Operation::ReadAuthAudit,
];

#[cfg(test)]
pub(crate) const ALL_ROLES: &[Role] = &[Role::Owner, Role::Manager, Role::Cashier];
