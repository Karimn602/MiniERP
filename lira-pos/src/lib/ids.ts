/**
 * Client-side UUID generation.
 *
 * Why client-side? Offline-first means a device might create thousands of
 * records before ever touching the cloud. Server-assigned IDs would force
 * us to either (a) block writes when offline, or (b) re-key everything
 * during sync — both unacceptable. UUIDv4 collision probability is
 * negligible (~2^-122) for our volume.
 */
export function newId(): string {
  // crypto.randomUUID is available in modern Chromium (Tauri's WebView2 on Win10+).
  return crypto.randomUUID();
}