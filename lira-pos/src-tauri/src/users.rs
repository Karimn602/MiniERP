//! STAFF ADMINISTRATION — Gate 2B, Stage B.3.
//!
//! WHY THIS MODULE HAD TO EXIST BEFORE STAFF COULD SIGN IN
//!
//! Stages A.1 and B gave Greaz a credential, a session, a permission matrix and
//! trustworthy attribution — and `LOGIN_RESTRICTED_TO_OWNER` stayed `true`
//! throughout, because none of that makes a staff account USABLE. A manager or
//! cashier row carried no credential and there was no command to give it one,
//! so flipping the restriction on its own would have offered a login screen
//! that nobody but the owner could get through. This module is the missing
//! half: the owner creates the account, sets its first passphrase, and the
//! person can then sign in as themselves.
//!
//! `users` HAS BEEN A TABLE NOTHING OWNED
//!
//! Migration 001 created it and seeded one owner. Until now nothing in the
//! application wrote to it — `save_product` and the admin commands cannot, and
//! the renderer has had no SQL channel since Gate 2A — so the only way a shop
//! acquired a second member of staff was somebody editing the database file.
//! These three commands are the supported way, and they are owner-only.
//!
//! EVERYTHING HERE IS OWNER-ONLY, AND THE CREDENTIAL RESET IS WHY
//!
//! `authz::permits` gives `UserAdmin` and `ResetAnotherCredential` to the owner
//! alone, resolved conservatively where the Gate 2 design's own sections
//! disagreed about manager resets. The reason is narrow and decisive: a manager
//! who can set a cashier's passphrase can SIGN IN AS THAT CASHIER, and every
//! posted document would then name the cashier for something the manager did.
//! That would undo the one thing Stage B exists to establish. If a shop wants
//! manager resets later, it is a deliberate change to one line of the matrix
//! plus an audit row naming the manager — not a convenience to be added
//! quietly.
//!
//! WHAT IT STILL DOES NOT DO, said plainly
//!
//! Nothing here encrypts anything, and a person with the database file can give
//! themselves an owner account whatever these commands refuse. The honest claim
//! is unchanged: Greaz enforces who may do what INSIDE the application and
//! records who did it. The deployment checklist — a separate non-administrator
//! Windows account for the till, a password on it, screen lock, BitLocker — is
//! what addresses the file, and it is worth more than this module.

use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::auth::{Actor, Role};
use crate::authz::{self, Operation};
use crate::posting::DbState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSaveArgs {
    /// The caller mints this once for a new member of staff and reuses it to
    /// edit them, the same identity discipline every document here follows.
    pub user_id: String,
    pub full_name: String,
    /// `owner` | `manager` | `cashier`. Validated against the stored
    /// vocabulary, never trusted as a label.
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSetActiveArgs {
    pub user_id: String,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUserCredentialArgs {
    pub user_id: String,
    /// The first or replacement secret. Held to the same strength rule the
    /// person's own role would be held to, and the account is flagged to change
    /// it at next sign-in.
    pub secret: String,
}

/// A staff member as the Users screen shows them.
///
/// Carries no credential, no hash, no attempt count and no lockout state. The
/// owner needs to know who exists, what they may do, and whether they can sign
/// in yet; how close somebody is to a lockout is not administration, it is the
/// security log, and that is read through its own owner-only path.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffView {
    pub user_id: String,
    pub full_name: String,
    pub role: Role,
    pub active: bool,
    pub has_credential: bool,
    pub must_change_credential: bool,
    /// True for the signed-in owner's own row, so the screen can stop them
    /// retiring or demoting themselves by accident.
    pub is_you: bool,
}

// ===========================================================================
// Rules
// ===========================================================================

/// A name somebody will read off a shift report.
fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("A staff member needs a name.".to_string());
    }
    if name.chars().count() > 120 {
        return Err("That name is too long.".to_string());
    }
    Ok(name.to_string())
}

/// THE SHOP MUST KEEP AT LEAST ONE OWNER WHO CAN ACTUALLY SIGN IN, and this is
/// refused by the command rather than hidden by the screen.
///
/// An application with no owner cannot be administered: nothing could create a
/// user, reset a credential or change a role, and the enrollment ceremony is
/// terminal so it cannot be re-run. The only way back would be the support
/// reset — somebody editing the database file — which is the route this whole
/// gate exists to make unnecessary.
///
/// **`pin_hash IS NOT NULL` is part of the count, and leaving it out was a real
/// hole** (independent review of Stage B.3). A new account is created WITHOUT a
/// credential, deliberately: the owner sets one afterwards, and the Users
/// screen marks the account as unable to sign in until they do. So counting
/// every active owner ROW meant the one supported way to hand a shop over was
/// also the way to lose it. Create a second owner, demote yourself in the next
/// click, and the shop is left with an "active owner" nobody has given a
/// passphrase to and nobody left who could give them one: every command
/// refuses, the enrollment ceremony is terminal and cannot be re-run, and the
/// only route back is somebody editing the database file.
///
/// An owner who cannot sign in cannot administer anything, so this rule counts
/// the owners who can. The cost is one extra step in a hand-over, in the right
/// order: make them an owner, GIVE THEM A PASSPHRASE, then step down.
///
/// Counted inside the caller's transaction, because it is a decision about the
/// state the transaction is about to commit.
async fn require_another_usable_owner_remains(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    store_id: &str,
    about_to_change: &str,
) -> Result<(), String> {
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users
          WHERE store_id = ? AND role = 'owner' AND active = 1
            AND pin_hash IS NOT NULL AND id <> ?",
    )
    .bind(store_id)
    .bind(about_to_change)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| format!("cannot count the shop's owners: {e}"))?;

    if remaining > 0 {
        Ok(())
    } else {
        Err(
            "This is the shop's only owner who can sign in. Make somebody else an owner \
             AND give them a passphrase first — an owner with no passphrase cannot sign \
             in, so leaving only one of those would mean nobody could add staff, reset a \
             passphrase or change a role, and getting back in would need support to edit \
             the database file directly. Nothing has been changed."
                .to_string(),
        )
    }
}

/// HOW STRONG A SECRET THAT ROLE'S ACCOUNT MUST HAVE.
///
/// `auth.rs::check_secret_strength` holds two different rules: an owner or a
/// manager needs a passphrase of at least ten characters that is not all
/// digits; a cashier needs six characters, which in practice is a PIN. The rule
/// is applied when a secret is SET, and a role change happens afterwards.
fn credential_tier(role: Role) -> u8 {
    match role {
        Role::Cashier => 0,
        // Both can see and change figures a cashier cannot, and both are held
        // to the passphrase rule rather than the PIN rule.
        Role::Manager | Role::Owner => 1,
    }
}

/// The staff member this command is about, read from the database.
struct Subject {
    role: Role,
    active: bool,
    has_credential: bool,
    /// The name on file BEFORE this command, so a rename can record both
    /// values. A log saying "renamed" without the old name answers nothing.
    full_name: String,
}

async fn load_subject(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    store_id: &str,
    user_id: &str,
) -> Result<Option<Subject>, String> {
    let row = sqlx::query(
        "SELECT role, active, full_name, pin_hash IS NOT NULL AS has_credential
           FROM users WHERE id = ? AND store_id = ?",
    )
    .bind(user_id)
    .bind(store_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("cannot read the staff member: {e}"))?;

    let Some(row) = row else { return Ok(None) };
    let role_text: String = row
        .try_get("role")
        .map_err(|e| format!("cannot read the stored role: {e}"))?;

    Ok(Some(Subject {
        role: Role::from_db(&role_text)?,
        active: row.try_get::<i64, _>("active").unwrap_or(0) == 1,
        has_credential: row.try_get::<i64, _>("has_credential").unwrap_or(0) == 1,
        full_name: row
            .try_get("full_name")
            .map_err(|e| format!("cannot read the stored name: {e}"))?,
    }))
}

// ===========================================================================
// The implementations
// ===========================================================================

/// Create a member of staff, or change their name or role.
///
/// The store is the ACTOR's, never the request's: an owner administers their own
/// shop and there is no field through which they could administer another.
pub(crate) async fn users_save_as(
    pool: &SqlitePool,
    actor: &Actor,
    args: UserSaveArgs,
) -> Result<String, String> {
    let user_id = args.user_id.trim().to_string();
    if user_id.is_empty() {
        return Err("A staff member needs an identity.".to_string());
    }
    let full_name = clean_name(&args.full_name)?;
    // Parsed through the same function that parses a STORED role, so the
    // vocabulary cannot drift between what may be written and what may be read.
    let role = Role::from_db(args.role.trim()).map_err(|_| {
        "A staff member is an owner, a manager or a cashier. Nothing has been changed."
            .to_string()
    })?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin the staff transaction: {e}"))?;
    authz::authorize_tx(&mut tx, actor, Operation::UserAdmin).await?;

    let existing = load_subject(&mut tx, &actor.store_id, &user_id).await?;
    let created = existing.is_none();
    let previous_name = existing
        .as_ref()
        .map(|s| s.full_name.clone())
        .unwrap_or_default();

    match &existing {
        None => {
            // A NEW member of staff has no credential, so they cannot sign in
            // until the owner sets one. That is the deliberate order: the
            // account exists, is visible on the Users screen, and is marked as
            // unable to sign in — rather than being created with a passphrase
            // the owner then has to communicate.
            sqlx::query(
                "INSERT INTO users (id, store_id, full_name, role) VALUES (?, ?, ?, ?)",
            )
            .bind(&user_id)
            .bind(&actor.store_id)
            .bind(&full_name)
            .bind(role.as_str())
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("cannot create the staff member: {e}"))?;
        }
        Some(subject) => {
            // DEMOTING OR RETIRING THE LAST OWNER WHO CAN SIGN IN IS REFUSED.
            if subject.role == Role::Owner && subject.active && role != Role::Owner {
                require_another_usable_owner_remains(&mut tx, &actor.store_id, &user_id)
                    .await?;
            }

            // A PROMOTION OUT OF THE CASHIER TIER RETIRES THE OLD SECRET
            // (independent review of Stage B.3).
            //
            // The strength rule is applied when a secret is SET, against the
            // role the account had AT THAT MOMENT. A cashier may legitimately
            // be given `123456`. Promote them and that six-digit PIN became a
            // manager's or an owner's credential, below both halves of the rule
            // those roles are held to -- ten characters and not all digits --
            // and nothing would ever have re-examined it. The quiet version of
            // this is the dangerous one: an owner promoting their most trusted
            // cashier would have no reason to suspect the account they just
            // created is the weakest one in the shop.
            //
            // The stored value is an Argon2id hash, so the old secret cannot be
            // re-tested against the new rule -- that is the whole point of
            // storing it that way. There is therefore no honest way to KEEP it,
            // and it is cleared in the same statement that changes the role: one
            // transaction, so there is no instant at which the stronger role
            // holds the weaker secret. The account then reads "No passphrase
            // yet" on the Users screen, with Set passphrase beside it, and the
            // owner is already there.
            //
            // A DEMOTION keeps the credential: a passphrase already satisfies
            // the PIN rule, and clearing it would lock somebody out of the till
            // to no purpose.
            let retire_secret = subject.has_credential
                && credential_tier(role) > credential_tier(subject.role);

            if retire_secret {
                sqlx::query(
                    "UPDATE users
                        SET full_name = ?, role = ?,
                            pin_hash = NULL, credential_algo = NULL,
                            credential_version = NULL, credential_set_at = NULL,
                            must_change_pin = 0,
                            failed_attempts = 0, locked_until = NULL
                      WHERE id = ? AND store_id = ?",
                )
                .bind(&full_name)
                .bind(role.as_str())
                .bind(&user_id)
                .bind(&actor.store_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("cannot update the staff member: {e}"))?;
            } else {
                sqlx::query(
                    "UPDATE users SET full_name = ?, role = ? WHERE id = ? AND store_id = ?",
                )
                .bind(&full_name)
                .bind(role.as_str())
                .bind(&user_id)
                .bind(&actor.store_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("cannot update the staff member: {e}"))?;
            }
        }
    }

    // AUDITED IN THE TRANSACTION. Who may do what is the thing this gate
    // establishes, so a change to it that committed without a record would be
    // the one change nobody could account for. `audit_tx` fails the
    // transaction if it cannot be written.
    // A RENAME IS AUDITED TOO, and it is not a tidy-up (independent review of
    // Stage B.3).
    //
    // `users.full_name` is the name printed on every shift report and shown
    // beside every sale in Sales History, and those screens JOIN to the live row
    // rather than reading a snapshot. So editing it silently restates the
    // attribution on documents that are otherwise immutable — not the `user_id`
    // they are keyed on, but the name a person actually reads to say who did
    // something. The edit is allowed, because names change and a typo on the
    // first day should be fixable; what was missing is the trace. Both values
    // are recorded, since "renamed" without the old name answers nothing.
    //
    // Only a REAL change is recorded: saving the form without touching the name
    // writes no row, so the log does not fill with events that say nothing.
    let renamed_from = existing
        .as_ref()
        .map(|_| previous_name.as_str())
        .filter(|was| *was != full_name.as_str());

    if created {
        crate::auth::audit_tx_for_users(
            &mut tx,
            &actor.store_id,
            "user_created",
            Some(&user_id),
            Some(&actor.user_id),
            Some(&format!("created as {}", role.as_str())),
        )
        .await?;
    }

    if let Some(was) = renamed_from {
        crate::auth::audit_tx_for_users(
            &mut tx,
            &actor.store_id,
            "user_renamed",
            Some(&user_id),
            Some(&actor.user_id),
            Some(&format!("{was} -> {full_name}")),
        )
        .await?;
    }

    if !created && existing.as_ref().is_some_and(|s| s.role != role) {
        let was = existing.as_ref().map(|s| s.role.as_str()).unwrap_or("?");
        // The detail says if the secret went with the role. A log recording the
        // promotion but not the credential it retired would leave somebody
        // reading it later unable to explain why that person could not sign in.
        let detail = if existing
            .as_ref()
            .is_some_and(|s| s.has_credential && credential_tier(role) > credential_tier(s.role))
        {
            format!(
                "{was} -> {} (passphrase cleared: the old one was set under the                  weaker rule for a cashier and cannot be re-tested)",
                role.as_str()
            )
        } else {
            format!("{was} -> {}", role.as_str())
        };
        crate::auth::audit_tx_for_users(
            &mut tx,
            &actor.store_id,
            "role_changed",
            Some(&user_id),
            Some(&actor.user_id),
            Some(&detail),
        )
        .await?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the staff change: {e}"))?;
    Ok(user_id)
}

/// Retire a member of staff, or bring them back.
///
/// Retiring is the supported way to stop somebody using the till. Deleting is
/// not offered at all: a `users` row is referenced by every document that
/// person ever touched, and `active = 0` is how this schema has always said
/// "not usable" (`idx_users_store` is on `(store_id, active)` for exactly this).
/// Deleting one to tidy up would be destroying the attribution on real
/// financial records.
pub(crate) async fn users_set_active_as(
    pool: &SqlitePool,
    actor: &Actor,
    args: UserSetActiveArgs,
) -> Result<(), String> {
    let user_id = args.user_id.trim().to_string();
    if user_id.is_empty() {
        return Err("A staff member needs an identity.".to_string());
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin the staff transaction: {e}"))?;
    authz::authorize_tx(&mut tx, actor, Operation::UserAdmin).await?;

    let Some(subject) = load_subject(&mut tx, &actor.store_id, &user_id).await? else {
        return Err("That staff member is not in this shop.".to_string());
    };

    if !args.is_active {
        if user_id == actor.user_id {
            return Err(
                "You cannot retire your own account while you are signed in to it. \
                 Nothing has been changed."
                    .to_string(),
            );
        }
        if subject.role == Role::Owner && subject.active {
            require_another_usable_owner_remains(&mut tx, &actor.store_id, &user_id).await?;
        }
    }

    sqlx::query("UPDATE users SET active = ? WHERE id = ? AND store_id = ?")
        .bind(i64::from(args.is_active))
        .bind(&user_id)
        .bind(&actor.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot change the staff member: {e}"))?;

    // BOTH DIRECTIONS ARE AUDITED, and the second one was the P1 (independent
    // review of Stage B.3).
    //
    // `user_deactivated` records that somebody's access was TAKEN AWAY. With no
    // counterpart, access could be GIVEN BACK and the log would say only that it
    // had once been removed — an owner reading it six months later would see a
    // cashier retired in March and nothing to indicate they were ringing sales
    // again in April. Nothing else could have told them: `users.active` holds
    // today's value and keeps no history, and the sales themselves show the work
    // without showing who authorised the return to it. Restoring a till account
    // is a grant of access, and a grant of access that leaves no trace is the
    // one event an audit log cannot afford to be missing.
    //
    // Only a real transition is recorded. Re-saving the state the account is
    // already in writes nothing, so the log stays a list of changes rather than
    // of clicks.
    if subject.active != args.is_active {
        crate::auth::audit_tx_for_users(
            &mut tx,
            &actor.store_id,
            if args.is_active {
                "user_activated"
            } else {
                "user_deactivated"
            },
            Some(&user_id),
            Some(&actor.user_id),
            None,
        )
        .await?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the staff change: {e}"))?;
    Ok(())
}

/// Set or reset a member of staff's passphrase.
///
/// The account is flagged `must_change_pin`, so the person is told to change it
/// once they are in. That matters because the owner necessarily KNOWS this
/// secret — they just typed it and have to communicate it — so it is a
/// temporary credential by construction, not a password. The flag is a prompt
/// and not a gate: blocking the till until somebody changes a passphrase at
/// eight in the morning is how a shop ends up sharing one account.
///
/// Refuses the owner's OWN row. Changing your own passphrase requires the
/// current one (`auth_change_credential`), and allowing it here would turn
/// "reset somebody else's" into a way to skip that.
pub(crate) async fn set_user_credential_as(
    pool: &SqlitePool,
    actor: &Actor,
    args: SetUserCredentialArgs,
) -> Result<(), String> {
    let user_id = args.user_id.trim().to_string();
    if user_id.is_empty() {
        return Err("A staff member needs an identity.".to_string());
    }
    if user_id == actor.user_id {
        return Err(
            "Use Change passphrase for your own account — it asks for your current one. \
             Nothing has been changed."
                .to_string(),
        );
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin the credential transaction: {e}"))?;
    authz::authorize_tx(&mut tx, actor, Operation::ResetAnotherCredential).await?;

    let Some(subject) = load_subject(&mut tx, &actor.store_id, &user_id).await? else {
        return Err("That staff member is not in this shop.".to_string());
    };
    if !subject.active {
        return Err(
            "That account is retired. Bring it back first if they are returning to work. \
             Nothing has been changed."
                .to_string(),
        );
    }

    // HELD TO THE STRENGTH RULE OF THEIR OWN ROLE, not the owner's: a manager
    // needs a passphrase, a cashier a PIN of at least six. The rule lives in
    // one place and is applied here through it.
    crate::auth::check_secret_strength_for_role(subject.role, &args.secret)?;
    let hash = crate::auth::hash_secret_for_admin(&args.secret)?;

    sqlx::query(
        "UPDATE users
            SET pin_hash = ?, credential_algo = 'argon2id', credential_version = ?,
                credential_set_at = ?, must_change_pin = 1,
                failed_attempts = 0, locked_until = NULL
          WHERE id = ? AND store_id = ?",
    )
    .bind(&hash)
    .bind(crate::auth::credential_version_for_admin())
    .bind(crate::auth::now_iso_for_audit())
    .bind(&user_id)
    .bind(&actor.store_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot set the passphrase: {e}"))?;

    crate::auth::audit_tx_for_users(
        &mut tx,
        &actor.store_id,
        if subject.has_credential {
            "credential_reset"
        } else {
            "credential_set"
        },
        Some(&user_id),
        Some(&actor.user_id),
        None,
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the passphrase: {e}"))?;
    Ok(())
}

/// Who works here. Owner-only, like everything else in this module.
///
/// THE SEAM AUTHORIZES TOO (independent review of Stage B.3). The command
/// wrapper already does, and nothing but the wrapper reaches this in
/// production -- but the module says "owner-only, like everything else", and a
/// read seam that takes any `Actor` and answers did not say that. The next
/// caller inside this crate is the problem: this returns every account's name,
/// role and whether it has a credential, which is a map of the shop's
/// administration, and `authorize` is one line.
///
/// It is the BOUNDARY check rather than `authorize_tx`, because a read opens no
/// transaction: there is nothing here for a check to be inside of, and opening
/// one just to hold a check would make a plain list a writer's shape. The
/// boundary check is also the one that writes the durable `permission_denied`
/// row.
pub(crate) async fn users_list_as(
    pool: &SqlitePool,
    actor: &Actor,
) -> Result<Vec<StaffView>, String> {
    authz::authorize(pool, actor, Operation::UserAdmin).await?;

    let rows = sqlx::query(
        "SELECT id, full_name, role, active,
                pin_hash IS NOT NULL AS has_credential, must_change_pin
           FROM users
          WHERE store_id = ?
          ORDER BY active DESC,
                   CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                   full_name ASC",
    )
    .bind(&actor.store_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("cannot list the staff: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let role_text: String = row.try_get("role").map_err(|e| format!("role: {e}"))?;
        let user_id: String = row.try_get("id").map_err(|e| format!("id: {e}"))?;
        out.push(StaffView {
            is_you: user_id == actor.user_id,
            user_id,
            full_name: row
                .try_get("full_name")
                .map_err(|e| format!("full_name: {e}"))?,
            role: Role::from_db(&role_text)?,
            active: row.try_get::<i64, _>("active").unwrap_or(0) == 1,
            has_credential: row.try_get::<i64, _>("has_credential").unwrap_or(0) == 1,
            must_change_credential: row.try_get::<i64, _>("must_change_pin").unwrap_or(0) == 1,
        });
    }
    Ok(out)
}

// ===========================================================================
// The command surface — thin, like `auth.rs`'s
// ===========================================================================

#[tauri::command]
pub async fn users_list(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
) -> Result<Vec<StaffView>, String> {
    let (pool, actor) = authz::begin(&app, &window, &state, Operation::UserAdmin).await?;
    users_list_as(&pool, &actor).await
}

#[tauri::command]
pub async fn users_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: UserSaveArgs,
) -> Result<String, String> {
    let (pool, actor) = authz::begin(&app, &window, &state, Operation::UserAdmin).await?;
    users_save_as(&pool, &actor, args).await
}

#[tauri::command]
pub async fn users_set_active(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: UserSetActiveArgs,
) -> Result<(), String> {
    let (pool, actor) = authz::begin(&app, &window, &state, Operation::UserAdmin).await?;
    users_set_active_as(&pool, &actor, args).await
}

#[tauri::command]
pub async fn users_set_credential(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    args: SetUserCredentialArgs,
) -> Result<(), String> {
    let (pool, actor) =
        authz::begin(&app, &window, &state, Operation::ResetAnotherCredential).await?;
    set_user_credential_as(&pool, &actor, args).await
}
