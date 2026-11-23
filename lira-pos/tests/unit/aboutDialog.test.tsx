// @vitest-environment jsdom
/**
 * THE ABOUT DIALOG — developer credit (V1.1.1).
 *
 * Pins the founder-supplied profile address, the visible credit wording, and
 * the route by which the link opens: the fixed-target Rust command
 * `open_developer_profile`, never a WebView navigation. The Rust side pins the
 * same address and that the command takes no argument (`src-tauri/src/about.rs`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { I18nProvider } from "../../src/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { AboutButton, DEVELOPER_PROFILE_URL } from "../../src/components/AboutDialog";

const EXPECTED_URL = "https://www.linkedin.com/in/omar-s-najjar-1b7994259/";

function openDialog() {
  render(
    <I18nProvider>
      <AboutButton />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^v1\.2\.0/ }));
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("About dialog developer credit", () => {
  it("renders the credit and the founder's exact profile link", () => {
    const dialog = openDialog();
    expect(dialog.textContent).toContain("Developed by Omar Najjar");
    expect(dialog.textContent).toContain("Software Engineering & Business Solutions");
    expect(dialog.textContent).toContain("LinkedIn: View Developer Profile");

    const link = screen.getByRole("button", { name: "View Developer Profile" });
    expect(DEVELOPER_PROFILE_URL).toBe(EXPECTED_URL);
    expect(link.getAttribute("data-href")).toBe(EXPECTED_URL);
    expect(link.getAttribute("title")).toBe(EXPECTED_URL);
    // Not an in-WebView link: nothing in the dialog navigates the till.
    expect(dialog.querySelector("a")).toBeNull();
  });

  it("opens the profile externally through the fixed-target command, with no argument", async () => {
    invoke.mockResolvedValue(undefined);
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "View Developer Profile" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("open_developer_profile");
  });

  it("shows the address if the browser cannot be opened", async () => {
    invoke.mockRejectedValue("could not open the browser");
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "View Developer Profile" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", EXPECTED_URL);
  });

  it("the Rust command opens the same address", () => {
    const rust = readFileSync(resolve(__dirname, "../../src-tauri/src/about.rs"), "utf8");
    expect(rust).toContain(`"${EXPECTED_URL}"`);
  });

  it("the credit is not on the receipt, the kitchen ticket or the register", () => {
    for (const file of [
      "src/components/ReceiptPrint.tsx",
      "src/components/KitchenTicketPrint.tsx",
      "src/pages/PosRegister.tsx",
    ]) {
      const src = readFileSync(resolve(__dirname, "../..", file), "utf8");
      expect(src, file).not.toMatch(/Omar|linkedin|AboutDialog|DEVELOPER_/i);
    }
  });
});
