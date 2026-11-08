//! Master-data writes that used to happen directly from TypeScript.
//!
//! Gate 2A moved seven `execute()` statements out of the renderer and into this
//! module. They are grouped here rather than in `posting.rs` because none of
//! them is a financial document: no number sequence, no inventory movement, no
//! ledger entry, no idempotency identity. They are reference rows that
//! documents point AT.
//!
//! WHY THEY HAD TO MOVE AT ALL
//!
//! Two of the seven are the reason this whole gate exists. `post_sale` proves a
//! sale's locked LBP rate against the `exchange_rates` row for its store before
//! it writes anything — a real control, and the only thing standing between a
//! lira tender and an invented rate. But the renderer could WRITE that row. The
//! validator and the figure it validates against sat on the same side of the
//! boundary, so anyone at the till could set a favourable rate, ring a lira
//! tender against it, and pass every check in the application. That is the one
//! path by which direct frontend SQL reached a POSTED financial figure.
//!
//! The driver and supplier writes are a smaller version of the same problem:
//! `drivers.is_active` decides whether a new delivery order may name a driver,
//! and both tables are referenced `RESTRICT` by ledgers and posted documents.
//!
//! WHAT THIS MODULE IS NOT
//!
//! It is not authorization. There is still no login, no session and no role
//! check, so these commands may be called by anything running in the renderer,
//! exactly as before. What has changed is that the SET of possible writes is
//! now finite and named, each one validates its input, and none of them can be
//! turned into `UPDATE sales SET total_incl_vat_cents = 0`. Permissions are
//! Gate 2 Stage 3 and will be added here as one `authorize()` call per command.
//!
//! Error strings are returned as stable UPPER_SNAKE codes wherever the UI needs
//! to say something specific, so `src/locales/{en,ar}.ts` can translate them;
//! anything unexpected comes back as prose for the console. The codes are
//! listed in `src/db/repos/*.ts` beside the call that can raise them.

use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

//  is no longer imported here: since Stage B every command
// reaches the database through `authz::begin`, which runs the startup gate, the
// session gate, the window check and the authorization in one place. Nothing in
// this module may open a pool on its own, and
// `tests::authorization::the_command_boundary_is_the_only_route_to_a_pool`
// asserts that for the whole crate.
use crate::posting::DbState;

/// `YYYY-MM-DD`, the shape `exchange_rates.effective_date` holds and the one
/// `findApplicableOn` compares with `<=`. Validated rather than trusted: a
/// malformed date would sort wrongly and silently stop applying.
fn valid_effective_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let num = |a: usize, z: usize| s[a..z].parse::<u32>().unwrap_or(0);
    let (y, m, d) = (num(0, 4), num(5, 7), num(8, 10));
    if y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31 {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if leap {
                29
            } else {
                28
            }
        }
    };
    d <= max
}

/// `valid_effective_date` under a test-only name, so `tests::admin_commands`
/// can assert the calendar rules without making the helper public.
#[cfg(test)]
pub(crate) fn valid_effective_date_for_tests(s: &str) -> bool {
    valid_effective_date(s)
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

// ============================================================================
// Exchange rates
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRateSaveArgs {
    /// The id to use if a row has to be INSERTed. Minted by the caller so the
    /// command needs no uuid dependency, and ignored on the update path, where
    /// the existing row keeps its own id.
    pub id: String,
    pub store_id: String,
    pub effective_date: String,
    pub rate_lbp_per_usd: i64,
    pub source: Option<String>,
    pub notes: Option<String>,
    pub created_by_user_id: Option<String>,
}

/// Upsert the rate for one `(store, effective_date)`, in ONE transaction.
///
/// Replaces `exchangeRates.ts::upsert`, which did a SELECT and then an
/// UPDATE-or-INSERT as three separate round trips through the SQL plugin's
/// connection pool. Two tills — or two clicks — could interleave between the
/// SELECT and the INSERT and race on `ux_exchange_rates_store_date`, with the
/// loser surfacing a raw constraint error. Holding it in one transaction and
/// resolving the existing row inside that transaction is what makes the upsert
/// actually an upsert.
///
/// The rate is NOT retroactive and this command does not pretend otherwise:
/// `sales.exchange_rate_id` plus `sales.exchange_rate_lbp_per_usd` freeze the
/// rate each sale was posted at, so editing today's rate changes what the NEXT
/// sale locks and restates nothing already posted. That is the same
/// forward-only rule every cost input here follows.
#[tauri::command]
pub async fn exchange_rate_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: ExchangeRateSaveArgs,
) -> Result<String, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::ExchangeRateSave,
    )
    .await?;
    exchange_rate_save_as(&pool, &actor, args).await
}

/// The pre-authorization seam, extracted so the administrative commands can
/// be DRIVEN BY A TEST with an actor of its own choosing.
///
/// This also closes a Gate 2A P2 that has been outstanding since the
/// commands were written: they had no `*_with_pool` sibling, so
/// `tests::admin_commands` re-implemented their SQL instead of calling them,
/// and a test that re-implements the thing it is testing proves only that
/// two copies of a statement agree. Independent review of Stage B asked for
/// behavioural cross-store tests and could not have them without this.
///
/// The command above is now thin: window, gates, actor, authorize, delegate.
pub(crate) async fn exchange_rate_save_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    args: ExchangeRateSaveArgs,
) -> Result<String, String> {
    // Integer lira per dollar, strictly positive. `post_sale` divides by this
    // when converting a lira tender, so zero or negative is not a bad figure,
    // it is an arithmetic fault waiting to happen.
    if args.rate_lbp_per_usd <= 0 {
        return Err("EXCHANGE_RATE_MUST_BE_POSITIVE".into());
    }
    if args.rate_lbp_per_usd > 100_000_000 {
        return Err("EXCHANGE_RATE_OUT_OF_RANGE".into());
    }
    if !valid_effective_date(&args.effective_date) {
        return Err("EXCHANGE_RATE_BAD_EFFECTIVE_DATE".into());
    }
    let source = clean_opt(args.source).unwrap_or_else(|| "manual".to_string());
    if !matches!(source.as_str(), "manual" | "api" | "imported") {
        return Err("EXCHANGE_RATE_BAD_SOURCE".into());
    }
    let notes = clean_opt(args.notes);

    let actor_user_id =
        crate::authz::attribute(&actor, args.created_by_user_id.as_deref())?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin exchange-rate transaction: {e}"))?;
    // ---- Authorization, INSIDE the transaction (GZ-B-P2) ----
    //
    // The boundary check ran before this transaction opened, and a role can
    // change in between — so the decision that has to hold at COMMIT is read
    // inside the transaction that commits, as it is for every posting
    // command. Without this an administrator demoted mid-request could still
    // commit a change to the exchange rate, a driver or a supplier.
    crate::authz::authorize_tx(&mut tx, &actor, crate::authz::Operation::ExchangeRateSave).await?;


    // The store must exist. Without this an unknown store_id is either a
    // foreign-key error the operator cannot read, or — worse, if the FK is ever
    // relaxed — a rate nobody can see because no screen queries that store.
    let store_exists: i64 =
        sqlx::query("SELECT COUNT(*) AS n FROM stores WHERE id = ?")
            .bind(&args.store_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("cannot check store: {e}"))?
            .try_get("n")
            .map_err(|e| format!("cannot decode store count: {e}"))?;
    if store_exists == 0 {
        return Err("UNKNOWN_STORE".into());
    }

    // AND IT MUST BE THE ACTOR'S OWN SHOP (GZ-B-R2-P2). The rate is the one
    // setting that reaches a posted figure — `post_sale` validates a lira
    // tender against this row — so a manager of one branch setting another
    // branch's rate would decide what a lira is worth in a shop they have no
    // claim on.
    crate::authz::require_same_store(&actor, &args.store_id)?;

    let existing: Option<String> = sqlx::query(
        "SELECT id FROM exchange_rates WHERE store_id = ? AND effective_date = ?",
    )
    .bind(&args.store_id)
    .bind(&args.effective_date)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("cannot read the existing rate: {e}"))?
    .map(|r| r.try_get::<String, _>("id"))
    .transpose()
    .map_err(|e| format!("cannot decode the existing rate id: {e}"))?;

    let id = match existing {
        Some(existing_id) => {
            sqlx::query(
                "UPDATE exchange_rates
                    SET rate_lbp_per_usd = ?, source = ?, notes = ?
                  WHERE id = ?",
            )
            .bind(args.rate_lbp_per_usd)
            .bind(&source)
            .bind(&notes)
            .bind(&existing_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("cannot update the rate: {e}"))?;
            existing_id
        }
        None => {
            let id = args.id.trim().to_string();
            if id.is_empty() {
                return Err("EXCHANGE_RATE_MISSING_ID".into());
            }
            sqlx::query(
                "INSERT INTO exchange_rates
                   (id, store_id, effective_date, rate_lbp_per_usd, source, notes,
                    created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&args.store_id)
            .bind(&args.effective_date)
            .bind(args.rate_lbp_per_usd)
            .bind(&source)
            .bind(&notes)
            // The SESSION's actor, cross-checked against the declared one.
            // An exchange rate is the one setting that reaches a posted
            // figure - `post_sale` validates a lira tender against this
            // row - so who wrote it is worth recording truthfully.
            .bind(&actor_user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("cannot insert the rate: {e}"))?;
            id
        }
    };

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the exchange rate: {e}"))?;
    Ok(id)
}

// ============================================================================
// Drivers
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverSaveArgs {
    pub id: String,
    /// Required when creating. Ignored on update: a driver never moves store,
    /// because his ledger, his collections and the sales naming him are all
    /// scoped to one store and migration 015's triggers prove it per row.
    pub store_id: Option<String>,
    pub name: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
}

/// Create or rename a driver. Replaces `drivers.ts::create` and `::update`.
///
/// One command for both, resolved by whether the id already exists, so the
/// renderer cannot create a row under an id that belongs to another store's
/// driver by calling the wrong one.
///
/// STORE ISOLATION. On create the store must exist and is taken from the
/// payload. On update `store_id` is deliberately NOT written: migration 015
/// ties a `driver_ledger` row, a delivery sale's `driver_id` and the driver's
/// own store together, and moving a driver between stores afterwards would
/// leave a balance filed against one branch and the receipts behind it against
/// another. There is no supported way to do it and this command does not offer
/// one.
#[tauri::command]
pub async fn driver_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: DriverSaveArgs,
) -> Result<String, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::DriverSave,
    )
    .await?;
    driver_save_as(&pool, &actor, args).await
}

/// The pre-authorization seam, extracted so the administrative commands can
/// be DRIVEN BY A TEST with an actor of its own choosing.
///
/// This also closes a Gate 2A P2 that has been outstanding since the
/// commands were written: they had no `*_with_pool` sibling, so
/// `tests::admin_commands` re-implemented their SQL instead of calling them,
/// and a test that re-implements the thing it is testing proves only that
/// two copies of a statement agree. Independent review of Stage B asked for
/// behavioural cross-store tests and could not have them without this.
///
/// The command above is now thin: window, gates, actor, authorize, delegate.
pub(crate) async fn driver_save_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    args: DriverSaveArgs,
) -> Result<String, String> {
    let id = args.id.trim().to_string();
    if id.is_empty() {
        return Err("DRIVER_MISSING_ID".into());
    }
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("DRIVER_NAME_REQUIRED".into());
    }
    if name.chars().count() > 120 {
        return Err("DRIVER_NAME_TOO_LONG".into());
    }
    let phone = clean_opt(args.phone);
    let notes = clean_opt(args.notes);

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin driver transaction: {e}"))?;
    // ---- Authorization, INSIDE the transaction (GZ-B-P2) ----
    //
    // The boundary check ran before this transaction opened, and a role can
    // change in between — so the decision that has to hold at COMMIT is read
    // inside the transaction that commits, as it is for every posting
    // command. Without this an administrator demoted mid-request could still
    // commit a change to the exchange rate, a driver or a supplier.
    crate::authz::authorize_tx(&mut tx, &actor, crate::authz::Operation::DriverSave).await?;


    // SCOPED BY THE ACTOR'S OWN SHOP (GZ-B-R2-P2). Without this a manager of
    // one branch could rename another branch's driver: the id is globally
    // addressable and nothing compared the row's store with theirs. The PROBE is
    // scoped as well as the update, so the two branches stay consistent — an
    // out-of-shop id reads as "does not exist", and the create branch below
    // then refuses it on the store check rather than writing a duplicate.
    let existing: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM drivers WHERE id = ? AND store_id = ?",
    )
        .bind(&id)
        .bind(&actor.store_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("cannot check the driver: {e}"))?
        .try_get("n")
        .map_err(|e| format!("cannot decode the driver count: {e}"))?;

    if existing == 0 {
        let store_id = args
            .store_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("DRIVER_STORE_REQUIRED")?;
        let store_exists: i64 = sqlx::query("SELECT COUNT(*) AS n FROM stores WHERE id = ?")
            .bind(store_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("cannot check store: {e}"))?
            .try_get("n")
            .map_err(|e| format!("cannot decode store count: {e}"))?;
        if store_exists == 0 {
            return Err("UNKNOWN_STORE".into());
        }
        // AND IT MUST BE THE ACTOR'S OWN SHOP. A real store that is not
        // theirs is exactly the case the store check exists for: a manager may
        // add a driver or a supplier to their own branch and not to another.
        crate::authz::require_same_store(&actor, store_id)?;
        sqlx::query("INSERT INTO drivers (id, store_id, name, phone, notes) VALUES (?,?,?,?,?)")
            .bind(&id)
            .bind(store_id)
            .bind(&name)
            .bind(&phone)
            .bind(&notes)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("cannot insert the driver: {e}"))?;
    } else {
        sqlx::query(
            "UPDATE drivers
                SET name = ?, phone = ?, notes = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ? AND store_id = ?",
        )
        .bind(&name)
        .bind(&phone)
        .bind(&notes)
        .bind(&id)
        .bind(&actor.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot update the driver: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the driver: {e}"))?;
    Ok(id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverSetActiveArgs {
    pub id: String,
    pub is_active: bool,
}

/// Retire or reinstate a driver. Replaces `drivers.ts::setActive`.
///
/// Never a delete: his name is on posted receipts and on ledger rows, and the
/// foreign keys are RESTRICT so that is structural rather than a convention.
/// Retiring stops NEW orders naming him; it does not stop him settling old
/// ones, which is why `post_driver_remittance` still accepts a retired driver.
#[tauri::command]
pub async fn driver_set_active(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: DriverSetActiveArgs,
) -> Result<(), String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::DriverSave,
    )
    .await?;
    driver_set_active_as(&pool, &actor, args).await
}

/// The pre-authorization seam, extracted so the administrative commands can
/// be DRIVEN BY A TEST with an actor of its own choosing.
///
/// This also closes a Gate 2A P2 that has been outstanding since the
/// commands were written: they had no `*_with_pool` sibling, so
/// `tests::admin_commands` re-implemented their SQL instead of calling them,
/// and a test that re-implements the thing it is testing proves only that
/// two copies of a statement agree. Independent review of Stage B asked for
/// behavioural cross-store tests and could not have them without this.
///
/// The command above is now thin: window, gates, actor, authorize, delegate.
pub(crate) async fn driver_set_active_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    args: DriverSetActiveArgs,
) -> Result<(), String> {
    let id = args.id.trim().to_string();
    if id.is_empty() {
        return Err("DRIVER_MISSING_ID".into());
    }
    // SCOPED BY THE ACTOR'S OWN SHOP (GZ-B-P2). Nothing in the arguments
    // names a store, so without this a manager of one branch could retire
    // another branch's driver. Scoping the WHERE clause rather than
    // checking first is deliberate: the scoping IS the write, so there is no
    // window between the check and the update, and a row of another shop is
    // simply not found — which returns the refusal below and discloses
    // nothing about whether it exists elsewhere.
    // IN A TRANSACTION, so the authorization holds at COMMIT (GZ-B-R2-P2). The
    // boundary check ran before this statement; a manager demoted in between
    // would otherwise still retire a driver. One statement is atomic, but the
    // PERMISSION was not re-read, and that is what this transaction is for.
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin driver activation transaction: {e}"))?;
    crate::authz::authorize_tx(&mut tx, &actor, crate::authz::Operation::DriverSave).await?;

    let affected = sqlx::query(
        "UPDATE drivers
            SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND store_id = ?",
    )
    .bind(i64::from(args.is_active))
    .bind(&id)
    .bind(&actor.store_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot update the driver: {e}"))?
    .rows_affected();

    // Nothing matched: either no such driver, or one of another shop — and the
    // message is deliberately the same for both, because telling the caller
    // which it was would say whether a driver exists in a branch they have no
    // claim on. Returning before the commit rolls the transaction back.
    if affected == 0 {
        return Err("UNKNOWN_DRIVER".into());
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the driver activation: {e}"))?;
    Ok(())
}

// ============================================================================
// Suppliers
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierSaveArgs {
    pub id: String,
    pub store_id: Option<String>,
    pub name: String,
    pub contact_name: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub notes: Option<String>,
}

/// Create or rename a supplier. Replaces `suppliers.ts::create`.
///
/// Same create-or-update resolution and the same store rule as `driver_save`,
/// for the same reason: `supplier_ledger` is append-only and migration 010's
/// sign-discipline trigger also proves that an entry is filed against the
/// supplier's OWN store, so moving a supplier between stores would strand a
/// payable.
#[tauri::command]
pub async fn supplier_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: SupplierSaveArgs,
) -> Result<String, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::SupplierSave,
    )
    .await?;
    supplier_save_as(&pool, &actor, args).await
}

/// The pre-authorization seam, extracted so the administrative commands can
/// be DRIVEN BY A TEST with an actor of its own choosing.
///
/// This also closes a Gate 2A P2 that has been outstanding since the
/// commands were written: they had no `*_with_pool` sibling, so
/// `tests::admin_commands` re-implemented their SQL instead of calling them,
/// and a test that re-implements the thing it is testing proves only that
/// two copies of a statement agree. Independent review of Stage B asked for
/// behavioural cross-store tests and could not have them without this.
///
/// The command above is now thin: window, gates, actor, authorize, delegate.
pub(crate) async fn supplier_save_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    args: SupplierSaveArgs,
) -> Result<String, String> {
    let id = args.id.trim().to_string();
    if id.is_empty() {
        return Err("SUPPLIER_MISSING_ID".into());
    }
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("SUPPLIER_NAME_REQUIRED".into());
    }
    if name.chars().count() > 160 {
        return Err("SUPPLIER_NAME_TOO_LONG".into());
    }
    let contact = clean_opt(args.contact_name);
    let phone = clean_opt(args.phone);
    let email = clean_opt(args.email);
    let notes = clean_opt(args.notes);

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin supplier transaction: {e}"))?;
    // ---- Authorization, INSIDE the transaction (GZ-B-P2) ----
    //
    // The boundary check ran before this transaction opened, and a role can
    // change in between — so the decision that has to hold at COMMIT is read
    // inside the transaction that commits, as it is for every posting
    // command. Without this an administrator demoted mid-request could still
    // commit a change to the exchange rate, a driver or a supplier.
    crate::authz::authorize_tx(&mut tx, &actor, crate::authz::Operation::SupplierSave).await?;


    // Scoped by the actor's own shop, for the reason given on `driver_save`.
    let existing: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM suppliers WHERE id = ? AND store_id = ?",
    )
        .bind(&id)
        .bind(&actor.store_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("cannot check the supplier: {e}"))?
        .try_get("n")
        .map_err(|e| format!("cannot decode the supplier count: {e}"))?;

    if existing == 0 {
        let store_id = args
            .store_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("SUPPLIER_STORE_REQUIRED")?;
        let store_exists: i64 = sqlx::query("SELECT COUNT(*) AS n FROM stores WHERE id = ?")
            .bind(store_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("cannot check store: {e}"))?
            .try_get("n")
            .map_err(|e| format!("cannot decode store count: {e}"))?;
        if store_exists == 0 {
            return Err("UNKNOWN_STORE".into());
        }
        // AND IT MUST BE THE ACTOR'S OWN SHOP. A real store that is not
        // theirs is exactly the case the store check exists for: a manager may
        // add a driver or a supplier to their own branch and not to another.
        crate::authz::require_same_store(&actor, store_id)?;
        sqlx::query(
            "INSERT INTO suppliers
               (id, store_id, name, contact_name, phone, email, notes)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(store_id)
        .bind(&name)
        .bind(&contact)
        .bind(&phone)
        .bind(&email)
        .bind(&notes)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot insert the supplier: {e}"))?;
    } else {
        sqlx::query(
            "UPDATE suppliers
                SET name = ?, contact_name = ?, phone = ?, email = ?, notes = ?
              WHERE id = ? AND store_id = ?",
        )
        .bind(&name)
        .bind(&contact)
        .bind(&phone)
        .bind(&email)
        .bind(&notes)
        .bind(&id)
        .bind(&actor.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot update the supplier: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the supplier: {e}"))?;
    Ok(id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierSetActiveArgs {
    pub id: String,
    pub is_active: bool,
}

/// Deactivate or reinstate a supplier. Replaces `suppliers.ts::setActive`.
#[tauri::command]
pub async fn supplier_set_active(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: SupplierSetActiveArgs,
) -> Result<(), String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::SupplierSave,
    )
    .await?;
    supplier_set_active_as(&pool, &actor, args).await
}

/// The pre-authorization seam, extracted so the administrative commands can
/// be DRIVEN BY A TEST with an actor of its own choosing.
///
/// This also closes a Gate 2A P2 that has been outstanding since the
/// commands were written: they had no `*_with_pool` sibling, so
/// `tests::admin_commands` re-implemented their SQL instead of calling them,
/// and a test that re-implements the thing it is testing proves only that
/// two copies of a statement agree. Independent review of Stage B asked for
/// behavioural cross-store tests and could not have them without this.
///
/// The command above is now thin: window, gates, actor, authorize, delegate.
pub(crate) async fn supplier_set_active_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    args: SupplierSetActiveArgs,
) -> Result<(), String> {
    let id = args.id.trim().to_string();
    if id.is_empty() {
        return Err("SUPPLIER_MISSING_ID".into());
    }
    // SCOPED BY THE ACTOR'S OWN SHOP (GZ-B-P2). Nothing in the arguments names
    // a store, so without this a manager of one branch could retire another
    // branch's supplier. Scoping the WHERE clause rather than checking first is
    // deliberate: the scoping IS the write, so there is no window between the
    // check and the update, and a row of another shop is simply not found —
    // which returns the refusal below and discloses nothing about whether it
    // exists elsewhere.
    // IN A TRANSACTION, so the authorization holds at COMMIT (GZ-B-R2-P2). The
    // boundary check ran before this statement; a manager demoted in between
    // would otherwise still retire a supplier. One statement is atomic, but the
    // PERMISSION was not re-read, and that is what this transaction is for.
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin supplier activation transaction: {e}"))?;
    crate::authz::authorize_tx(&mut tx, &actor, crate::authz::Operation::SupplierSave).await?;

    let affected = sqlx::query(
        "UPDATE suppliers SET is_active = ? WHERE id = ? AND store_id = ?",
    )
        .bind(i64::from(args.is_active))
        .bind(&id)
        .bind(&actor.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot update the supplier: {e}"))?
        .rows_affected();

    // Nothing matched: either no such supplier, or one of another shop — the
    // same message for both, because saying which would disclose whether it
    // exists in a branch the caller has no claim on. Returning before the
    // commit rolls the transaction back.
    if affected == 0 {
        return Err("UNKNOWN_SUPPLIER".into());
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the supplier activation: {e}"))?;
    Ok(())
}
