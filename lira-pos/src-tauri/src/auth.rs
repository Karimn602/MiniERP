//! OFFLINE AUTHENTICATION — Gate 2B, Stage A.1.
//!
//! WHAT THIS IS, AND WHAT IT IS NOT
//!
//! This module gives Greaz a credential, a session, and a lock. It gives it NO
//! authorization: there is no permission matrix here, no per-operation check,
//! and `users.role` still decides nothing except who may log in at all (§"THE
//! STAGE A.1 RELEASE BOUNDARY" below). Role enforcement is Stage B, and until
//! Stage B ships, **this is not employee-ready security**. A login screen
//! without backend authorization only decides who starts the application; it
//! does not decide what they may then do.
//!
//! Saying so in the module that implements the login is deliberate. The
//! tempting claim after this stage is "Greaz has user accounts now", and a shop
//! that heard that would hire a cashier on the strength of it.
//!
//! THE SESSION IS AMBIENT, AND THERE IS NO TOKEN ON THE WIRE
//!
//! The session lives in this process's memory, in Tauri managed state, and the
//! renderer never receives a handle to it. Commands do not take a token and do
//! not take an actor; they consult the session. Four reasons, in order of
//! weight:
//!
//!   1. **IT LEAVES THE IDEMPOTENCY MACHINERY ALONE.** `lib/postAttempt.ts`
//!      freezes the complete `post_sale` request into `localStorage`, with a
//!      read-back proof, BEFORE invoking — and that frozen request is the only
//!      thing standing between a lost response and a double charge. A token on
//!      the wire would be part of the request, so it would land inside the
//!      frozen attempt, and then every replay, canonical comparison and
//!      recovery path would have to be taught to ignore it. With no token the
//!      request shape does not change at all, and `remittanceAttempt.ts` is
//!      untouched for the same reason. This is the difference between "excluded
//!      from the comparison, pinned by tests" and "there is nothing to
//!      exclude".
//!   2. **There is no credential at rest to copy.** A token handed to the
//!      renderer would sit in JS memory, one convenience commit away from
//!      `localStorage`.
//!   3. **One window, one till.** A token's real job is multiplexing clients.
//!      `tauri.conf.json` configures exactly one window, and §"WINDOW BINDING"
//!      enforces that the authority belongs to it.
//!   4. **F5 does not log the operator out.** The renderer's state dies on a
//!      reload; this one does not. `auth_status` is how the UI rediscovers it,
//!      and a LOCKED session comes back locked.
//!
//! The honest limit: this is not protection against hostile code inside the
//! renderer, which could `invoke` any command and act as the logged-in user.
//! That is equally true of a token design — the renderer would hold the token —
//! and it is not the threat model, because no remote content is loaded and the
//! UI is bundled. What the ambient session buys is the thing that matters:
//! **the renderer cannot name its own actor or its own role.**
//!
//! THE CLOCK IS MONOTONIC AND IT IS RUST'S
//!
//! Idle locking is enforced here, on `std::time::Instant`, not by a JavaScript
//! timer and not against the wall clock. A `setTimeout` is a suggestion — the
//! renderer can clear it, and a reload loses it. The wall clock is worse than a
//! suggestion: it can be moved. `Instant` cannot be set backwards by changing
//! the system time, which is the one property an inactivity limit needs.
//!
//! WINDOW BINDING
//!
//! Every command here takes the calling `Window` and requires its label to be
//! the primary one. A session is authority granted to the person at the till in
//! front of the main window; a second window — a plugin, a devtools-spawned
//! webview, a future feature — must not inherit it silently. This is cheap, and
//! the alternative is an authority whose scope nobody has written down.
//!
//! THE STAGE A.1 RELEASE BOUNDARY
//!
//! **Only the OWNER may authenticate in this stage.** Existing manager and
//! cashier rows are real, and after Stage B they will be real accounts, but
//! until the permission matrix exists a manager or cashier login would be an
//! account with owner powers and a different name on it — which is worse than
//! no account, because it manufactures exactly the appearance of control this
//! codebase has repeatedly refused to manufacture (see
//! `posting::UNVERIFIED_APPROVAL_PREFIX`). [`LOGIN_RESTRICTED_TO_OWNER`] is the
//! single constant that relaxes, so turning it off in Stage B is one honest
//! condition rather than a rewrite.
//!
//! WHAT NONE OF THIS DOES
//!
//! It does not encrypt the database. The file is unencrypted SQLite under the
//! Windows account that runs the application, so anybody who can run a program
//! on that account can read every hash and can clear one to bypass login
//! entirely. A PIN defends against the person at the counter, not against the
//! file. The controls that address the file are operating-system controls — a
//! separate non-administrator Windows account for the till, a password on it,
//! screen lock, BitLocker — and they are worth more than everything in this
//! module. `docs/` says so in the operator's own words.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;
use tokio::sync::Mutex;

use crate::posting::DbState;

// ===========================================================================
// Policy
// ===========================================================================

/// WHETHER STAFF MAY SIGN IN. Lifted in Stage B.3.
///
/// This was `true` through Stages A.1, B.1 and B.2, and the reason it stayed
/// true is the reason it can now be lifted. A role that decides nothing is not
/// a permission, so a staff login would have been an account with owner powers
/// and a different name on it — which is worse than no staff account, because
/// it creates the belief that a cashier cannot refund, and that is how an
/// unexplained shortfall goes unlooked-for.
///
/// Three things had to be true before it could change, and all three now are:
///
///   1. **The roles decide something.** `authz::permits` is enforced at the
///      command boundary AND inside the transaction that commits, on all
///      twenty-four commands.
///   2. **The attribution is trustworthy.** Every `*_user_id` on a new document
///      comes from the session, and a request naming anybody else is refused.
///      Without this a cashier's sale could still have carried the owner's
///      name.
///   3. **A staff account can be given a credential.** `users.rs` exists, so
///      the owner can create the account and set its first passphrase. Lifting
///      the restriction before that would have offered a login screen nobody
///      but the owner could get through.
///
/// WHAT IS STILL NOT TRUE, so the claim stays the right size: a cashier can
/// read every cost and margin in the business through `db_select`, which
/// accepts arbitrary SELECT text. That is Stage C, and it is the largest
/// remaining gap. `read_guard` protects the credentials and nothing else. So
/// the honest statement after B.3 is that Greaz controls what staff may DO and
/// records who did it, and does not yet control what they may SEE.
pub(crate) const LOGIN_RESTRICTED_TO_OWNER: bool = false;

/// The window a session belongs to.
const PRIMARY_WINDOW: &str = "main";

/// How long the till may sit untouched before it LOCKS. Not logs out — see
/// [`SessionState::lock`] for why those are different.
const IDLE_LOCK_AFTER: Duration = Duration::from_secs(5 * 60);

/// Credential policy version. Bumped when the Argon2id parameters below change,
/// so a successful login against an older hash can re-hash it rather than
/// leaving the shop on a weaker credential for ever.
const CREDENTIAL_VERSION: i64 = 1;

/// An owner or manager states a PASSPHRASE, not a PIN.
///
/// The reason is offline guessing. A 6-digit PIN is 10^6 possibilities, which
/// Argon2id at ~250 ms makes hopeless ONLINE and merely expensive offline — and
/// an attacker with the database file guesses offline, with no lockout, at
/// whatever rate their hardware allows. The owner credential is the one that
/// can reach every figure in the business, so it is held to a length that makes
/// offline guessing impractical rather than slow.
const MIN_PASSPHRASE_LEN: usize = 10;

/// A cashier PIN floor. Six digits, and the documentation says plainly what
/// that is and is not worth.
const MIN_PIN_LEN: usize = 6;

/// Consecutive failures before the account locks, and the back-off ladder in
/// seconds. Persisted on the row, not counted in memory: an in-memory counter
/// is reset by closing and reopening the application, which is the first thing
/// anybody guessing would try.
const MAX_FAILED_ATTEMPTS: i64 = 5;
const LOCKOUT_LADDER_SECS: [i64; 4] = [60, 300, 900, 3600];

/// The enrollment and recovery codes. 160 bits, rendered in Crockford-style
/// base32 without the ambiguous letters, because somebody reads this off a
/// screen or a piece of paper and types it in.
const CODE_BYTES: usize = 20;
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Attempts allowed against an enrollment or recovery code before it locks.
/// Lower than the login ladder: a code is machine-generated, so a human typing
/// it wrong five times is a typo and a program trying it five times is an
/// attack.
const MAX_CODE_ATTEMPTS: i64 = 5;
const CODE_LOCKOUT_SECS: i64 = 900;

/// How long a freshly minted enrollment code is good for. The installation
/// ceremony happens at install time; a code that stays live for a week is a
/// week in which somebody else can use it.
const ENROLLMENT_CODE_TTL_HOURS: i64 = 24;

/// The file the first-run enrollment code is written to.
///
/// This IS the installation ceremony, and its honest value needs stating.
/// Whoever can read this file at install time is treated as the trusted
/// installer. On a single shared Windows account the cashier and the owner are
/// the SAME operating-system principal, so the file does not distinguish them —
/// what it buys is that ownership is never captured by accident, that capturing
/// it takes a deliberate act, and that the act is audited. What makes it a real
/// control is a separate non-administrator Windows account for the till. The
/// code is NOT compiled into the binary, NOT in source control, and NOT written
/// to any ordinary log.
const ENROLLMENT_CODE_FILENAME: &str = "FIRST-RUN-ENROLLMENT-CODE.txt";

// ===========================================================================
// Role and Actor
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
    Owner,
    Manager,
    Cashier,
}

impl Role {
    /// Parse the value stored in `users.role`.
    ///
    /// Only ever called on a string READ FROM THE DATABASE, never on one from
    /// the wire — which is the point. A caller-supplied role label is not a
    /// role, and there is no path in this module by which one becomes one.
    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "owner" => Ok(Role::Owner),
            "manager" => Ok(Role::Manager),
            "cashier" => Ok(Role::Cashier),
            other => Err(format!(
                "the stored role `{other}` is not one this build understands"
            )),
        }
    }

    /// (Stage B binds this into every `*_user_id` column and into the
    /// permission matrix; it is annotated rather than removed so the mapping
    /// lives beside `from_db`, which is the only other place the vocabulary
    /// appears.)
    #[allow(dead_code)]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Manager => "manager",
            Role::Cashier => "cashier",
        }
    }
}

/// WHO is performing an operation, resolved from the session and never from a
/// payload.
///
/// Stage A.1 carries it; Stage B is where every `*_user_id` column starts
/// coming from it.
#[derive(Debug, Clone)]
pub(crate) struct Actor {
    pub user_id: String,
    pub store_id: String,
    pub role: Role,
}

impl Actor {
    /// A privileged actor for tests ONLY.
    ///
    /// `#[cfg(test)]`, and that is a requirement rather than tidiness: the
    /// mandate for this work is explicit that there must be no
    /// production-reachable default privileged test owner. Every `*_with_pool`
    /// seam in this crate is also `#[cfg(test)]`, so the pair of them means a
    /// release binary contains no path that manufactures an owner.
    ///
    /// Tests that are ABOUT authorization use `*_as(pool, &actor, payload)`
    /// with an actor they build themselves; this is for the ~993 existing call
    /// sites that are about posting, costing and returns and have no opinion
    /// about who is signed in.
    #[cfg(test)]
    pub(crate) fn test_owner() -> Self {
        Self {
            user_id: "00000000-0000-0000-0000-000000000002".to_string(),
            store_id: "00000000-0000-0000-0000-000000000001".to_string(),
            role: Role::Owner,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_tests(user_id: &str, store_id: &str, role: Role) -> Self {
        Self {
            user_id: user_id.to_string(),
            store_id: store_id.to_string(),
            role,
        }
    }
}

// ===========================================================================
// The session
// ===========================================================================

#[derive(Debug)]
struct Session {
    user_id: String,
    store_id: String,
    full_name: String,
    role: Role,
    opened_at: Instant,
    last_seen: Instant,
    /// LOCKED IS NOT LOGGED OUT. A locked session keeps the user, the cart, the
    /// open shift and any in-flight attempt; it simply refuses to do anything
    /// until the SAME person proves who they are again.
    locked: bool,
    must_change_credential: bool,
    /// WHICH CREDENTIAL THIS SESSION WAS OPENED AGAINST.
    ///
    /// Not the credential, and not a secret: it is the PHC string's parameter
    /// and SALT prefix with the hash output removed (`credential_fingerprint`).
    /// Argon2id draws a fresh random salt on every hash, so the prefix changes
    /// whenever the credential is set, reset or cleared, and comparing it is how
    /// a live session finds out that the secret it authenticated against is no
    /// longer the one on file.
    ///
    /// `None` means the account had no credential when the session opened,
    /// which is only reachable for the enrollment path (the owner has just
    /// chosen the passphrase, and the row is written before the session opens,
    /// so in practice this is always `Some` in production).
    credential_fingerprint: Option<String>,
    /// Which window the authority was granted to. Recorded so a future
    /// multi-window feature cannot quietly inherit it, and so a diagnostic can
    /// say where a session came from.
    #[allow(dead_code)]
    window_label: String,
}

/// WHICH CREDENTIAL A STORED HASH IS, without being the hash.
///
/// A PHC string is `$argon2id$v=19$m=..,t=..,p=..$<salt>$<output>`. This drops
/// the final segment — the hash output, the part that verifies a guess — and
/// keeps the algorithm, the parameters and the SALT. The salt is drawn fresh at
/// random on every hash, so the prefix identifies the credential uniquely and
/// changes whenever it is replaced. It is not secret (it is stored in the clear
/// beside the output and is useless without it), and it is not usable to verify
/// anything.
///
/// Compared rather than the whole string so that a session holds no part of the
/// material an offline attack would need.
fn credential_fingerprint(pin_hash: Option<&str>) -> Option<String> {
    let stored = pin_hash?;
    if stored.trim().is_empty() {
        return None;
    }
    Some(match stored.rsplit_once('$') {
        // The ordinary shape: everything up to and including the salt.
        Some((head, _output)) if !head.is_empty() => head.to_string(),
        // Anything else is not a PHC string this application wrote. Using the
        // whole value is the conservative reading: it still changes when the
        // credential changes, which is all this comparison needs.
        _ => stored.to_string(),
    })
}

/// What [`SessionState::reconcile`] found. A verdict rather than a silent
/// mutation, because two of the three outcomes have to be AUDITED, and the
/// audit needs a pool and a store that `SessionState` deliberately does not
/// hold — it is session memory, not a database accessor.
#[derive(Debug)]
pub(crate) enum SessionOutcome {
    Unchanged,
    Updated { was: Role, now: Role },
    Revoked { user_id: String, why: &'static str },
}

/// What a session was when a reconciliation started reading the database.
///
/// Captured TOGETHER, under one acquisition of the lock, and re-checked
/// together under the second one. Either half alone is insufficient: the
/// generation moves on a lock or a role adoption with the same user still
/// signed in, and the user id repeats if the same person signs out and back in.
struct SessionStamp {
    user_id: String,
    generation: u64,
}

pub struct SessionState {
    inner: Mutex<Option<Session>>,
    /// SERIALISES EVERY CREDENTIAL ATTEMPT, so a persisted counter cannot be
    /// outrun.
    ///
    /// GZ-A1-P2 (independent review). Login, unlock, enrollment and recovery
    /// each read the attempt count, spend ~250 ms verifying an Argon2id hash,
    /// and then write `count + 1`. Without serialisation, N requests issued at
    /// once all read the same count and all write the same value — so a
    /// fan-out buys N guesses for the price of one recorded failure, and the
    /// lockout can be postponed indefinitely in batches. The persisted counter
    /// was doing exactly what it was designed to do and being lapped.
    ///
    /// One process-wide gate rather than a per-account one, deliberately:
    /// there is one till and one window, a legitimate operator makes one
    /// attempt at a time, and the cost of being wrong about the granularity is
    /// a queue of attackers' guesses rather than a hole. It also covers the
    /// enrollment-code issuance race (two simultaneous `auth_status` calls
    /// could otherwise leave one code in the file and a different one's hash in
    /// the database).
    ///
    /// Held across read-count -> verify -> write-count, which is the whole
    /// critical section. Nothing inside it takes `inner`, so the two mutexes
    /// cannot deadlock against each other.
    credential_gate: Mutex<()>,
    /// Monotonic generation, bumped on every login, logout and lock. The
    /// frontend reads it to tell "the session I am looking at" from "a session",
    /// which is what stops a stale screen acting as though its own view of the
    /// world is current after a user switch.
    generation: AtomicU64,
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            credential_gate: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    fn bump(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Take the credential gate for one attempt, or REFUSE if one is already
    /// in progress.
    ///
    /// GZ-A1-R2-P2 (independent review, round 2). The first version of this
    /// awaited the mutex, which serialised attempts correctly and introduced a
    /// denial of service in their place: the wait queue was unbounded, and a
    /// renderer can enqueue thousands of `auth_login` calls naming accounts
    /// that do not exist. Each one still performs a full ~250 ms dummy
    /// verification — that is deliberate, so the response time is not an
    /// account oracle — so a few thousand queued calls put the legitimate owner
    /// several minutes behind a queue of other people's guesses. Locking the
    /// owner out of their own till is a worse outcome than the counter race the
    /// gate was added to close.
    ///
    /// `try_lock` makes the queue depth ONE. A second concurrent attempt is
    /// refused immediately, with a message that says nothing about the account
    /// it named, and the refusal costs no hashing at all — so flooding buys the
    /// attacker nothing and the owner is never more than one attempt behind.
    ///
    /// The cost is that a genuine double-submit is refused rather than queued.
    /// That is the right trade at a till: the operator sees "wait a moment",
    /// which is true, and the UI already disables its button while a request is
    /// in flight.
    pub(crate) fn credential_attempt(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        self.credential_gate.try_lock().map_err(|_| ATTEMPT_IN_PROGRESS.to_string())
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// THE SESSION GATE. Consulted by `posting::pool_for_state` and
    /// `read_api::read_pool_for_state` — the two chokepoints every writable
    /// command and the renderer's single read channel pass through — so "no
    /// trading before login" is structural rather than twenty remembered
    /// checks.
    ///
    /// It also enforces the idle limit, and does so by LOCKING rather than by
    /// refusing once: an expired session that merely refused would come back to
    /// life on the next call, and one that silently logged out would lose the
    /// cart.
    pub(crate) async fn ensure_signed_in(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let Some(session) = guard.as_mut() else {
            return Err(NOT_SIGNED_IN.to_string());
        };

        if Self::latch_expiry(session) {
            self.bump();
        }

        if session.locked {
            return Err(SESSION_LOCKED.to_string());
        }

        session.last_seen = Instant::now();
        Ok(())
    }

    /// The current actor, for Stage B. Same gate, and it returns WHO rather
    /// than merely whether.
    #[allow(dead_code)]
    pub(crate) async fn current_actor(&self) -> Result<Actor, String> {
        self.ensure_signed_in().await?;
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or(NOT_SIGNED_IN)?;
        Ok(Actor {
            user_id: session.user_id.clone(),
            store_id: session.store_id.clone(),
            role: session.role,
        })
    }

    /// WHAT THE LIVE SESSION SAYS ABOUT ITSELF, AGAINST WHAT THE DATABASE SAYS.
    ///
    /// The session caches the role, the name, the must-change flag and which
    /// credential it was opened against, all as they were AT LOGIN, and an owner
    /// can change every one of them underneath it. Writes were never at risk —
    /// `authz::stored_identity` re-reads the row inside every authorization, so
    /// a demoted manager is refused a refund on their next attempt and a retired
    /// account is refused everything. What WAS at risk is the screen: the rail
    /// and the route guard read the cached role, so a self-demoted owner kept
    /// the owner's rail indefinitely rather than for one poll, and because the
    /// read channel is not role-gated until Stage C, the screens that rail
    /// offers still answer.
    ///
    /// Four outcomes, and the two that are not obvious are why this returns a
    /// verdict instead of quietly mutating:
    ///
    ///   * the row AGREES — nothing happens;
    ///   * the row has CHANGED — role, name or must-change is adopted and the
    ///     generation is bumped, so the renderer treats it as new;
    ///   * the account is GONE OR RETIRED — the session is ended. Not locked:
    ///     locking invites the same person to unlock it and there is nothing
    ///     left to unlock into, since every command refuses a retired account;
    ///   * THE CREDENTIAL HAS CHANGED — the session is ended too. See below.
    ///
    /// ## A changed credential ends the session, and that is the P1 this fixed
    ///
    /// Independent review, round 2. A promotion out of the cashier tier clears
    /// the stored credential, because a six-digit PIN set under the cashier rule
    /// cannot be re-tested against the manager rule and there is no honest way
    /// to keep it. But a LIVE session held the role in memory, and this function
    /// adopted the new one — so the session that the weak PIN had opened became
    /// a manager's or an owner's session, which is precisely the condition
    /// clearing the credential existed to prevent. Sessions are process-local
    /// and there is no single-instance guard (GZ-A1-R2), so an owner in one
    /// instance can promote a cashier signed into another and never see it.
    ///
    /// So the fingerprint is compared BEFORE any role is adopted, and a
    /// credential that has been replaced or cleared ends the session rather than
    /// upgrading it. That is also the right answer for an ordinary reset: an
    /// owner resetting somebody's passphrase because they have left the premises
    /// should not leave that person's open session running on the old one.
    ///
    /// ## It is a LATEST-REQUEST-ONLY reconciliation
    ///
    /// The database read cannot hold the session mutex — it is an `await` on a
    /// pool, and holding a session lock across it would serialise every status
    /// poll behind it. So the state is captured before, re-checked after, and a
    /// SUPERSEDED reconciliation writes NOTHING: not the role, not the removal,
    /// not the audit. Without that, a concurrent logout-then-login could have an
    /// in-flight reconciliation clear the NEW session, or copy the OLD user's
    /// role and name onto it — and two concurrent polls could apply their
    /// answers out of order or write the same `session_revoked` twice.
    ///
    /// The stamp is `(user_id, generation)` together. Either alone is
    /// insufficient: the generation moves while the same person stays signed in
    /// (a lock, a role adoption), and the user id repeats if the same person
    /// signs out and back in. Both must still match, and the mutation happens
    /// under the lock that checked them.
    ///
    /// Called from the status path only. Every authorized command already
    /// re-reads the row, so putting this in the hot path would buy a query per
    /// command for a guarantee already made — and the status call is what the
    /// renderer polls, which is what makes the convergence bounded.
    async fn reconcile(&self, pool: &SqlitePool) -> Result<SessionOutcome, String> {
        // ---- capture -----------------------------------------------------
        let Some(stamp) = ({
            let guard = self.inner.lock().await;
            guard.as_ref().map(|s| SessionStamp {
                user_id: s.user_id.clone(),
                // Read INSIDE the lock, so it cannot be a generation from
                // before or after the session this stamp names.
                generation: self.generation(),
            })
        }) else {
            return Ok(SessionOutcome::Unchanged);
        };

        // ---- read, without the lock --------------------------------------
        let row = sqlx::query(
            "SELECT role, active, full_name, must_change_pin, pin_hash
               FROM users WHERE id = ?",
        )
        .bind(&stamp.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("cannot re-read the signed-in account: {e}"))?;

        let fresh = match &row {
            None => None,
            Some(row) => {
                let active = row.try_get::<i64, _>("active").unwrap_or(0) == 1;
                let role_text: String = row
                    .try_get("role")
                    .map_err(|e| format!("cannot read the stored role: {e}"))?;
                let full_name: String = row
                    .try_get("full_name")
                    .map_err(|e| format!("cannot read the stored name: {e}"))?;
                Some((
                    active,
                    Role::from_db(&role_text)?,
                    full_name,
                    row.try_get::<i64, _>("must_change_pin").unwrap_or(0) == 1,
                    credential_fingerprint(optional_text(row, "pin_hash")?.as_deref()),
                ))
            }
        };

        // ---- re-check and mutate, under one acquisition -------------------
        let mut guard = self.inner.lock().await;
        let superseded = match guard.as_ref() {
            None => true,
            Some(live) => {
                live.user_id != stamp.user_id || self.generation() != stamp.generation
            }
        };
        if superseded {
            // Somebody signed out, signed in, locked, or a newer
            // reconciliation already landed. Writing anything now would be
            // writing an answer about a session that no longer exists.
            return Ok(SessionOutcome::Unchanged);
        }

        let Some((active, role, full_name, must_change, fingerprint)) = fresh else {
            *guard = None;
            drop(guard);
            self.bump();
            return Ok(SessionOutcome::Revoked {
                user_id: stamp.user_id,
                why: "the account no longer exists",
            });
        };

        if !active {
            *guard = None;
            drop(guard);
            self.bump();
            return Ok(SessionOutcome::Revoked {
                user_id: stamp.user_id,
                why: "the account was retired",
            });
        }

        // THE CREDENTIAL CHECK COMES BEFORE ANY ROLE IS ADOPTED. Adopting first
        // and checking after would be the defect itself, in a different order.
        let session = guard.as_mut().expect("checked above");
        if session.credential_fingerprint != fingerprint {
            *guard = None;
            drop(guard);
            self.bump();
            return Ok(SessionOutcome::Revoked {
                user_id: stamp.user_id,
                why: if fingerprint.is_none() {
                    "the account's passphrase was cleared"
                } else {
                    "the account's passphrase was changed"
                },
            });
        }

        let changed = session.role != role
            || session.full_name != full_name
            || session.must_change_credential != must_change;
        if !changed {
            return Ok(SessionOutcome::Unchanged);
        }
        let was = session.role;
        session.role = role;
        session.full_name = full_name;
        session.must_change_credential = must_change;
        drop(guard);
        // Exactly one bump. The renderer keys a refresh off the generation, so a
        // role that moved has to look like a new session rather than the same
        // one re-read.
        self.bump();
        Ok(SessionOutcome::Updated { was, now: role })
    }

    async fn snapshot(&self) -> Option<SessionView> {
        let mut guard = self.inner.lock().await;
        let session = guard.as_mut()?;

        // Reading the status is the one place the idle limit is evaluated
        // without being an operation, so the screen can show a lock that has
        // already happened rather than causing one.
        Self::latch_expiry(session);

        let remaining = if session.locked {
            0
        } else {
            IDLE_LOCK_AFTER
                .saturating_sub(session.last_seen.elapsed())
                .as_secs()
        };

        Some(SessionView {
            user_id: session.user_id.clone(),
            full_name: session.full_name.clone(),
            store_id: session.store_id.clone(),
            role: session.role,
            locked: session.locked,
            must_change_credential: session.must_change_credential,
            idle_seconds_remaining: remaining,
            opened_seconds_ago: session.opened_at.elapsed().as_secs(),
        })
    }

    async fn open(&self, session: Session) {
        *self.inner.lock().await = Some(session);
        self.bump();
    }

    async fn clear(&self) {
        *self.inner.lock().await = None;
        self.bump();
    }

    /// THE LIVE SESSION NOW HOLDS THIS CREDENTIAL.
    ///
    /// Called by the two paths that legitimately replace the signed-in
    /// person's OWN secret: `auth_change_credential` and `auth_recover_owner`.
    /// Without it `reconcile` would compare the session's fingerprint against a
    /// credential that the same operator deliberately replaced a moment ago,
    /// find a mismatch, and sign them out — which for a cashier with a basket
    /// open is a lost sale to fix a screen, and which would make the sensible
    /// act of changing your passphrase the one thing a shift cannot survive.
    ///
    /// It is NOT a way around the revocation rule: it stamps the session with
    /// the credential that the operator just proved and chose, from inside the
    /// command that wrote it. A credential changed by anybody ELSE never reaches
    /// here, and still ends the session.
    ///
    /// `must_change_credential` is cleared in the same breath, because the same
    /// statement clears `must_change_pin` in the database and a prompt that
    /// outlived the thing it asks for would keep asking.
    async fn restamp_credential(&self, user_id: &str, pin_hash: &str) {
        let mut guard = self.inner.lock().await;
        if let Some(session) = guard.as_mut() {
            if session.user_id == user_id {
                session.credential_fingerprint = credential_fingerprint(Some(pin_hash));
                session.must_change_credential = false;
            }
        }
    }

    async fn lock(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let session = guard.as_mut().ok_or(NOT_SIGNED_IN)?;
        session.locked = true;
        self.bump();
        Ok(())
    }

    /// Who the locked session belongs to — so [`auth_unlock`] can verify the
    /// SAME person rather than accepting any valid credential.
    async fn locked_user(&self) -> Result<String, String> {
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or(NOT_SIGNED_IN)?;
        if !session.locked {
            return Err("this session is not locked".to_string());
        }
        Ok(session.user_id.clone())
    }

    async fn unlock(&self, must_change_credential: bool) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let session = guard.as_mut().ok_or(NOT_SIGNED_IN)?;
        session.locked = false;
        session.last_seen = Instant::now();
        session.must_change_credential = must_change_credential;
        self.bump();
        Ok(())
    }

    /// Defer the idle lock — but only for a session that has not already
    /// expired.
    ///
    /// GZ-A1-P1 (independent review). The first version of this checked only
    /// `session.locked` and then reset `last_seen` unconditionally, which was
    /// an authentication bypass rather than an untidiness:
    ///
    ///   * The lock is LATCHED, not computed. A session passes the idle limit
    ///     at some instant, but `locked` only becomes true when something next
    ///     consults the gate or the status.
    ///   * `auth_touch` is called from the renderer on ordinary pointer and key
    ///     events, with no database access, so it is the cheapest and most
    ///     frequent caller there is.
    ///   * So an owner who left an unlocked till past the limit — and whose
    ///     session had not yet been latched, which is exactly what happens
    ///     after a sleep/resume or a throttled background timer — had the clock
    ///     reset by the first touch of the screen, and traded on without
    ///     re-entering anything. Repeated calls could hold a session open
    ///     indefinitely.
    ///
    /// The expiry decision therefore lives in ONE place
    /// ([`SessionState::latch_expiry`]) and every entry point goes through it.
    /// A touch now either defers a live session or reports the lock it just
    /// discovered; it can never undo one.
    async fn touch(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let session = guard.as_mut().ok_or(NOT_SIGNED_IN)?;

        if Self::latch_expiry(session) {
            self.bump();
        }
        if session.locked {
            return Err(SESSION_LOCKED.to_string());
        }

        session.last_seen = Instant::now();
        Ok(())
    }

    /// Lock a session that has passed the idle limit. Returns whether it just
    /// changed.
    ///
    /// The ONLY place the idle limit is evaluated. It is a `&mut Session`
    /// helper rather than a method on `SessionState` so that every caller has
    /// already taken the mutex and cannot evaluate the limit against a stale
    /// copy.
    fn latch_expiry(session: &mut Session) -> bool {
        if !session.locked && session.last_seen.elapsed() >= IDLE_LOCK_AFTER {
            session.locked = true;
            true
        } else {
            false
        }
    }

    async fn is_open(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Force the idle limit to have elapsed, for `tests::auth_session`.
    ///
    /// The alternative is a test that sleeps for five minutes, and the
    /// alternative to THAT is making the limit configurable in production so a
    /// test can shorten it — which would be a production knob that exists only
    /// for tests and could be turned the wrong way. Reaching into the clock
    /// from a `#[cfg(test)]` helper keeps the production policy a constant.
    #[cfg(test)]
    pub(crate) async fn force_idle_for_tests(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(session) = guard.as_mut() {
            session.last_seen = Instant::now()
                .checked_sub(IDLE_LOCK_AFTER + Duration::from_secs(1))
                .expect("the test clock can be moved back");
        }
    }

    /// Test-only views of the private lifecycle operations, so
    /// `tests::auth_session` can drive the gate directly rather than only
    /// through a command.
    #[cfg(test)]
    pub(crate) async fn clear_for_tests(&self) {
        self.clear().await;
    }

    #[cfg(test)]
    pub(crate) async fn lock_for_tests(&self) -> Result<(), String> {
        self.lock().await
    }

    #[cfg(test)]
    pub(crate) async fn touch_for_tests(&self) -> Result<(), String> {
        self.touch().await
    }

    #[cfg(test)]
    pub(crate) async fn open_for_tests(&self, user_id: &str, store_id: &str, role: Role) {
        self.open(Session {
            user_id: user_id.to_string(),
            store_id: store_id.to_string(),
            full_name: "Test User".to_string(),
            role,
            opened_at: Instant::now(),
            last_seen: Instant::now(),
            locked: false,
            must_change_credential: false,
            // A test session opened without a database row behind it. `None`
            // matches an account with no credential, so a reconciliation
            // against such a row agrees rather than revoking; a test that wants
            // the revocation path signs in properly, through `login_inner`.
            credential_fingerprint: None,
            window_label: PRIMARY_WINDOW.to_string(),
        })
        .await;
    }
}

pub(crate) const NOT_SIGNED_IN: &str =
    "GREAZ IS LOCKED — nobody is signed in. Sign in to use the till.";
/// Deliberately says nothing about the account the refused call named, and
/// costs no hashing at all — see [`SessionState::credential_attempt`].
pub(crate) const ATTEMPT_IN_PROGRESS: &str =
    "Another sign-in attempt is already being checked. Wait a moment and try again.";
pub(crate) const SESSION_LOCKED: &str =
    "GREAZ IS LOCKED — enter your passphrase to carry on. Nothing has been lost.";

// ===========================================================================
// Wire types
// ===========================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub user_id: String,
    pub full_name: String,
    pub store_id: String,
    pub role: Role,
    pub locked: bool,
    pub must_change_credential: bool,
    pub idle_seconds_remaining: u64,
    pub opened_seconds_ago: u64,
}

/// A candidate account for the login or enrollment screen.
///
/// Carries the name and the role and NOTHING else — no credential, no hash, no
/// attempt count, no lockout state. Disclosing which staff exist is deliberate
/// and necessary (a login screen that cannot name its accounts is one nobody
/// can use, and the names are on the staff rota anyway); disclosing how close
/// an account is to lockout is not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub user_id: String,
    pub full_name: String,
    pub role: Role,
    /// Whether this account can be signed into at all in this build. False for
    /// a manager or cashier while [`LOGIN_RESTRICTED_TO_OWNER`] holds, and for
    /// anyone with no credential set.
    pub can_sign_in: bool,
    pub has_credential: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// The schema version, so `App.tsx` can make its readiness check without a
    /// single `db_select` before anybody has logged in.
    pub schema_version: i64,
    pub store_id: String,
    pub store_name: String,
    /// 'virgin' | 'legacy_pending' | 'initialized'.
    pub enrollment_state: String,
    /// Where the installer will find the one-time code, when one is live.
    /// Never the code itself.
    pub enrollment_code_file: Option<String>,
    pub enrollment_locked: bool,
    /// Accounts the login screen may offer.
    pub accounts: Vec<AccountView>,
    pub session: Option<SessionView>,
    pub session_generation: u64,
    /// True while only the owner may sign in — Stage A.1's release boundary, so
    /// the UI can say so instead of leaving a cashier guessing why their
    /// account does not work.
    pub login_restricted_to_owner: bool,
    pub idle_lock_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentResult {
    pub status: AuthStatus,
    /// Shown ONCE and stored only as a hash. The caller is told to write it
    /// down and keep it off this machine.
    pub recovery_code: String,
}

// ===========================================================================
// Hashing
// ===========================================================================

/// The Argon2id parameters.
///
/// m = 19 MiB, t = 2, p = 1 is the RFC 9106 "second recommended" option and is
/// the OWASP guidance for interactive logins. It is deliberately a documented
/// standard set rather than a number tuned to this machine: the measured cost
/// on the pilot hardware is recorded in the Stage A.1 qualification notes, and
/// if it proves too slow at the counter the change is a bump to
/// [`CREDENTIAL_VERSION`] and a re-hash on next login, not a silent weakening.
fn hasher() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None)
        .expect("the Argon2id parameters above are valid by construction");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a secret into a PHC string, which carries its own salt and parameters.
fn hash_secret(secret: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let salt = SaltString::encode_b64(&bytes)
        .map_err(|e| format!("cannot encode a credential salt: {e}"))?;
    hasher()
        .hash_password(secret.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("cannot hash the credential: {e}"))
}

/// Verify a secret against a stored PHC string.
///
/// Returns `false` for a wrong secret AND for a stored hash that cannot be
/// parsed. A corrupt hash is not a reason to let somebody in.
fn verify_secret(secret: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(parsed) => hasher().verify_password(secret.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// A hash to verify against when the account does not exist.
///
/// Without this, "unknown user" returns in microseconds and "wrong passphrase"
/// takes ~250 ms, so the response time tells an attacker which user ids are
/// real. The work is done and the answer is thrown away.
fn dummy_verify(secret: &str) {
    // A fixed, valid PHC string for the fixed passphrase "greaz-dummy". It
    // authenticates nothing: no `users` row can hold it, because every stored
    // hash is generated with a fresh random salt.
    const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1$Z3JlYXpkdW1teXNhbHQwMQ$\
                         3hHRY3KxMtHlVJQGQr6pZyGQ1VmUbCTKDKxGtaKkSKI";
    let _ = verify_secret(secret, DUMMY);
}

/// A high-entropy, human-typeable one-time code.
fn mint_code() -> String {
    let mut bytes = [0u8; CODE_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(CODE_BYTES * 2);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(CODE_ALPHABET[(*b >> 3) as usize & 0x1f] as char);
        out.push(CODE_ALPHABET[(*b & 0x1f) as usize] as char);
    }
    out
}

/// Normalise a typed code: case and the grouping dashes do not matter, because
/// somebody is copying it off a screen.
fn normalise_code(typed: &str) -> String {
    typed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// The project's canonical fixed-width UTC timestamp, for `authz` to stamp an
/// audit row with. Exposed rather than duplicated: two timestamp formats in one
/// table is how a lexicographic range query starts missing rows.
/// The credential strength rule, for `users::set_user_credential_as` to apply
/// when an owner sets somebody else's first passphrase.
///
/// Exposed rather than duplicated: a manager needs a passphrase and a cashier a
/// six-character PIN, and two copies of that rule is how one of them comes to
/// be the weaker.
pub(crate) fn check_secret_strength_for_role(role: Role, secret: &str) -> Result<(), String> {
    check_secret_strength(role, secret)
}

/// Hash a secret on an owner's behalf. Same Argon2id parameters as every other
/// credential in the shop — there is one hasher and one policy.
pub(crate) fn hash_secret_for_admin(secret: &str) -> Result<String, String> {
    hash_secret(secret)
}

pub(crate) fn credential_version_for_admin() -> i64 {
    CREDENTIAL_VERSION
}

/// `audit_tx` for the staff-administration commands.
///
/// A change to who may do what is the thing this gate establishes, so one that
/// committed without a record would be the single change nobody could account
/// for. Fails the transaction if the row cannot be written, exactly as the
/// ownership-capture rows do.
pub(crate) async fn audit_tx_for_users(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    store_id: &str,
    event: &str,
    user_id: Option<&str>,
    actor_user_id: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    audit_tx(tx, store_id, event, user_id, actor_user_id, detail).await
}

pub(crate) fn now_iso_for_audit() -> String {
    now_iso()
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn iso_in_hours(hours: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn iso_in_secs(secs: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(secs))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Is this stored timestamp still in the future?
///
/// Both sides are the project's canonical fixed-width UTC format, so a string
/// comparison is a chronological comparison — the same property migration 021
/// relies on for `activated_at` / `retired_at`.
fn still_in_future(stored: &str) -> bool {
    stored > now_iso().as_str()
}

// ===========================================================================
// Credential rules
// ===========================================================================

/// What a secret must look like for a given role.
///
/// The refusal names the requirement, because "invalid passphrase" at an
/// enrollment screen is how an installer ends up choosing something shorter on
/// the second try.
fn check_secret_strength(role: Role, secret: &str) -> Result<(), String> {
    let len = secret.chars().count();

    if secret.trim().is_empty() {
        return Err("Enter a passphrase.".to_string());
    }
    if secret.trim().len() != secret.len() {
        return Err(
            "A passphrase cannot start or end with a space — it is too easy to lose one."
                .to_string(),
        );
    }

    match role {
        Role::Owner | Role::Manager => {
            if len < MIN_PASSPHRASE_LEN {
                return Err(format!(
                    "An owner or manager passphrase must be at least {MIN_PASSPHRASE_LEN} \
                     characters. Three or four unrelated words are easy to remember and hard \
                     to guess. A short PIN is not enough here: this account can see and change \
                     every figure in the business."
                ));
            }
            if secret.chars().all(|c| c.is_ascii_digit()) {
                return Err(
                    "An owner or manager passphrase cannot be only digits. Use words."
                        .to_string(),
                );
            }
        }
        Role::Cashier => {
            if len < MIN_PIN_LEN {
                return Err(format!(
                    "A cashier PIN must be at least {MIN_PIN_LEN} characters."
                ));
            }
        }
    }

    Ok(())
}

// ===========================================================================
// Database helpers — fixed, parameterised statements only
// ===========================================================================

async fn auth_pool(app: &tauri::AppHandle, db_state: &DbState) -> Result<SqlitePool, String> {
    let path = crate::posting::resolve_db_path(app)?;
    crate::posting::pool_for_authentication(db_state, &path).await
}

/// Everything an authentication operation needs from the Tauri runtime,
/// resolved once at the command boundary.
///
/// WHY THIS EXISTS: `tauri::AppHandle`, `tauri::Window` and `State<'_, T>`
/// cannot be constructed in a test, so a command that takes them is a command
/// that can only be tested by a real desktop run. The security-critical logic
/// in this module is not in the helpers — it is in the ORCHESTRATION: the
/// lockout ladder, the enrollment ceremony's ordering, the single-use recovery
/// code, the refusal of a second session. Those are exactly the parts that must
/// be covered by fast, repeatable tests against a real database.
///
/// So each command resolves this context and then delegates to a `*_inner`
/// function that takes it. The commands below are thin by construction — they
/// check the window, build the context, and call through — which is the same
/// `*_with_pool` seam pattern the posting and catalog commands already use, and
/// `tests::auth_session` asserts they stay thin.
pub(crate) struct AuthCtx<'a> {
    pub(crate) pool: &'a SqlitePool,
    /// Where the one-time first-run enrollment code is written. A field rather
    /// than a call so a test can point it at a temporary directory instead of
    /// the real `app_config_dir`, which is also what keeps these tests from
    /// touching a protected identity.
    pub(crate) code_file: std::path::PathBuf,
    pub(crate) window_label: String,
}

impl<'a> AuthCtx<'a> {
    fn from_runtime(
        app: &tauri::AppHandle,
        pool: &'a SqlitePool,
        window: &tauri::Window,
    ) -> Result<Self, String> {
        Ok(Self {
            pool,
            code_file: enrollment_code_path(app)?,
            window_label: window.label().to_string(),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_tests(pool: &'a SqlitePool, code_file: std::path::PathBuf) -> Self {
        Self {
            pool,
            code_file,
            window_label: PRIMARY_WINDOW.to_string(),
        }
    }
}

struct UserRow {
    id: String,
    store_id: String,
    full_name: String,
    role: Role,
    active: bool,
    pin_hash: Option<String>,
    credential_version: Option<i64>,
    failed_attempts: i64,
    locked_until: Option<String>,
    must_change_pin: bool,
}

async fn load_user(pool: &SqlitePool, user_id: &str) -> Result<Option<UserRow>, String> {
    let row = sqlx::query(
        "SELECT id, store_id, full_name, role, active, pin_hash, credential_version,
                failed_attempts, locked_until, must_change_pin
           FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("cannot read the account: {e}"))?;

    let Some(row) = row else { return Ok(None) };
    let role_text: String = row.try_get("role").map_err(|e| format!("role: {e}"))?;

    Ok(Some(UserRow {
        id: row.try_get("id").map_err(|e| format!("id: {e}"))?,
        store_id: row.try_get("store_id").map_err(|e| format!("store_id: {e}"))?,
        full_name: row
            .try_get("full_name")
            .map_err(|e| format!("full_name: {e}"))?,
        role: Role::from_db(&role_text)?,
        active: row.try_get::<i64, _>("active").unwrap_or(0) == 1,
        // EVERY NULLABLE COLUMN IS DECODED AS AN EXPLICIT `Option`, and this is
        // not a style preference — it is a defect this module shipped and had
        // to have found for it.
        //
        // sqlx-sqlite decodes a SQL NULL into `String` as `Ok("")`, NOT as an
        // error (measured: `tests::auth_session::a_sql_null_text_column_decodes
        // _as_an_empty_string_not_an_error`). So the obvious-looking
        // `row.try_get("pin_hash").ok()` yields `Some("")` for an account with
        // NO credential — and `pin_hash.is_some()` then reads as "this account
        // already has a passphrase". Enrollment refused every fresh owner with
        // exactly that sentence, and the same mistake one layer along would
        // have had `verify_secret` comparing a passphrase against `""`.
        //
        // `try_get::<Option<String>, _>` is unambiguous: NULL is `None`.
        pin_hash: optional_text(&row, "pin_hash")?,
        credential_version: row
            .try_get::<Option<i64>, _>("credential_version")
            .map_err(|e| format!("credential_version: {e}"))?,
        failed_attempts: row
            .try_get::<Option<i64>, _>("failed_attempts")
            .map_err(|e| format!("failed_attempts: {e}"))?
            .unwrap_or(0),
        locked_until: optional_text(&row, "locked_until")?,
        must_change_pin: row
            .try_get::<Option<i64>, _>("must_change_pin")
            .map_err(|e| format!("must_change_pin: {e}"))?
            .unwrap_or(0)
            == 1,
    }))
}

/// Read a nullable TEXT column so that NULL is `None` and an empty string is
/// also `None`.
///
/// Both are collapsed deliberately. A credential hash, a timestamp or a code
/// hash that is the empty string is not a value — it is a column somebody wrote
/// badly — and treating it as present is how `""` ends up being compared
/// against a passphrase. See the note in [`load_user`].
fn optional_text(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Option<String>, String> {
    let raw: Option<String> = row
        .try_get(column)
        .map_err(|e| format!("cannot read `{column}`: {e}"))?;
    Ok(raw.filter(|v| !v.is_empty()))
}

/// Append one audit row.
///
/// `detail` must never carry a secret, a hash or any part of one. That rule is
/// enforced by the callers being the only writers and by
/// `tests::auth_credentials::no_audit_row_ever_contains_a_secret`, which drives
/// the real commands with a known passphrase and then searches the whole table
/// for it.
async fn audit(
    pool: &SqlitePool,
    store_id: &str,
    event: &str,
    user_id: Option<&str>,
    actor_user_id: Option<&str>,
    detail: Option<&str>,
) {
    let outcome = sqlx::query(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, actor_user_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(store_id)
    .bind(now_iso())
    .bind(event)
    .bind(user_id)
    .bind(actor_user_id)
    .bind(detail)
    .execute(pool)
    .await;

    // An audit failure must never be the reason a login fails, and it must
    // never be silent either. There is nowhere better to put this than the
    // console: the renderer cannot read the audit table by design.
    if let Err(e) = outcome {
        eprintln!("[auth] WARNING: could not write the `{event}` audit row: {e}");
    }
}

/// Append one audit row INSIDE a transaction, and fail the transaction if it
/// cannot be written.
///
/// GZ-A1-P2 (independent review). [`audit`] above is deliberately best-effort:
/// a failure to record a routine `login_ok` must never be the reason a cashier
/// cannot open the till. Ownership capture is different in kind. The ceremony's
/// whole claim is that taking ownership of a shop is deliberate AND AUDITED, so
/// a committed enrollment with no `owner_enrolled` row is the one state that
/// makes the claim untrue — and it was reachable, because those rows were
/// written after the commit through the best-effort helper.
///
/// They now commit with the credential, the terminal enrollment state and the
/// recovery code, or none of it commits.
async fn audit_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    store_id: &str,
    event: &str,
    user_id: Option<&str>,
    actor_user_id: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, actor_user_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(store_id)
    .bind(now_iso())
    .bind(event)
    .bind(user_id)
    .bind(actor_user_id)
    .bind(detail)
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(|e| {
        format!("cannot record the `{event}` audit row, so the change is being refused: {e}")
    })
}

/// The single store this build operates. Multi-store is schema-ready and
/// product-deferred; `app_settings.active_store_id` is the existing answer.
async fn active_store(pool: &SqlitePool) -> Result<(String, String), String> {
    let row = sqlx::query(
        "SELECT s.id AS id, s.name AS name
           FROM app_settings a JOIN stores s ON s.id = a.value
          WHERE a.key = 'active_store_id'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("cannot resolve the active store: {e}"))?;

    let Some(row) = row else {
        return Err(
            "No active store is configured. The database is not usable in this state; \
             restore the most recent backup and get help before trading."
                .to_string(),
        );
    };
    Ok((
        row.try_get("id").map_err(|e| format!("store id: {e}"))?,
        row.try_get("name").map_err(|e| format!("store name: {e}"))?,
    ))
}

// ===========================================================================
// Window binding
// ===========================================================================

/// Every command in this module starts here.
///
/// A session is authority granted to whoever is at the primary window. A second
/// window must not inherit it: it did not go through the login screen, nobody
/// decided it should exist, and `window.label()` is the only thing that
/// distinguishes it.
fn require_primary_window(window: &tauri::Window) -> Result<(), String> {
    require_primary_window_label(window.label())
}

/// The decision, separated from the Tauri type so it can be tested.
///
/// `tauri::Window` cannot be constructed in a unit test, and "a second window
/// inherits no authority" is a security claim that should not rest on a real
/// desktop run alone.
pub(crate) fn require_primary_window_label(label: &str) -> Result<(), String> {
    if label == PRIMARY_WINDOW {
        Ok(())
    } else {
        Err(format!(
            "This window ({label}) has no authority to sign in or act as a signed-in user. \
             Use the main Greaz window."
        ))
    }
}

// ===========================================================================
// Commands
// ===========================================================================

/// The only command callable with no session, and the whole of the pre-login
/// boot.
///
/// It returns the schema version, the store, the enrollment state and the
/// accounts the login screen may offer — so `App.tsx` never issues a
/// `db_select` before anybody has signed in, which is what lets the read
/// channel be session-gated without an allowlist of "harmless" pre-login
/// queries.
///
/// It also MINTS the first-run enrollment code when one is needed and none is
/// live, writing the plaintext to a file in the application's own config
/// directory and the hash to the database. See [`ENROLLMENT_CODE_FILENAME`] for
/// what that ceremony is and is not worth.
pub(crate) async fn status_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
) -> Result<AuthStatus, String> {
    let pool = ctx.pool;
    let (store_id, store_name) = active_store(pool).await?;

    let schema_version: i64 = sqlx::query("SELECT MAX(version) AS v FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("cannot read the schema version: {e}"))?
        .try_get("v")
        .unwrap_or(0);

    let enrollment = sqlx::query(
        "SELECT state, enrollment_code_hash, enrollment_code_expires_at,
                enrollment_locked_until
           FROM auth_enrollment WHERE store_id = ?",
    )
    .bind(&store_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("cannot read the enrollment state: {e}"))?;

    let Some(enrollment) = enrollment else {
        return Err(
            "This database has no enrollment record, which means it was not migrated by \
             this build. Close Greaz and get help before trading."
                .to_string(),
        );
    };

    let state: String = enrollment
        .try_get("state")
        .map_err(|e| format!("enrollment state: {e}"))?;
    let live_hash = optional_text(&enrollment, "enrollment_code_hash")?;
    let expires = optional_text(&enrollment, "enrollment_code_expires_at")?;
    let enrollment_locked = enrollment
        .try_get::<Option<String>, _>("enrollment_locked_until")
        .ok()
        .flatten()
        .filter(|v: &String| !v.is_empty())
        .is_some_and(|until| still_in_future(&until));

    let needs_enrollment = state != "initialized";
    let has_live_code = live_hash.is_some() && expires.as_deref().is_some_and(still_in_future);

    let mut enrollment_code_file = None;
    if needs_enrollment {
        if !has_live_code && !enrollment_locked {
            // GZ-A1-P2: serialise issuance. Two simultaneous status calls could
            // otherwise both see no live code, and the one that wrote the FILE
            // last would leave its plaintext beside the OTHER one's hash — a
            // code the installer can read and the database will not accept, for
            // the next twenty-four hours.
            // A REFUSAL HERE IS NOT AN ERROR. It means another caller is
            // already issuing, so this one simply does not — reporting a
            // failure would turn a harmless race into a broken first-run
            // screen, and the next status call will find the live code.
            if let Ok(_issuing) = sessions.credential_attempt() {
                // Re-read under the gate: the other caller may have issued one
                // while we were waiting, and issuing a second would invalidate
                // the first operator's code mid-ceremony.
                let still_live: Option<String> = sqlx::query_scalar(
                    "SELECT enrollment_code_expires_at FROM auth_enrollment WHERE store_id = ?",
                )
                .bind(&store_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("cannot re-check the enrollment code: {e}"))?
                .flatten();

                if !still_live.as_deref().is_some_and(still_in_future) {
                    issue_enrollment_code(ctx, pool, &store_id).await?;
                }
            }
        }
        enrollment_code_file = Some(ctx.code_file.display().to_string());
    }

    // RECONCILE THE LIVE SESSION BEFORE REPORTING IT (independent review of
    // Stage B.3). The role, the name and the must-change flag are cached from
    // login and an owner can change all three underneath a signed-in person.
    // Done here, in the call the renderer polls, so the screen converges within
    // one poll interval instead of never.
    match sessions.reconcile(pool).await? {
        SessionOutcome::Unchanged => {}
        SessionOutcome::Updated { was, now } => {
            if was != now {
                // A role change to a live session is a change in authority, and
                // the one place it can be seen from is the log. The row for the
                // administrative act itself is written by `users.rs`; this one
                // records that a SESSION already in progress was affected.
                audit(
                    pool,
                    &store_id,
                    "role_changed",
                    None,
                    None,
                    Some(&format!(
                        "live session adopted {} -> {}",
                        was.as_str(),
                        now.as_str()
                    )),
                )
                .await;
            }
        }
        SessionOutcome::Revoked { user_id, why } => {
            audit(
                pool,
                &store_id,
                "session_revoked",
                Some(&user_id),
                None,
                Some(why),
            )
            .await;
        }
    }

    let accounts = load_accounts(pool, &store_id).await?;

    Ok(AuthStatus {
        schema_version,
        store_id,
        store_name,
        enrollment_state: state,
        enrollment_code_file,
        enrollment_locked,
        accounts,
        session: sessions.snapshot().await,
        session_generation: sessions.generation(),
        login_restricted_to_owner: LOGIN_RESTRICTED_TO_OWNER,
        idle_lock_seconds: IDLE_LOCK_AFTER.as_secs(),
    })
}

async fn load_accounts(pool: &SqlitePool, store_id: &str) -> Result<Vec<AccountView>, String> {
    let rows = sqlx::query(
        "SELECT id, full_name, role, pin_hash IS NOT NULL AS has_credential
           FROM users
          WHERE store_id = ? AND active = 1
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                   full_name ASC",
    )
    .bind(store_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("cannot list the accounts: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let role_text: String = row.try_get("role").map_err(|e| format!("role: {e}"))?;
        let role = Role::from_db(&role_text)?;
        let has_credential = row.try_get::<i64, _>("has_credential").unwrap_or(0) == 1;
        out.push(AccountView {
            user_id: row.try_get("id").map_err(|e| format!("id: {e}"))?,
            full_name: row
                .try_get("full_name")
                .map_err(|e| format!("full_name: {e}"))?,
            role,
            can_sign_in: has_credential
                && (!LOGIN_RESTRICTED_TO_OWNER || role == Role::Owner),
            has_credential,
        });
    }
    Ok(out)
}

fn enrollment_code_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app_config_dir: {e}"))?;
    Ok(dir.join(ENROLLMENT_CODE_FILENAME))
}

async fn issue_enrollment_code(
    ctx: &AuthCtx<'_>,
    pool: &SqlitePool,
    store_id: &str,
) -> Result<(), String> {
    let code = mint_code();
    let hash = hash_secret(&normalise_code(&code))?;
    let path = ctx.code_file.clone();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create the application config directory: {e}"))?;
    }

    let body = format!(
        "GREAZ POS — FIRST-RUN ENROLLMENT CODE\n\
         =====================================\n\
         \n\
         Enrollment code:  {code}\n\
         \n\
         Issued:   {}\n\
         Expires:  {}\n\
         \n\
         WHAT THIS IS\n\
         This code is needed ONCE, to create the owner account on this machine.\n\
         Type it into the Greaz enrollment screen, choose the owner passphrase,\n\
         and this file will be deleted automatically.\n\
         \n\
         WHO SHOULD USE IT\n\
         The shop owner, or the person installing Greaz for them. Nobody else.\n\
         Whoever uses this code decides the owner passphrase for this shop.\n\
         \n\
         IF YOU ARE NOT THAT PERSON, CLOSE THIS FILE AND TELL THE OWNER.\n\
         \n\
         AFTER ENROLLMENT\n\
         Greaz will show a RECOVERY CODE once. Write it down and keep it away\n\
         from this computer — with the backup USB stick is a good place. It is\n\
         the only way to reset a forgotten owner passphrase without help.\n\
         \n\
         IMPORTANT, AND PLEASE READ IT\n\
         A passphrase protects Greaz, not the data. Anyone who can use this\n\
         Windows account can open the database file directly. Give the till its\n\
         own Windows account, put a password on it, and let nobody else sign in\n\
         to Windows here.\n",
        now_iso(),
        iso_in_hours(ENROLLMENT_CODE_TTL_HOURS)
    );

    std::fs::write(&path, body)
        .map_err(|e| format!("cannot write the enrollment code file at {}: {e}", path.display()))?;

    sqlx::query(
        "UPDATE auth_enrollment
            SET enrollment_code_hash = ?, enrollment_code_algo = 'argon2id',
                enrollment_code_issued_at = ?, enrollment_code_expires_at = ?,
                enrollment_attempts = 0, enrollment_locked_until = NULL
          WHERE store_id = ?",
    )
    .bind(&hash)
    .bind(now_iso())
    .bind(iso_in_hours(ENROLLMENT_CODE_TTL_HOURS))
    .bind(store_id)
    .execute(pool)
    .await
    .map_err(|e| format!("cannot record the enrollment code: {e}"))?;

    // The PATH is audited, never the code.
    audit(
        pool,
        store_id,
        "enrollment_code_issued",
        None,
        None,
        Some(&format!("written to {}", path.display())),
    )
    .await;

    Ok(())
}

/// Create the owner credential, once, against the one-time enrollment code.
///
/// `user_id` is REQUIRED and is not inferred. On a legacy database there may be
/// several active owner rows, and picking one — "the oldest", "the first" — is
/// exactly the automatic selection this stage exists to remove: it would hand
/// the shop to whichever row sorts first rather than to the person standing
/// there. The enrollment screen lists the candidates and the installer chooses.
pub(crate) async fn enroll_owner_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
    enrollment_code: String,
    user_id: String,
    passphrase: String,
) -> Result<EnrollmentResult, String> {
    // ONE ATTEMPT AT A TIME. Held across read-count -> verify -> write-count
    // so a fan-out of simultaneous guesses cannot all read the same counter.
    // See `SessionState::credential_gate`.
    let _attempt = sessions.credential_attempt()?;
    let pool = ctx.pool;
    let (store_id, _) = active_store(pool).await?;

    let row = sqlx::query(
        "SELECT state, enrollment_code_hash, enrollment_code_expires_at,
                enrollment_attempts, enrollment_locked_until
           FROM auth_enrollment WHERE store_id = ?",
    )
    .bind(&store_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("cannot read the enrollment state: {e}"))?;

    let state: String = row.try_get("state").map_err(|e| format!("state: {e}"))?;
    if state == "initialized" {
        // Not a rate-limited path and not an informative one: this is the
        // replay the whole state machine exists to refuse.
        audit(
            &pool,
            &store_id,
            "enrollment_failed",
            None,
            None,
            Some("enrollment attempted on an already-initialized store"),
        )
        .await;
        return Err(
            "This shop already has an owner account. Sign in instead, or use the recovery \
             code if the passphrase has been lost."
                .to_string(),
        );
    }

    if row
        .try_get::<Option<String>, _>("enrollment_locked_until")
        .ok()
        .flatten()
        .filter(|v: &String| !v.is_empty())
        .is_some_and(|u| still_in_future(&u))
    {
        return Err(
            "Too many wrong enrollment codes. Wait fifteen minutes and try again."
                .to_string(),
        );
    }

    let stored_hash = optional_text(&row, "enrollment_code_hash")?;
    let expires = optional_text(&row, "enrollment_code_expires_at")?;
    let attempts: i64 = row
        .try_get::<Option<i64>, _>("enrollment_attempts")
        .map_err(|e| format!("enrollment_attempts: {e}"))?
        .unwrap_or(0);

    let typed = normalise_code(&enrollment_code);
    let code_ok = match (&stored_hash, &expires) {
        (Some(hash), Some(exp)) if still_in_future(exp) => verify_secret(&typed, hash),
        _ => {
            // Still spend the time, so "expired" and "wrong" cost the same.
            dummy_verify(&typed);
            false
        }
    };

    if !code_ok {
        let next = attempts + 1;
        let lock_until = if next >= MAX_CODE_ATTEMPTS {
            Some(iso_in_secs(CODE_LOCKOUT_SECS))
        } else {
            None
        };
        sqlx::query(
            "UPDATE auth_enrollment
                SET enrollment_attempts = ?, enrollment_locked_until = ?
              WHERE store_id = ?",
        )
        .bind(next)
        .bind(&lock_until)
        .bind(&store_id)
        .execute(pool)
        .await
        .map_err(|e| format!("cannot record the failed attempt: {e}"))?;

        audit(
            &pool,
            &store_id,
            "enrollment_failed",
            None,
            None,
            Some(&format!("wrong or expired enrollment code (attempt {next})")),
        )
        .await;

        return Err(if lock_until.is_some() {
            "That enrollment code is wrong or has expired. Too many attempts — wait \
             fifteen minutes."
                .to_string()
        } else {
            "That enrollment code is wrong or has expired. Check the code file named on \
             the previous screen."
                .to_string()
        });
    }

    // The code was right. Now the chosen account must be a real, active owner
    // OF THIS STORE — read from the database, never asserted by the caller.
    let Some(candidate) = load_user(pool, &user_id).await? else {
        return Err("That account does not exist.".to_string());
    };
    if candidate.store_id != store_id {
        return Err("That account belongs to another shop.".to_string());
    }
    if !candidate.active {
        return Err("That account is not active.".to_string());
    }
    if candidate.role != Role::Owner {
        return Err(
            "Only an owner account can be enrolled here. Manager and cashier accounts are \
             created by the owner afterwards."
                .to_string(),
        );
    }
    if candidate.pin_hash.is_some() {
        return Err("That account already has a passphrase.".to_string());
    }

    check_secret_strength(Role::Owner, &passphrase)?;

    // Everything below commits together: the credential, the terminal
    // enrollment state, the recovery code and the audit row. A half-enrolled
    // shop — a credential with no recovery code, or a state change with no
    // credential — is a shop nobody can get into.
    let recovery_code = mint_code();
    let recovery_hash = hash_secret(&normalise_code(&recovery_code))?;
    let credential_hash = hash_secret(&passphrase)?;
    let at = now_iso();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin the enrollment transaction: {e}"))?;

    sqlx::query(
        "UPDATE users
            SET pin_hash = ?, credential_algo = 'argon2id', credential_version = ?,
                credential_set_at = ?, failed_attempts = 0, locked_until = NULL,
                must_change_pin = 0
          WHERE id = ?",
    )
    .bind(&credential_hash)
    .bind(CREDENTIAL_VERSION)
    .bind(&at)
    .bind(&user_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot set the owner passphrase: {e}"))?;

    sqlx::query(
        "UPDATE auth_enrollment
            SET state = 'initialized', initialized_at = ?, initialized_user_id = ?,
                enrollment_code_hash = NULL, enrollment_code_algo = NULL,
                enrollment_code_issued_at = NULL, enrollment_code_expires_at = NULL,
                enrollment_attempts = 0, enrollment_locked_until = NULL
          WHERE store_id = ?",
    )
    .bind(&at)
    .bind(&user_id)
    .bind(&store_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot record the enrollment: {e}"))?;

    sqlx::query(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
         VALUES (?, ?, ?, 'argon2id', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&store_id)
    .bind(&recovery_hash)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot store the recovery code: {e}"))?;

    // IN THE SAME TRANSACTION as the capture they record. See `audit_tx`.
    audit_tx(
        &mut tx,
        &store_id,
        "owner_enrolled",
        Some(&user_id),
        Some(&user_id),
        Some("owner credential created through the first-run enrollment ceremony"),
    )
    .await?;
    audit_tx(
        &mut tx,
        &store_id,
        "credential_set",
        Some(&user_id),
        Some(&user_id),
        None,
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the enrollment: {e}"))?;

    // The code file has served its purpose. Removing it is best-effort: a
    // failure here does not undo a completed enrollment, and the code it holds
    // is already useless because the state is terminal.
    {
        let path = ctx.code_file.clone();
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[auth] WARNING: enrollment completed but the code file at {} could not \
                     be removed: {e}. It no longer works, but delete it by hand.",
                    path.display()
                );
            }
        }
    }

    // Enrollment signs the new owner in. They have just proved the code and
    // chosen the passphrase thirty seconds ago; asking for it again would be
    // ceremony, not security.
    sessions
        .open(Session {
            user_id: candidate.id.clone(),
            store_id: candidate.store_id.clone(),
            full_name: candidate.full_name.clone(),
            role: Role::Owner,
            opened_at: Instant::now(),
            last_seen: Instant::now(),
            locked: false,
            must_change_credential: false,
            // The credential this session is opened against is the one
            // enrollment has just written, a few statements above.
            credential_fingerprint: credential_fingerprint(Some(&credential_hash)),
            window_label: ctx.window_label.clone(),
        })
        .await;
    audit(pool, &store_id, "login_ok", Some(&user_id), None, Some("after enrollment")).await;

    Ok(EnrollmentResult {
        status: status_inner(ctx, sessions).await?,
        recovery_code,
    })
}

/// Sign in.
pub(crate) async fn login_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
    user_id: String,
    secret: String,
) -> Result<AuthStatus, String> {

    // ONE ATTEMPT AT A TIME. Held across read-count -> verify -> write-count
    // so a fan-out of simultaneous guesses cannot all read the same counter.
    // See `SessionState::credential_gate`.
    let _attempt = sessions.credential_attempt()?;
    // LOGIN CREATES A SESSION ONLY WHEN NONE EXISTS. Switching user is a
    // deliberate logout followed by a login, never a silent replacement:
    // replacing a live session would strand whatever the previous user was
    // part-way through — a cart, an open shift, a frozen checkout attempt —
    // under somebody else's name.
    if sessions.is_open().await {
        return Err(
            "Somebody is already signed in. Sign out first — anything unfinished on screen \
             belongs to them."
                .to_string(),
        );
    }

    let pool = ctx.pool;
    let (store_id, _) = active_store(pool).await?;

    let candidate = load_user(pool, &user_id).await?;

    // An unknown or ineligible account still costs a full hash verification,
    // so the response time does not say which user ids are real.
    let Some(user) = candidate else {
        dummy_verify(&secret);
        audit(
            &pool,
            &store_id,
            "login_failed",
            None,
            None,
            Some("sign-in offered an account id that does not exist"),
        )
        .await;
        return Err(SIGN_IN_REFUSED.to_string());
    };

    if user.store_id != store_id || !user.active {
        dummy_verify(&secret);
        audit(
            &pool,
            &store_id,
            "login_failed",
            None,
            None,
            Some("sign-in offered an inactive account or one from another shop"),
        )
        .await;
        return Err(SIGN_IN_REFUSED.to_string());
    }

    if let Some(until) = user.locked_until.as_deref() {
        if still_in_future(until) {
            audit(
                &pool,
                &store_id,
                "login_failed",
                Some(&user.id),
                None,
                Some("sign-in attempted while locked out"),
            )
            .await;
            return Err(
                "This account is locked after too many wrong attempts. Wait a few minutes \
                 and try again, or ask the owner to reset it."
                    .to_string(),
            );
        }
    }

    if LOGIN_RESTRICTED_TO_OWNER && user.role != Role::Owner {
        dummy_verify(&secret);
        audit(
            &pool,
            &store_id,
            "login_failed",
            Some(&user.id),
            None,
            Some("manager/cashier sign-in refused: this build admits the owner only"),
        )
        .await;
        return Err(
            "This version of Greaz can only be used by the owner. Staff accounts will work \
             once role permissions are enabled — until then there is nothing stopping a \
             staff account doing everything the owner can, so they are not allowed to sign in."
                .to_string(),
        );
    }

    let Some(stored) = user.pin_hash.as_deref() else {
        dummy_verify(&secret);
        audit(
            &pool,
            &store_id,
            "login_failed",
            Some(&user.id),
            None,
            Some("sign-in attempted on an account with no passphrase set"),
        )
        .await;
        return Err(
            "This account has no passphrase yet. The owner sets one before it can be used."
                .to_string(),
        );
    };

    if !verify_secret(&secret, stored) {
        let next = user.failed_attempts + 1;
        let lock_until = if next >= MAX_FAILED_ATTEMPTS {
            let step = ((next - MAX_FAILED_ATTEMPTS) as usize).min(LOCKOUT_LADDER_SECS.len() - 1);
            Some(iso_in_secs(LOCKOUT_LADDER_SECS[step]))
        } else {
            None
        };

        sqlx::query("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
            .bind(next)
            .bind(&lock_until)
            .bind(&user.id)
            .execute(pool)
            .await
            .map_err(|e| format!("cannot record the failed attempt: {e}"))?;

        // The attempt is audited; what was typed is NOT. A wrong guess is very
        // often somebody else's right password.
        audit(
            &pool,
            &store_id,
            "login_failed",
            Some(&user.id),
            None,
            Some(&format!("wrong passphrase (attempt {next})")),
        )
        .await;
        if lock_until.is_some() {
            audit(
                &pool,
                &store_id,
                "locked_out",
                Some(&user.id),
                None,
                Some(&format!("locked after {next} consecutive failures")),
            )
            .await;
        }

        return Err(SIGN_IN_REFUSED.to_string());
    }

    // Correct. Clear the counters and re-hash if the policy has moved on.
    //
    // THE SESSION RECORDS WHAT THE DATABASE ENDS UP HOLDING. A re-hash draws a
    // new salt, so it changes the credential fingerprint; a session stamped
    // with the OLD one would be revoked by the very next status poll, a few
    // hundred milliseconds after a correct sign-in. The re-hash is also
    // best-effort by design — a failure to write it leaves the old hash
    // working — so the fingerprint follows the write, not the attempt.
    let mut stored_hash = user.pin_hash.clone();
    if user.credential_version.unwrap_or(0) < CREDENTIAL_VERSION {
        if let Ok(fresh) = hash_secret(&secret) {
            let written = sqlx::query(
                "UPDATE users
                    SET pin_hash = ?, credential_algo = 'argon2id',
                        credential_version = ?, credential_set_at = ?
                  WHERE id = ?",
            )
            .bind(&fresh)
            .bind(CREDENTIAL_VERSION)
            .bind(now_iso())
            .bind(&user.id)
            .execute(pool)
            .await;
            if written.is_ok() {
                stored_hash = Some(fresh);
            }
        }
    }

    sqlx::query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
        .bind(&user.id)
        .execute(pool)
        .await
        .map_err(|e| format!("cannot clear the attempt counter: {e}"))?;

    sessions
        .open(Session {
            user_id: user.id.clone(),
            store_id: user.store_id.clone(),
            full_name: user.full_name.clone(),
            role: user.role,
            opened_at: Instant::now(),
            last_seen: Instant::now(),
            locked: false,
            must_change_credential: user.must_change_pin,
            credential_fingerprint: credential_fingerprint(stored_hash.as_deref()),
            window_label: ctx.window_label.clone(),
        })
        .await;

    audit(pool, &store_id, "login_ok", Some(&user.id), None, None).await;

    status_inner(ctx, sessions).await
}

/// Deliberately the same sentence for a wrong account and a wrong passphrase.
const SIGN_IN_REFUSED: &str =
    "That passphrase is not right. Check the account and try again.";

/// Sign out. Destroys the session.
pub(crate) async fn logout_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
) -> Result<AuthStatus, String> {

    let who = sessions.snapshot().await;
    sessions.clear().await;

    if let Some(view) = who {
        {
            let pool = ctx.pool;
            audit(
                &pool,
                &view.store_id,
                "logout",
                Some(&view.user_id),
                None,
                None,
            )
            .await;
        }
    }

    status_inner(ctx, sessions).await
}

/// Lock the screen. KEEPS the session.
pub(crate) async fn lock_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
) -> Result<AuthStatus, String> {
    sessions.lock().await?;

    if let Some(view) = sessions.snapshot().await {
        {
            let pool = ctx.pool;
            audit(pool, &view.store_id, "lock", Some(&view.user_id), None, None).await;
        }
    }

    status_inner(ctx, sessions).await
}

/// Unlock. Verifies the SAME user's credential — not any valid one.
pub(crate) async fn unlock_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
    secret: String,
) -> Result<AuthStatus, String> {
    // ONE ATTEMPT AT A TIME. Held across read-count -> verify -> write-count
    // so a fan-out of simultaneous guesses cannot all read the same counter.
    // See `SessionState::credential_gate`.
    let _attempt = sessions.credential_attempt()?;
    let locked_user = sessions.locked_user().await?;

    let pool = ctx.pool;
    let (store_id, _) = active_store(pool).await?;

    let Some(user) = load_user(pool, &locked_user).await? else {
        // The account has gone since the session opened. Nothing to unlock
        // into, so the session is destroyed rather than left half-valid.
        sessions.clear().await;
        return Err(
            "The account that was signed in no longer exists. Sign in again.".to_string(),
        );
    };

    if !user.active {
        sessions.clear().await;
        audit(
            &pool,
            &store_id,
            "unlock_failed",
            Some(&user.id),
            None,
            Some("the account was deactivated while the session was locked"),
        )
        .await;
        return Err("That account is no longer active. Sign in again.".to_string());
    }

    if let Some(until) = user.locked_until.as_deref() {
        if still_in_future(until) {
            return Err(
                "This account is locked after too many wrong attempts. Wait a few minutes."
                    .to_string(),
            );
        }
    }

    let verified = user
        .pin_hash
        .as_deref()
        .map(|stored| verify_secret(&secret, stored))
        .unwrap_or_else(|| {
            dummy_verify(&secret);
            false
        });

    if !verified {
        let next = user.failed_attempts + 1;
        let lock_until = if next >= MAX_FAILED_ATTEMPTS {
            let step = ((next - MAX_FAILED_ATTEMPTS) as usize).min(LOCKOUT_LADDER_SECS.len() - 1);
            Some(iso_in_secs(LOCKOUT_LADDER_SECS[step]))
        } else {
            None
        };
        sqlx::query("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
            .bind(next)
            .bind(&lock_until)
            .bind(&user.id)
            .execute(pool)
            .await
            .map_err(|e| format!("cannot record the failed attempt: {e}"))?;

        audit(
            &pool,
            &store_id,
            "unlock_failed",
            Some(&user.id),
            None,
            Some(&format!("wrong passphrase at the lock screen (attempt {next})")),
        )
        .await;
        return Err(SIGN_IN_REFUSED.to_string());
    }

    sqlx::query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
        .bind(&user.id)
        .execute(pool)
        .await
        .map_err(|e| format!("cannot clear the attempt counter: {e}"))?;

    sessions.unlock(user.must_change_pin).await?;
    audit(pool, &store_id, "unlock", Some(&user.id), None, None).await;

    status_inner(ctx, sessions).await
}

/// Change your own passphrase. Requires the current one.
pub(crate) async fn change_credential_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
    current: String,
    next: String,
) -> Result<AuthStatus, String> {

    // ONE ATTEMPT AT A TIME. Held across read-count -> verify -> write-count
    // so a fan-out of simultaneous guesses cannot all read the same counter.
    // See `SessionState::credential_gate`.
    let _attempt = sessions.credential_attempt()?;
    // The gate, so a locked or idle session cannot change a credential — which
    // is the one change that would let somebody lock the real owner out.
    sessions.ensure_signed_in().await?;
    let view = sessions
        .snapshot()
        .await
        .ok_or_else(|| NOT_SIGNED_IN.to_string())?;

    let pool = ctx.pool;
    let Some(user) = load_user(pool, &view.user_id).await? else {
        sessions.clear().await;
        return Err("The signed-in account no longer exists.".to_string());
    };

    let ok = user
        .pin_hash
        .as_deref()
        .map(|stored| verify_secret(&current, stored))
        .unwrap_or(false);
    if !ok {
        audit(
            &pool,
            &user.store_id,
            "login_failed",
            Some(&user.id),
            Some(&user.id),
            Some("wrong current passphrase offered when changing it"),
        )
        .await;
        return Err("That is not your current passphrase.".to_string());
    }

    if current == next {
        return Err("The new passphrase is the same as the old one.".to_string());
    }
    check_secret_strength(user.role, &next)?;

    let hash = hash_secret(&next)?;
    sqlx::query(
        "UPDATE users
            SET pin_hash = ?, credential_algo = 'argon2id', credential_version = ?,
                credential_set_at = ?, must_change_pin = 0,
                failed_attempts = 0, locked_until = NULL
          WHERE id = ?",
    )
    .bind(&hash)
    .bind(CREDENTIAL_VERSION)
    .bind(now_iso())
    .bind(&user.id)
    .execute(pool)
    .await
    .map_err(|e| format!("cannot change the passphrase: {e}"))?;

    audit(
        &pool,
        &user.store_id,
        "credential_changed",
        Some(&user.id),
        Some(&user.id),
        None,
    )
    .await;

    // The session continues, on the NEW credential. Written before
    // `status_inner`, which reconciles: the order is what keeps the operator
    // signed in through their own change.
    sessions.restamp_credential(&user.id, &hash).await;

    sessions.unlock(false).await?;
    status_inner(ctx, sessions).await
}

/// Reset the owner passphrase with the one-time recovery code.
///
/// What this deliberately does NOT do, each of which was a requirement:
///
///   * It does not return the enrollment state to `virgin`. Migration 023's
///     lifecycle trigger makes that impossible regardless, which is the point
///     of putting the state in the database rather than inferring it.
///   * It does not let anybody but an OWNER of this store be the subject.
///   * It does not reveal any stored hash.
///   * It does not work twice: the code is marked used and a replacement is
///     issued in the SAME transaction, so there is never a moment with two live
///     codes and never one with none.
///   * It does not bypass throttling: wrong codes are counted and lock out.
pub(crate) async fn recover_owner_inner(
    ctx: &AuthCtx<'_>,
    sessions: &SessionState,
    recovery_code: String,
    user_id: String,
    new_passphrase: String,
) -> Result<EnrollmentResult, String> {
    // ONE ATTEMPT AT A TIME. Held across read-count -> verify -> write-count
    // so a fan-out of simultaneous guesses cannot all read the same counter.
    // See `SessionState::credential_gate`.
    let _attempt = sessions.credential_attempt()?;
    let pool = ctx.pool;
    let (store_id, _) = active_store(pool).await?;

    let live = sqlx::query(
        "SELECT id, code_hash, attempts, locked_until
           FROM owner_recovery
          WHERE store_id = ? AND used_at IS NULL",
    )
    .bind(&store_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("cannot read the recovery code: {e}"))?;

    let typed = normalise_code(&recovery_code);

    let Some(live) = live else {
        dummy_verify(&typed);
        audit(
            &pool,
            &store_id,
            "recovery_failed",
            None,
            None,
            Some("recovery attempted with no live code on file"),
        )
        .await;
        return Err(
            "There is no recovery code on file for this shop. Getting back in needs \
             support help with the database file."
                .to_string(),
        );
    };

    let recovery_id: String = live.try_get("id").map_err(|e| format!("id: {e}"))?;
    let stored: String = live
        .try_get("code_hash")
        .map_err(|e| format!("code_hash: {e}"))?;
    let attempts: i64 = live
        .try_get::<Option<i64>, _>("attempts")
        .map_err(|e| format!("attempts: {e}"))?
        .unwrap_or(0);

    if live
        .try_get::<Option<String>, _>("locked_until")
        .ok()
        .flatten()
        .filter(|v: &String| !v.is_empty())
        .is_some_and(|u| still_in_future(&u))
    {
        return Err("Too many wrong recovery codes. Wait fifteen minutes.".to_string());
    }

    if !verify_secret(&typed, &stored) {
        let next = attempts + 1;
        let lock_until = if next >= MAX_CODE_ATTEMPTS {
            Some(iso_in_secs(CODE_LOCKOUT_SECS))
        } else {
            None
        };
        sqlx::query("UPDATE owner_recovery SET attempts = ?, locked_until = ? WHERE id = ?")
            .bind(next)
            .bind(&lock_until)
            .bind(&recovery_id)
            .execute(pool)
            .await
            .map_err(|e| format!("cannot record the failed attempt: {e}"))?;
        audit(
            &pool,
            &store_id,
            "recovery_failed",
            None,
            None,
            Some(&format!("wrong recovery code (attempt {next})")),
        )
        .await;
        return Err("That recovery code is not right.".to_string());
    }

    let Some(user) = load_user(pool, &user_id).await? else {
        return Err("That account does not exist.".to_string());
    };
    if user.store_id != store_id || user.role != Role::Owner || !user.active {
        audit(
            &pool,
            &store_id,
            "recovery_failed",
            None,
            None,
            Some("recovery named an account that is not an active owner of this shop"),
        )
        .await;
        return Err(
            "A recovery code can only reset an owner account of this shop.".to_string(),
        );
    }
    check_secret_strength(Role::Owner, &new_passphrase)?;

    let hash = hash_secret(&new_passphrase)?;
    let replacement = mint_code();
    let replacement_hash = hash_secret(&normalise_code(&replacement))?;
    let at = now_iso();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("cannot begin the recovery transaction: {e}"))?;

    sqlx::query("UPDATE owner_recovery SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .bind(&at)
        .bind(&recovery_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot spend the recovery code: {e}"))?;

    sqlx::query(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
         VALUES (?, ?, ?, 'argon2id', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&store_id)
    .bind(&replacement_hash)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot issue the replacement recovery code: {e}"))?;

    sqlx::query(
        "UPDATE users
            SET pin_hash = ?, credential_algo = 'argon2id', credential_version = ?,
                credential_set_at = ?, failed_attempts = 0, locked_until = NULL,
                must_change_pin = 0
          WHERE id = ?",
    )
    .bind(&hash)
    .bind(CREDENTIAL_VERSION)
    .bind(&at)
    .bind(&user.id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("cannot set the new passphrase: {e}"))?;

    // Same argument: a committed owner-credential reset with no record of it
    // is the one state that makes the recovery trail untrue.
    audit_tx(
        &mut tx,
        &store_id,
        "recovery_used",
        Some(&user.id),
        None,
        Some("owner passphrase reset with the one-time recovery code; a replacement was issued"),
    )
    .await?;
    audit_tx(&mut tx, &store_id, "credential_reset", Some(&user.id), None, None).await?;

    tx.commit()
        .await
        .map_err(|e| format!("cannot commit the recovery: {e}"))?;

    // Recovery does NOT sign anybody in. Whoever just used the code should
    // prove the passphrase they have chosen, which also confirms they typed it
    // as they intended.
    sessions.clear().await;

    Ok(EnrollmentResult {
        status: status_inner(ctx, sessions).await?,
        recovery_code: replacement,
    })
}

// ===========================================================================
// The Tauri command surface — THIN BY CONSTRUCTION
// ===========================================================================
//
// Each wrapper does exactly three things: require the primary window, resolve
// the context, delegate. No security decision is taken here, so no security
// decision is beyond the reach of a test.
//
// `auth_status` is the ONLY one of these callable with no session. It is what
// the pre-login boot runs on, which is what lets the renderer's read channel be
// session-gated with no allowlist of "harmless" pre-login queries.

macro_rules! auth_command {
    ($name:ident -> $inner:ident, $ret:ty $(, $arg:ident : $ty:ty)*) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            window: tauri::Window,
            db_state: State<'_, DbState>,
            sessions: State<'_, SessionState>,
            $($arg: $ty),*
        ) -> Result<$ret, String> {
            require_primary_window(&window)?;
            let pool = auth_pool(&app, &db_state).await?;
            let ctx = AuthCtx::from_runtime(&app, &pool, &window)?;
            $inner(&ctx, &sessions $(, $arg)*).await
        }
    };
}

auth_command!(auth_status -> status_inner, AuthStatus);
auth_command!(auth_logout -> logout_inner, AuthStatus);
auth_command!(auth_lock -> lock_inner, AuthStatus);
auth_command!(auth_login -> login_inner, AuthStatus, user_id: String, secret: String);
auth_command!(auth_unlock -> unlock_inner, AuthStatus, secret: String);
auth_command!(
    auth_change_credential -> change_credential_inner,
    AuthStatus,
    current: String,
    next: String
);
auth_command!(
    auth_enroll_owner -> enroll_owner_inner,
    EnrollmentResult,
    enrollment_code: String,
    user_id: String,
    passphrase: String
);
auth_command!(
    auth_recover_owner -> recover_owner_inner,
    EnrollmentResult,
    recovery_code: String,
    user_id: String,
    new_passphrase: String
);

/// Defer the idle lock. The one command with no database access at all, so it
/// can be called on ordinary interaction without putting load on the till.
#[tauri::command]
pub async fn auth_touch(
    window: tauri::Window,
    sessions: State<'_, SessionState>,
) -> Result<u64, String> {
    require_primary_window(&window)?;
    sessions.touch().await?;
    Ok(IDLE_LOCK_AFTER.as_secs())
}

// ===========================================================================
// Test-only accessors
// ===========================================================================

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub(crate) fn hash(secret: &str) -> String {
        hash_secret(secret).expect("hash")
    }
    pub(crate) fn verify(secret: &str, stored: &str) -> bool {
        verify_secret(secret, stored)
    }
    pub(crate) fn code() -> String {
        mint_code()
    }
    pub(crate) fn normalise(typed: &str) -> String {
        normalise_code(typed)
    }
    pub(crate) fn strength(role: Role, secret: &str) -> Result<(), String> {
        check_secret_strength(role, secret)
    }
    pub(crate) fn idle_limit() -> Duration {
        IDLE_LOCK_AFTER
    }
    pub(crate) fn max_failed_attempts() -> i64 {
        MAX_FAILED_ATTEMPTS
    }
    pub(crate) fn credential_version() -> i64 {
        CREDENTIAL_VERSION
    }
    pub(crate) fn min_passphrase_len() -> usize {
        MIN_PASSPHRASE_LEN
    }
    pub(crate) fn fingerprint(pin_hash: Option<&str>) -> Option<String> {
        credential_fingerprint(pin_hash)
    }
}
