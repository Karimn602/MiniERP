//! ONE GREAZ PER IDENTITY PER WINDOWS USER (GZ-A1-R2).
//!
//! WHY. Sessions are process-local (`auth::SessionState`), so two copies of the
//! application against the same database were two independent authorities: a
//! cashier signed in on one and an owner on the other, each passing its own
//! session gate, each holding its own pools. The credential-fingerprint
//! revocation in Stage B.3 limits what that can do, but it is a mitigation for a
//! state that should not exist. Two instances also defeat the WAL shutdown
//! signal `docs/BACKUP.md` relies on: the first to exit cannot checkpoint while
//! the second still holds a connection.
//!
//! HOW. A named Win32 mutex, created in `lib::run` BEFORE the Tauri builder —
//! so before `tauri-plugin-sql` opens or migrates the database. A second
//! process finds the name already exists, shows a native message and exits
//! without touching the file.
//!
//! * **`Global\` namespace**, so it holds across Windows sessions on the same
//!   machine (fast user switching, a second RDP session), not merely within
//!   one desktop session. Creating a MUTEX in `Global\` needs no special
//!   privilege (that is file mappings).
//! * **Keyed by the bundle identifier AND the Windows user** — the SID from
//!   the process's own access token, which neither the process nor whoever
//!   launched it can change (see [`current_user`]). The database
//!   lives under `%APPDATA%\<identifier>`, which is per-user, so two different
//!   Windows accounts never share a file and must not block each other; and a
//!   disposable test identity never blocks the production one.
//! * **Released by the OS when the process ends**, however it ends. There is no
//!   lock file to go stale after a crash or a power cut, which is the failure
//!   that makes file-based locks unacceptable on a till.
//! * **Fails closed.** If the mutex cannot be created or opened for any reason
//!   other than "it does not exist yet", the application refuses to start and
//!   says why: an instance check that silently passes on error is not a check.
//!
//! No crate: `kernel32` is already linked into every Windows process, and the
//! three imports are declared inline, the same way `lib.rs` declares
//! `MessageBoxW`.

/// Holds the mutex for the life of the process. Dropping it releases the name.
pub(crate) struct InstanceGuard {
    #[cfg(windows)]
    handle: *mut core::ffi::c_void,
}

// The handle is only ever closed, once, in `Drop`.
unsafe impl Send for InstanceGuard {}
unsafe impl Sync for InstanceGuard {}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstanceError {
    /// Another process (or this one, earlier) holds the name.
    AlreadyRunning,
    /// The OS refused to create or open it, with the Win32 error code.
    Unavailable(u32),
}

/// The mutex name for an identity and user. Backslashes are the only character
/// a kernel object name may not contain after the namespace prefix.
pub(crate) fn mutex_name(identifier: &str, user: &str) -> String {
    let clean = |s: &str| s.replace('\\', "_");
    format!("Global\\GreazPOS.{}.{}", clean(identifier), clean(user))
}

/// The current Windows user, for the mutex name: the SID string from this
/// process's own ACCESS TOKEN.
///
/// Not `USERNAME`. Independent review: that is an environment variable, so a
/// second process launched with a different value would compute a different
/// mutex name while still opening the same `%APPDATA%` database — the guard
/// bypassed by `set USERNAME=x`. The token's user SID cannot be changed by the
/// process or its launcher. `Err` carries the Win32 error and is fail-closed in
/// `lib::run`: an instance check that cannot identify the user does not pass.
#[cfg(windows)]
pub(crate) fn current_user() -> Result<String, u32> {
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER_CLASS: u32 = 1;
    // SAFETY: every out-pointer is to a local of the declared type; the token
    // handle is closed on every path; the buffer is sized by the first
    // `GetTokenInformation` call and outlives every read of the SID inside it;
    // the string `ConvertSidToStringSidW` allocates is read up to its NUL and
    // released with `LocalFree`, as documented.
    unsafe {
        let mut token: *mut core::ffi::c_void = std::ptr::null_mut();
        if ffi::OpenProcessToken(ffi::GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(ffi::GetLastError());
        }
        let mut needed: u32 = 0;
        ffi::GetTokenInformation(token, TOKEN_USER_CLASS, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            let e = ffi::GetLastError();
            ffi::CloseHandle(token);
            return Err(e);
        }
        // u64 storage so the TOKEN_USER struct (pointer first) is aligned.
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = ffi::GetTokenInformation(
            token,
            TOKEN_USER_CLASS,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        let err = ffi::GetLastError();
        ffi::CloseHandle(token);
        if ok == 0 {
            return Err(err);
        }
        // TOKEN_USER { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes } }:
        // the SID pointer is the first field.
        let sid = *(buf.as_ptr() as *const *mut core::ffi::c_void);
        let mut text: *mut u16 = std::ptr::null_mut();
        if ffi::ConvertSidToStringSidW(sid, &mut text) == 0 {
            return Err(ffi::GetLastError());
        }
        let mut len = 0usize;
        while *text.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        ffi::LocalFree(text.cast());
        Ok(s)
    }
}

#[cfg(not(windows))]
pub(crate) fn current_user() -> Result<String, u32> {
    Ok(std::env::var("USER").unwrap_or_default())
}

#[cfg(windows)]
mod ffi {
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateMutexW(
            attributes: *mut core::ffi::c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> *mut core::ffi::c_void;
        pub fn GetLastError() -> u32;
        pub fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        pub fn GetCurrentProcess() -> *mut core::ffi::c_void;
        pub fn LocalFree(mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }
    #[link(name = "advapi32")]
    extern "system" {
        pub fn OpenProcessToken(
            process: *mut core::ffi::c_void,
            access: u32,
            token: *mut *mut core::ffi::c_void,
        ) -> i32;
        pub fn GetTokenInformation(
            token: *mut core::ffi::c_void,
            class: u32,
            info: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        pub fn ConvertSidToStringSidW(
            sid: *mut core::ffi::c_void,
            text: *mut *mut u16,
        ) -> i32;
    }
    pub const ERROR_ALREADY_EXISTS: u32 = 183;
    pub const ERROR_ACCESS_DENIED: u32 = 5;
}

/// Claim the name, or report that somebody already has it.
#[cfg(windows)]
pub(crate) fn acquire(name: &str) -> Result<InstanceGuard, InstanceError> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsStr::new(name).encode_wide().chain(once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call;
    // null security attributes are documented as valid; the returned handle is
    // owned by the guard and closed exactly once in `Drop`.
    unsafe {
        let handle = ffi::CreateMutexW(std::ptr::null_mut(), 0, wide.as_ptr());
        let err = ffi::GetLastError();
        if handle.is_null() {
            // ACCESS_DENIED means the object EXISTS and we may not open it —
            // which is "already running" by any reading that matters.
            return Err(if err == ffi::ERROR_ACCESS_DENIED {
                InstanceError::AlreadyRunning
            } else {
                InstanceError::Unavailable(err)
            });
        }
        if err == ffi::ERROR_ALREADY_EXISTS {
            ffi::CloseHandle(handle);
            return Err(InstanceError::AlreadyRunning);
        }
        Ok(InstanceGuard { handle })
    }
}

#[cfg(not(windows))]
pub(crate) fn acquire(_name: &str) -> Result<InstanceGuard, InstanceError> {
    // This build ships on Windows only; elsewhere the check is not enforced.
    Ok(InstanceGuard {})
}

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful `CreateMutexW` and is
        // closed only here.
        unsafe {
            ffi::CloseHandle(self.handle);
        }
    }
}

/// The operator-facing text for the second instance.
pub(crate) const ALREADY_RUNNING_MESSAGE: &str = "Greaz POS is already open on this computer.\n\n\
Use the Greaz window that is already running - look for it on the taskbar. \
Only one copy may run at a time, so that two tills never write to the same \
data at once.\n\nIf you cannot find the window, sign out of Windows and back \
in, or restart the computer. Do NOT delete or move any Greaz files.";

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(tag: &str) -> String {
        mutex_name(
            &format!("com.greazlb.pos.test.{tag}.{}", std::process::id()),
            &current_user().expect("the token SID"),
        )
    }

    #[test]
    fn the_name_is_per_identity_and_per_user_and_global() {
        let a = mutex_name("com.greazlb.pos", "alice");
        assert!(a.starts_with("Global\\"));
        assert_ne!(a, mutex_name("com.greazlb.pos.v1rc", "alice"));
        assert_ne!(a, mutex_name("com.greazlb.pos", "bob"));
        assert!(!mutex_name("x", "DOMAIN\\user")["Global\\".len()..].contains('\\'));
    }

    #[cfg(windows)]
    #[test]
    fn a_second_claim_is_refused_while_the_first_is_held() {
        let name = unique("second");
        let first = acquire(&name).expect("the first claim succeeds");
        assert_eq!(acquire(&name).err(), Some(InstanceError::AlreadyRunning));
        drop(first);
        // Released: the name is claimable again, so a crash or exit never
        // leaves the till locked out.
        let again = acquire(&name).expect("released on drop");
        drop(again);
    }

    /// The key is the token SID, not an environment variable a launcher can
    /// change, so it is the same whatever USERNAME says.
    #[cfg(windows)]
    #[test]
    fn the_user_key_is_the_token_sid_not_the_environment() {
        let sid = current_user().expect("the token SID");
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert_ne!(Some(sid.as_str()), std::env::var("USERNAME").ok().as_deref());
    }

    #[cfg(windows)]
    #[test]
    fn different_identities_do_not_block_each_other() {
        let a = acquire(&unique("a")).expect("a");
        let b = acquire(&unique("b")).expect("b");
        drop((a, b));
    }
}
