//! ABOUT / CREDITS (V1.1.1) — opening the developer's profile in the browser.
//!
//! The same shape as `auth_open_enrollment_code`: a FIXED target, opened by
//! the operating system's own handler, from a command that takes NO argument.
//! The renderer therefore cannot ask this command to open anything else — not
//! another URL, not a file, not a program — and no `opener:*` permission is
//! granted to the renderer in `capabilities/default.json`, so the opener
//! plugin's own JavaScript API stays unreachable. The address lives here, in
//! Rust, and the About dialog only displays the copy it is told about.
//!
//! It touches no database, no session and no business state, so it needs no
//! sign-in: the only check is that the request came from the primary window,
//! like every other command that acts on the operator's behalf.

/// The developer's official profile, as supplied by the founder.
pub(crate) const DEVELOPER_PROFILE_URL: &str =
    "https://www.linkedin.com/in/omar-s-najjar-1b7994259/";

#[tauri::command]
pub fn open_developer_profile(window: tauri::Window) -> Result<(), String> {
    crate::auth::require_primary_window_label(window.label())?;
    tauri_plugin_opener::open_url(DEVELOPER_PROFILE_URL, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_url_is_the_founders_exact_https_linkedin_address() {
        assert_eq!(
            DEVELOPER_PROFILE_URL,
            "https://www.linkedin.com/in/omar-s-najjar-1b7994259/"
        );
        assert!(DEVELOPER_PROFILE_URL.starts_with("https://www.linkedin.com/in/"));
    }

    #[test]
    fn the_command_takes_no_target_from_the_renderer() {
        let src = include_str!("about.rs");
        let sig = src
            .split("pub fn open_developer_profile(")
            .nth(1)
            .and_then(|s| s.split(')').next())
            .expect("the command signature");
        assert_eq!(sig.trim(), "window: tauri::Window", "no URL may be passed in");
        // The renderer is given no opener permission; this command is the path.
        let caps = include_str!("../capabilities/default.json");
        assert!(!caps.contains("opener:"), "no opener permission for the renderer");
    }
}
