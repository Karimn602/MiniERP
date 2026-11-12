//! THE CONFIDENTIALITY BOUNDARY ON THE RENDERER'S READ POOL.
//!
//! WHY THIS MODULE EXISTS
//!
//! Gate 2A made the renderer structurally unable to WRITE: `db_select` runs
//! against a pool opened `read_only(true)`, so SQLite itself refuses every
//! mutation. What it did not do — and did not claim to do — is constrain what
//! the renderer may READ. `db_select` accepts arbitrary SELECT text, so any
//! column of any table is readable by anything running in the webview.
//!
//! That was tolerable while every column was business data. It stops being
//! tolerable the moment migration 023 puts an Argon2id credential hash and a
//! single-use owner recovery code in the same file. A login screen whose
//! password hashes can be read back out through the application's own read
//! channel is not a login screen; offline guessing against a hash is
//! unthrottled, and the recovery code is a direct route to owner.
//!
//! So the credential boundary has to exist BEFORE the credential does. This
//! module is that boundary, and it ships first.
//!
//! WHAT ENFORCES IT
//!
//! SQLite's own authorizer callback (`sqlite3_set_authorizer`), installed on
//! every physical connection of the renderer-facing read pool.
//!
//! The authorizer is the right mechanism for exactly one reason: **it runs
//! inside the statement compiler, on names SQLite has already resolved.** By
//! the time it is asked about a read, the engine has resolved `SELECT *` into
//! concrete columns, resolved aliases to their real tables, resolved a view to
//! the tables underneath it, resolved a CTE, resolved a correlated subquery,
//! and normalised identifier case and quoting. So a policy expressed as
//! "(table, column) may not be read" is enforced against every spelling of
//! every query that would read it — including spellings nobody has thought of.
//!
//! That property is why the alternative was rejected. A guard that inspects the
//! SQL TEXT — a keyword filter, a regular expression, a column-name blacklist —
//! has to re-implement SQLite's resolver to be correct, and is wrong the first
//! time somebody writes `SELECT u.* FROM users u`, or `WITH x AS (SELECT * FROM
//! users) SELECT * FROM x`, or `SELECT "PIN_HASH" FROM users`. A boundary that
//! is almost right is worse than none, because it reads as a boundary.
//!
//! WHAT IS LOAD BEARING, AND WHAT IS NOT
//!
//! Being exact about this is the existing `read_api` module's own discipline and
//! it is kept here:
//!
//!   1. **`sqlite3_set_authorizer` IS the confidentiality boundary.** There is
//!      no SQL statement that removes or replaces an authorizer — it is set
//!      through the C API only. The renderer has no C API. So a connection that
//!      carries this authorizer carries it for its whole life, whatever
//!      statements are sent to it afterwards.
//!   2. **`read_only(true)` remains the INTEGRITY boundary**, exactly as before.
//!      This module does not weaken it and does not replace it. Mutations are
//!      refused because the file handle cannot write, not because of anything
//!      here.
//!   3. **The install-time self-proof (below) is what makes claim 1 true in
//!      practice rather than in principle.** The return code of
//!      `sqlite3_set_authorizer` is checked, and then NOT trusted: the
//!      connection is made to demonstrate, on itself, that a protected read is
//!      refused and a permitted read is allowed, before it is handed to the
//!      pool. A connection that cannot prove both is discarded and the pool
//!      fails to open.
//!
//! SAFETY INVARIANTS OF THE ONE `unsafe` BLOCK
//!
//! The FFI surface here is deliberately the smallest it can be — one function
//! call and one callback — and every invariant is discharged by construction
//! rather than by discipline:
//!
//!   * **No captured state.** [`authorizer`] is a plain `extern "C" fn`, not a
//!     boxed closure, so `pUserData` is null and there is nothing to own, free,
//!     keep alive or outlive. The policy is a pair of `const` slices compiled
//!     into the binary. This removes the entire class of callback-lifetime bugs
//!     that a stateful authorizer would introduce.
//!   * **No panic can cross the boundary.** The callback performs null checks,
//!     `CStr` conversion with the failure case handled, and ASCII comparisons
//!     that allocate nothing. There is no indexing, no unwrap, no formatting and
//!     no allocation on any path, so there is no unwind to propagate into C.
//!   * **Pointer provenance.** The `sqlite3*` comes from sqlx's own
//!     `LockedSqliteHandle::as_raw_handle()` and is used only while that guard
//!     is alive, which is what the guard exists to promise: sqlx's background
//!     worker cannot be touching the connection concurrently.
//!   * **The string pointers are borrowed for the call only.** SQLite documents
//!     them as valid for the duration of the callback; nothing here keeps them.
//!
//! WHAT THIS DOES NOT DO
//!
//! It does not encrypt anything. Anybody who can run a program on this Windows
//! account can open the database file and read every byte this module hides —
//! including the credential hashes — and no in-application control changes that.
//! This is the T9 limit recorded in `dev/GATE2-SECURITY-DESIGN.md` §1, and it is
//! the reason the credential policy (Argon2id cost, lockout, passphrases for
//! owner and manager) is written for an attacker who may eventually hold the
//! file. What this module buys is that **the application's own read channel is
//! not that attacker's easiest route**, which is a real and necessary property
//! and is not the same as confidentiality.

use libsqlite3_sys as ffi;
use std::os::raw::{c_char, c_int, c_void};

/// Tables the renderer may not read AT ALL, in any database, under any alias.
///
/// Two groups, and the second one is the result of an independent review
/// finding that the first draft of this module got wrong.
///
/// **The credential stores.** `owner_recovery` holds the hash of the
/// single-use owner recovery code (migration 023). `auth_audit` (024) is an
/// owner-facing security log: it is specified never to contain a secret, and
/// that is asserted by its own test, but a log of who failed to log in and when
/// is still not register data. Both are reachable by trusted Rust through the
/// WRITE pool, which carries no authorizer.
///
/// Named here before migration 023 creates them, deliberately: the policy is by
/// NAME, so the boundary is in place before the secret exists. A table that is
/// not there yet is simply never asked about.
///
/// **The reflecting surfaces, and why they are a real hole rather than a
/// theoretical one.** `libsqlite3-sys 0.30.1` builds the amalgamation with
/// `-DSQLITE_ENABLE_DBSTAT_VTAB` and `-DSQLITE_ENABLE_STAT4` (its `build.rs`,
/// lines 126 and 134 — checked, not assumed). So `dbstat` exists on every
/// connection this application opens, and
///
/// ```text
///     SELECT sum(ncell) FROM dbstat WHERE name = 'owner_recovery'
/// ```
///
/// returns the row count of a table this policy claims is unreadable — along
/// with its page count and payload sizes, which leak how much is in it and when
/// it changed. The authorizer is asked about a read of `dbstat`, NOT about a
/// read of `owner_recovery`, so a policy that only names the protected table
/// allows it. The same trick reports `auth_audit` activity, which is a log of
/// failed logins: exactly the thing somebody probing a PIN wants to know is not
/// being watched. `sqlite_stat1`/`sqlite_stat4` are the same class — ANALYZE
/// writes row counts and sampled INDEX KEYS into them, and a sampled key of a
/// future index on a credential column would be the credential.
///
/// `sqlite_dbpage` and `sqlite_dbdata` are not compiled in today (no
/// `-DSQLITE_ENABLE_DBPAGE_VTAB` / `-DSQLITE_ENABLE_DBDATA`) and would be far
/// worse if they ever were — they serve raw page bytes, which is the whole file.
/// Denied by name now, at zero cost, so a dependency bump cannot open a hole
/// silently.
const PROTECTED_TABLES: &[&str] = &[
    // The credential stores.
    "owner_recovery",
    "auth_audit",
    // Migration 023's enrollment state machine. It holds the hash of the
    // one-time installation enrollment code, and its `state` plus attempt
    // counters tell a would-be owner exactly how close the ceremony is to being
    // available and how many guesses remain. The login and bootstrap screens
    // get what they need from the trusted `auth_status` command, never from a
    // query, so the whole table is denied.
    "auth_enrollment",
    // Surfaces that reflect the CONTENT of other tables and so would route
    // around every rule below. See the module note above.
    "dbstat",
    "sqlite_stat1",
    "sqlite_stat2",
    "sqlite_stat3",
    "sqlite_stat4",
    "sqlite_dbpage",
    "sqlite_dbdata",
];

/// Tables where ONLY the listed columns may be read. Everything else on them is
/// denied, including columns that do not exist yet.
///
/// THIS IS AN ALLOWLIST, and the inversion matters. The first draft of this
/// module listed the credential columns and denied those, which is correct only
/// for the columns somebody remembered to list. Independent review pointed at
/// the case that breaks it: a generated column.
///
/// ```sql
///     ALTER TABLE users ADD COLUMN whoops TEXT
///       GENERATED ALWAYS AS (pin_hash)
/// ```
///
/// SQLite authorizes a read of `(users, whoops)` and does **not** issue a
/// second `SQLITE_READ` for `pin_hash` while it evaluates the generating
/// expression — so a denylist never sees the credential and the value comes
/// straight out. No such column exists today; the point is that under a
/// denylist its arrival would be silent, and under this allowlist it is denied
/// until somebody adds it here on purpose. Migration 023's own new columns are
/// in the same position, which is the desired default: a new column on `users`
/// is invisible to the renderer until it has been thought about.
///
/// `users` cannot be protected wholesale — `shiftsRepo.listHistory` and
/// `getHistoryDetail` join it for `full_name` so a closed shift can name who
/// opened and closed it, and Stage A.1's login screen needs id, name and role —
/// so the identity columns are listed and nothing else is.
const COLUMN_ALLOWLIST: &[(&str, &[&str])] = &[(
    "users",
    &[
        "id",
        "store_id",
        "full_name",
        "role",
        "active",
        "created_at",
        "updated_at",
    ],
)];

/// Columns this policy is ASSERTED to keep out, for the test matrix to drive
/// from, and for a reader to see what the allowlist above is protecting.
///
/// This is documentation and a test fixture, NOT the enforcement mechanism —
/// enforcement is [`COLUMN_ALLOWLIST`], which denies these and anything else
/// not named there. Keeping the list is what stops the intent being lost: a
/// future edit that quietly added `pin_hash` to the allowlist would still pass
/// every behavioural test, and `tests::read_guard` cross-checks the two so it
/// cannot.
/// (Consulted only by `tests::read_guard`, which is why it is annotated rather
/// than deleted: it is the written-down INTENT that the enforcement mechanism
/// is cross-checked against, and a dead-code warning is how a policy record
/// like this gets removed by a future tidy-up.)
#[allow(dead_code)]
const MUST_NEVER_BE_READABLE: &[(&str, &str)] = &[
    // The credential itself, and everything that describes it.
    ("users", "pin_hash"),
    ("users", "credential_algo"),
    ("users", "credential_version"),
    ("users", "credential_set_at"),
    // Rate-limit and lockout state. Not a secret, but reading it tells an
    // attacker at the counter exactly how many attempts remain before the
    // lockout they are trying to avoid.
    ("users", "failed_attempts"),
    ("users", "locked_until"),
    // Credential lifecycle state (023). Readable by the authenticated session
    // through a trusted command, not by an arbitrary query.
    ("users", "must_change_pin"),
    // Migration 023 put enrollment state in its own table rather than on
    // `users`, so the names this list carried for it were wrong. The table is
    // denied in full by `PROTECTED_TABLES`; these two entries record the
    // credential-adjacent columns that DO live on `users`.
    ("users", "credential_version"),
];

/// SQL functions the renderer may not call.
///
/// `libsqlite3-sys` builds with `-DSQLITE_ENABLE_LOAD_EXTENSION=1`, so the
/// loading machinery is compiled in. The SQL function is supposed to be inert
/// until a connection opts in through `sqlite3_db_config`, which this
/// application never does — but "supposed to be inert" is the wrong standard
/// for a function whose success is arbitrary native code execution inside the
/// POS process. Denied explicitly, and
/// `tests::read_guard::the_extension_loader_is_refused` asserts the refusal
/// rather than trusting the default.
const PROTECTED_FUNCTIONS: &[&str] = &["load_extension"];

/// STAGE C — WHAT A CASHIER'S READ CONNECTION MAY NOT SEE (GZ-B3-R1).
///
/// Everything above applies to every renderer connection. What follows applies
/// ONLY to connections of the CASHIER pool, which `read_api` hands out when the
/// signed-in user's STORED role does not permit `Operation::ReadCostAndMargin`.
/// The authorizer is the right mechanism for the same reason as above: it is
/// asked about resolved `(table, column)` pairs, so `SELECT *`, aliases, views,
/// CTEs and subqueries cannot route around it.
///
/// Whole tables: the purchasing side of the business (what the shop paid, and
/// to whom), the stock ledger (every movement carries the unit cost it left
/// at), the recipe tables and the posted recipe-cost evidence, the dormant
/// accounting tables, and the sync queue (whose payloads would copy any of
/// them). `supplier_balances` is a view over `supplier_ledger` and is denied
/// through it.
const CASHIER_PROTECTED_TABLES: &[&str] = &[
    "purchases",
    "purchase_items",
    "suppliers",
    "supplier_ledger",
    "inventory_movements",
    "recipes",
    "recipe_components",
    "sale_item_recipe_costs",
    "accounts",
    "journal_entries",
    "journal_lines",
    "sync_queue",
    // Independent review (V1): `next_purchase_number` and its `updated_at`
    // disclose purchasing activity the purchase tables above hide. No renderer
    // code reads this table — the active store comes from `auth_status`.
    "app_settings",
];

/// Any column, on ANY table, whose name contains one of these (ASCII,
/// case-insensitive). A name rule rather than a list on purpose: every cost and
/// COGS figure in this schema is named that way (`avg_cost_*`,
/// `standard_cost_*`, `unit_cogs_*`, `line_cogs_*`, `cogs_total_cents`,
/// `cogs_reversed_cents`, ...), so a cost column a future migration adds is
/// denied to a cashier before anybody has thought about it — the default the
/// credential allowlist above chose for the same reason. It also catches
/// `costing_method`, `cogs_method` and `cogs_source`, which carry no figure;
/// no cashier screen needs them, and an over-broad deny on a configuration
/// label is the cheap direction to be wrong in.
///
/// `variance` covers the closed-shift reconciliation (`variance_usd_cents`,
/// `variance_lbp`): what another operator's drawer was short.
const CASHIER_PROTECTED_COLUMN_FRAGMENTS: &[&str] = &["cost", "cogs", "variance"];

/// And these exact columns: the stored reconciliation of a CLOSED shift — what
/// was expected and what was COUNTED. The counted figure is here because of an
/// independent-review finding: the expected figure is a sum of tender, refund
/// and remittance rows a cashier may legitimately read, so with the count
/// readable the variance is one subtraction away. Without the count it is not.
/// A cashier's own open shift has none of these stored; its running figure is
/// composed from the tender rows, and its close returns its own reconciliation
/// through the `close_shift` command.
const CASHIER_PROTECTED_COLUMNS: &[(&str, &str)] = &[
    ("shifts", "expected_cash_usd_cents"),
    ("shifts", "expected_cash_lbp"),
    ("shifts", "closing_cash_usd_cents"),
    ("shifts", "closing_cash_lbp"),
];

/// The cashier pool's own install-time proof: a cost column must be REFUSED
/// and an ordinary catalogue read ALLOWED, on the connection itself. Both
/// columns exist from migration 001.
const CASHIER_PROOF_MUST_FAIL: &str = "SELECT avg_cost_excl_vat_cents FROM products LIMIT 0";
const CASHIER_PROOF_MUST_PASS: &str =
    "SELECT id, name, price_incl_vat_cents FROM products LIMIT 0";

/// Which policy a read connection carries. Chosen once, at connection time,
/// and fixed for the connection's life. The callback is SELECTED, not
/// parameterised, so there is still no captured state for SQLite to outlive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadTier {
    /// Owner and manager: the credential policy only.
    Staff,
    /// Cashier: the credential policy AND Stage C.
    Cashier,
}

/// Does `haystack` contain `needle`, ASCII case-insensitively? Allocates
/// nothing and cannot panic (`windows` over a byte slice, no indexing).
fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    let n = needle.as_bytes();
    if n.is_empty() {
        return true;
    }
    haystack
        .as_bytes()
        .windows(n.len())
        .any(|w| w.eq_ignore_ascii_case(n))
}

/// The cashier-only decision for one read. `true` means DENY.
fn cashier_denies(table: &str, column: Option<&str>) -> bool {
    for t in CASHIER_PROTECTED_TABLES {
        if matches(table, t) {
            return true;
        }
    }
    let Some(column) = column else {
        // A column name SQLite could not give as UTF-8: fail closed.
        return true;
    };
    for fragment in CASHIER_PROTECTED_COLUMN_FRAGMENTS {
        if contains_ignore_ascii_case(column, fragment) {
            return true;
        }
    }
    for (t, c) in CASHIER_PROTECTED_COLUMNS {
        if matches(table, t) && matches(column, c) {
            return true;
        }
    }
    false
}

/// The read the install-time proof must be REFUSED.
///
/// `users.pin_hash` exists from migration 001, so this probe is valid against
/// every database this application has ever produced, including one at schema
/// version 1.
const PROOF_MUST_FAIL: &str = "SELECT pin_hash FROM users LIMIT 0";

/// The read the install-time proof must be ALLOWED.
///
/// Paired with [`PROOF_MUST_FAIL`] on purpose. One probe alone proves only that
/// *something* refused the statement; the pair proves the authorizer is both
/// installed and not over-broad — an authorizer that denied everything would
/// pass the first probe and is a broken read channel, not a secure one.
const PROOF_MUST_PASS: &str = "SELECT id, full_name, role FROM users LIMIT 0";

/// Is this identifier one of the protected names? ASCII case-insensitive,
/// because SQLite identifiers are.
///
/// Allocates nothing and cannot panic — see the module header's safety note.
fn matches(candidate: &str, name: &str) -> bool {
    candidate.eq_ignore_ascii_case(name)
}

/// SQLite's authorizer callback.
///
/// Returns `SQLITE_OK` to allow, `SQLITE_DENY` to refuse. **`SQLITE_IGNORE` is
/// never returned**, and that is a decision rather than an oversight: for a
/// read, `SQLITE_IGNORE` substitutes NULL and lets the statement succeed, so a
/// caller asking for a hash would receive a row of NULLs and could not tell
/// "you may not read this" from "there is no credential set". A refusal has to
/// look like a refusal, both to an honest caller and in the test that proves it.
///
/// # Safety
///
/// Called by SQLite with pointers valid for the duration of the call. This
/// function dereferences `arg1` and `arg2` only after a null check and only
/// through `CStr`, keeps nothing, allocates nothing, and has no panicking path.
unsafe extern "C" fn authorizer(
    _user_data: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    _db_name: *const c_char,
    _trigger_or_view: *const c_char,
) -> c_int {
    decide(ReadTier::Staff, action, arg1, arg2)
}

/// The CASHIER pool's callback: the same base policy, then Stage C.
///
/// # Safety
///
/// As [`authorizer`].
unsafe extern "C" fn cashier_authorizer(
    _user_data: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    _db_name: *const c_char,
    _trigger_or_view: *const c_char,
) -> c_int {
    decide(ReadTier::Cashier, action, arg1, arg2)
}

/// The decision both callbacks share.
///
/// # Safety
///
/// `arg1` / `arg2` are SQLite's callback arguments, valid for the call only;
/// they are dereferenced after a null check and only through `CStr`.
unsafe fn decide(
    tier: ReadTier,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
) -> c_int {
    // Reading a cstr argument, or `None` if SQLite passed NULL (it does, for
    // the arguments an action does not use) or if the bytes are not UTF-8.
    //
    // A non-UTF-8 identifier cannot match any name in the policy, and a name
    // that cannot be compared must not be assumed harmless, so the one place it
    // matters — the table name of a read — treats it as protected below.
    let as_str = |p: *const c_char| -> Option<&str> {
        if p.is_null() {
            None
        } else {
            std::ffi::CStr::from_ptr(p).to_str().ok()
        }
    };

    match action {
        // THE READ POLICY. arg1 = table, arg2 = column.
        //
        // SQLite asks once per column actually read, after resolving the query,
        // so `SELECT *`, aliases, views, CTEs and subqueries all arrive here as
        // concrete (table, column) pairs.
        ffi::SQLITE_READ => {
            let table = match as_str(arg1) {
                Some(t) => t,
                // No table name, or one that is not UTF-8. Fail closed: there
                // is no legitimate read this application performs that cannot
                // name its table in UTF-8.
                None => return ffi::SQLITE_DENY,
            };

            for protected in PROTECTED_TABLES {
                if matches(table, protected) {
                    return ffi::SQLITE_DENY;
                }
            }

            // Stage C, on the cashier pool only. Placed before the allowlist
            // below, which RETURNS for `users`; nothing on `users` matches a
            // cashier rule today, but the order must not depend on that.
            if tier == ReadTier::Cashier && cashier_denies(table, as_str(arg2)) {
                return ffi::SQLITE_DENY;
            }

            // An allowlisted table: only the named columns, and DENY BY DEFAULT
            // for everything else — including a column that does not exist yet.
            // See [`COLUMN_ALLOWLIST`] for the generated-column case this
            // inversion exists to close.
            for (table_name, allowed) in COLUMN_ALLOWLIST {
                if !matches(table, table_name) {
                    continue;
                }

                let column = match as_str(arg2) {
                    Some(c) => c,
                    // No column name, or one that is not UTF-8, on a table
                    // whose columns are allowlisted. Fail closed.
                    None => return ffi::SQLITE_DENY,
                };

                // The EMPTY name is SQLite's signal for a read of the table that
                // extracts no column at all — what `SELECT count(*) FROM users`
                // compiles to. Permitted: it discloses how many staff rows
                // exist, which the login screen lists anyway, and refusing it
                // would break `count(*)` for no gain.
                //
                // Note what this is NOT, because the first version of this
                // comment got it wrong and independent review caught it: the
                // empty name is not an alias for the rowid. An EXPLICIT
                // `rowid`, `_rowid_` or `oid` arrives here as that name, is not
                // on the allowlist, and is therefore DENIED. That is stricter
                // than permitting the empty name suggests, and it is correct —
                // a rowid is a handle to a row of a table whose columns are
                // allowlisted, and nothing in the application asks for one.
                if column.is_empty() {
                    return ffi::SQLITE_OK;
                }

                for candidate in *allowed {
                    if matches(column, candidate) {
                        return ffi::SQLITE_OK;
                    }
                }
                return ffi::SQLITE_DENY;
            }

            ffi::SQLITE_OK
        }

        // A SQL function the renderer may not call. For this action SQLite
        // passes the function name as the SECOND argument and NULL as the
        // first. See [`PROTECTED_FUNCTIONS`].
        ffi::SQLITE_FUNCTION => {
            if let Some(function) = as_str(arg2) {
                for protected in PROTECTED_FUNCTIONS {
                    if matches(function, protected) {
                        return ffi::SQLITE_DENY;
                    }
                }
            }
            ffi::SQLITE_OK
        }

        // Opening another database file would put tables this policy has never
        // seen in front of the renderer, and would let it read a COPY of the
        // protected tables under a different database name. Refused outright.
        //
        // (The read policy above ignores the database name, so a protected name
        // is protected in `main` and in any attached database alike. This is
        // belt and braces, and the belt is deliberate.)
        ffi::SQLITE_ATTACH | ffi::SQLITE_DETACH => ffi::SQLITE_DENY,

        // Everything else is allowed, and the reasons are specific:
        //
        //   * MUTATIONS (insert, update, delete, drop, alter, create, …) are
        //     already impossible on this connection, because `read_only(true)`
        //     is a property of the file handle. Denying them here as well would
        //     be a second line of defence the module header is careful NOT to
        //     claim: it is the handle that refuses them, and
        //     `tests::read_guard` proves they are still refused.
        //   * PRAGMA and schema reads expose column NAMES, never row VALUES, so
        //     they are not a confidentiality question. They are also issued by
        //     sqlx itself when it establishes and resets a connection, and an
        //     authorizer that refused them would break the read channel rather
        //     than secure it. The renderer's own PRAGMA attempts are refused
        //     earlier, by `read_api::reject_unless_read_only_shape`.
        //     Note that the reflecting surfaces a PRAGMA could expose —
        //     `dbstat` and the `sqlite_statN` tables — are denied as TABLES
        //     above, which is where that hole was actually closed.
        _ => ffi::SQLITE_OK,
    }
}

/// Install the authorizer on one physical connection, and PROVE it is live
/// before the connection may be used.
///
/// Called from `read_api::open_read_only_pool`'s `after_connect` hook, so it
/// runs for the connection the pool establishes eagerly AND for every
/// connection created later when the pool grows or replaces one. There is no
/// path by which a renderer-facing read connection exists without it: a failure
/// here returns `Err`, sqlx discards the connection, and the caller gets no
/// pool.
///
/// The connect-time PRAGMAs (`query_only`, `foreign_keys`) have already run by
/// this point — sqlx applies those during `establish`, before `after_connect` —
/// which is why the authorizer can be installed without having to permit the
/// statements that configure the connection.
///
/// The TIER selects the callback. The cashier tier additionally proves, on the
/// connection itself, that a cost column is refused and a catalogue read is
/// not: the same two-probe discipline as the credential proof.
pub(crate) async fn install_tier(
    conn: &mut sqlx::sqlite::SqliteConnection,
    tier: ReadTier,
) -> Result<(), sqlx::Error> {
    type Callback = unsafe extern "C" fn(
        *mut c_void,
        c_int,
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
    ) -> c_int;
    let callback: Callback = match tier {
        ReadTier::Staff => authorizer,
        ReadTier::Cashier => cashier_authorizer,
    };
    {
        let mut handle = conn.lock_handle().await?;
        let db = handle.as_raw_handle().as_ptr();

        // SAFETY: `db` is sqlx's live connection handle, borrowed for as long
        // as `handle` is alive, so no sqlx worker can be using it concurrently.
        // The callback is a static `extern "C" fn` with no captured state, so
        // there is nothing for SQLite to outlive; `pUserData` is null because
        // the callback needs none. See the module header.
        let rc = unsafe { ffi::sqlite3_set_authorizer(db, Some(callback), std::ptr::null_mut()) };

        if rc != ffi::SQLITE_OK {
            return Err(sqlx::Error::Configuration(
                format!(
                    "could not install the read-pool confidentiality authorizer \
                     (sqlite3_set_authorizer returned {rc}); refusing to open a \
                     renderer read channel that cannot protect credentials"
                )
                .into(),
            ));
        }
    }

    // AND DO NOT TRUST THE RETURN CODE.
    //
    // The whole value of this module is a claim about what this connection will
    // refuse, so the connection is made to demonstrate it — on itself, with the
    // authorizer it actually has, before it is handed out. Two probes, because
    // one would not distinguish a working boundary from a dead read channel.
    if sqlx::query(PROOF_MUST_FAIL).fetch_optional(&mut *conn).await.is_ok() {
        return Err(sqlx::Error::Configuration(
            "the read-pool authorizer did not take effect: a protected credential \
             column was still readable on a freshly configured connection. \
             Refusing to open the renderer read channel."
                .into(),
        ));
    }

    if let Err(e) = sqlx::query(PROOF_MUST_PASS).fetch_optional(&mut *conn).await {
        return Err(sqlx::Error::Configuration(
            format!(
                "the read-pool authorizer is over-broad: an ordinary permitted \
                 read was refused on a freshly configured connection ({e}). \
                 Refusing to open a read channel that cannot serve the application."
            )
            .into(),
        ));
    }

    if tier == ReadTier::Cashier {
        if sqlx::query(CASHIER_PROOF_MUST_FAIL).fetch_optional(&mut *conn).await.is_ok() {
            return Err(sqlx::Error::Configuration(
                "the cashier read-pool policy did not take effect: a cost column was \
                 still readable on a freshly configured connection. Refusing to open \
                 the cashier read channel."
                    .into(),
            ));
        }
        if let Err(e) = sqlx::query(CASHIER_PROOF_MUST_PASS).fetch_optional(&mut *conn).await {
            return Err(sqlx::Error::Configuration(
                format!(
                    "the cashier read-pool policy is over-broad: an ordinary catalogue \
                     read was refused on a freshly configured connection ({e})."
                )
                .into(),
            ));
        }
    }

    Ok(())
}

/// The policy, for `tests::read_guard` to drive its matrix from the policy
/// itself rather than from a second list that can drift out of step.
#[cfg(test)]
pub(crate) struct Policy {
    pub tables: &'static [&'static str],
    pub allowlist: &'static [(&'static str, &'static [&'static str])],
    pub must_never_be_readable: &'static [(&'static str, &'static str)],
    pub functions: &'static [&'static str],
    pub cashier_tables: &'static [&'static str],
    pub cashier_fragments: &'static [&'static str],
    pub cashier_columns: &'static [(&'static str, &'static str)],
}

#[cfg(test)]
pub(crate) fn policy_for_tests() -> Policy {
    Policy {
        tables: PROTECTED_TABLES,
        allowlist: COLUMN_ALLOWLIST,
        must_never_be_readable: MUST_NEVER_BE_READABLE,
        functions: PROTECTED_FUNCTIONS,
        cashier_tables: CASHIER_PROTECTED_TABLES,
        cashier_fragments: CASHIER_PROTECTED_COLUMN_FRAGMENTS,
        cashier_columns: CASHIER_PROTECTED_COLUMNS,
    }
}
