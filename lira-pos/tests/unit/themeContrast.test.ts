/**
 * Theme contrast — the failure pattern, pinned.
 *
 * Pilot 001 found the Shift Summary status banner rendering at 1.01:1 in
 * Midnight: white-ish text on a near-white box. The cause was not a bad colour
 * choice, it was a MIXED one. Greaz has two kinds of colour in its classNames:
 *
 *   - themed roles (`bg-good-bg`, `text-fg`, `text-slate-600`) resolve through
 *     CSS variables and INVERT when the appearance switches;
 *   - literal Tailwind hues (`bg-emerald-50`, `text-red-700`) are fixed hexes
 *     and do not.
 *
 * Put one of each on the same surface and the pair silently drifts apart:
 * `bg-emerald-50` stays #ECFDF5 while the `text-slate-900` inside it becomes
 * #FFF6F2. Both halves are reachable — a literal light BACKGROUND under themed
 * text (near-white on near-white), and literal dark status TEXT on a themed
 * surface that went dark (dark on dark, which is how `text-emerald-900` on
 * `bg-slate-50` measured 1.75:1).
 *
 * So there are two checks here, and they are deliberately different in kind:
 *
 *   1. VALUES — every semantic status role is read out of `src/index.css` and
 *      measured in both appearances. This fails if someone retunes a token to
 *      a value that is no longer AA, which no amount of grepping would catch.
 *   2. USAGE — no literal status hue may be used as a colour utility in app
 *      code. This fails if someone reintroduces the pattern, which no amount
 *      of measuring the tokens would catch.
 *
 * Neither check renders anything: there is no DOM or React renderer in this
 * suite (see theme.test.ts). Rendered-pixel verification is done against the
 * isolated design preview with computed styles, not here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

// ---------------------------------------------------------------------------
// WCAG 2.1 relative luminance and contrast ratio.
// ---------------------------------------------------------------------------
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(fg: number[], bg: number[]): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Read one appearance's token block out of index.css.
 *
 * Classic is the `:root, :root[data-theme="classic"]` block; Midnight only
 * overrides part of the set, so it is layered ON TOP of Classic — which is
 * exactly how the cascade resolves it in the browser. Reading Midnight alone
 * would test a palette that does not exist.
 */
function tokens(theme: "classic" | "midnight"): Record<string, number[]> {
  const classicStart = CSS.indexOf(':root[data-theme="classic"]');
  const midnightStart = CSS.indexOf(':root[data-theme="midnight"]');
  expect(classicStart).toBeGreaterThan(-1);
  expect(midnightStart).toBeGreaterThan(-1);

  const read = (from: number) => {
    const open = CSS.indexOf("{", from);
    const close = CSS.indexOf("\n}", open);
    const out: Record<string, number[]> = {};
    for (const m of CSS.slice(open, close).matchAll(
      /--((?:greaz|slate)[\w-]*)\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g,
    )) {
      out[m[1].replace(/^greaz-/, "")] = [Number(m[2]), Number(m[3]), Number(m[4])];
    }
    return out;
  };

  const classic = read(classicStart);
  return theme === "classic" ? classic : { ...classic, ...read(midnightStart) };
}

const THEMES = ["classic", "midnight"] as const;
const PALETTE = { classic: tokens("classic"), midnight: tokens("midnight") };

/** Surfaces a status message can actually land on. */
const SURFACES = ["surface", "paper", "page", "slate-50", "slate-100"];
const ROLES = ["good", "warn", "danger", "info"] as const;

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe("status token values", () => {
  it("defines every role in both appearances", () => {
    for (const theme of THEMES) {
      for (const role of ROLES) {
        for (const part of ["", "-bg", "-line", "-fg"]) {
          expect(
            PALETTE[theme][`${role}${part}`],
            `--greaz-${role}${part} missing from ${theme}`,
          ).toBeDefined();
        }
      }
    }
  });

  // The headline guarantee. `-fg` is the ONLY variant promised as text, and it
  // is promised on its own tinted box AND on every plain surface, because a
  // validation message sits on a card far more often than in a coloured box.
  it.each(THEMES)("keeps every status -fg readable as text on %s", (theme) => {
    const p = PALETTE[theme];
    for (const role of ROLES) {
      for (const bg of [`${role}-bg`, ...SURFACES]) {
        const r = contrast(p[`${role}-fg`], p[bg]);
        expect(
          r,
          `text-${role}-fg on bg-${bg} (${theme}) is ${r.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  // Why the `-fg` rule above is worded so narrowly: the bare accent FAILS as
  // text on Classic (`good` is 3.77:1, `warn` 2.70:1). It is a dot/icon
  // colour. Asserting that here stops a future edit from "simplifying"
  // text-good-fg to text-good and quietly dropping below AA.
  // The bare accent has exactly two jobs in this codebase, and the assertion
  // follows the jobs rather than every pairing that could be written:
  //
  //   - a FILL carrying `text-ink-900` (the low-stock pill, the POS "open a
  //     shift" chip) — the text on it must be AA;
  //   - the shift-open DOT sitting on `good-bg` — decorative, so 3:1.
  //
  // It is NOT an icon colour on a tinted box: `warn` on `warn-bg` is 2.56:1 on
  // Classic, which is why the two hazard icons on the POS shift warning use
  // `text-warn-fg` and match the sentence beside them.
  it("holds the bare accent to the two jobs it actually has", () => {
    const ink900 = [26, 22, 22]; // text-ink-900, literal in both appearances
    for (const theme of THEMES) {
      // `bg-warn` is the only accent used as an ink-bearing fill: the low-stock
      // pill in the rail and the "open a shift" chip on the register.
      const onWarnFill = contrast(ink900, PALETTE[theme].warn);
      expect(
        onWarnFill,
        `text-ink-900 on bg-warn (${theme}) is ${onWarnFill.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);

      // `bg-good` is the only accent used as a dot on its own tinted box.
      const dot = contrast(PALETTE[theme].good, PALETTE[theme]["good-bg"]);
      expect(
        dot,
        `the shift-open dot, bg-good on bg-good-bg (${theme}), is ${dot.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
    // Classic's good/warn accents are below AA as text. This is the reason the
    // migration maps every `text-emerald-*` to `-fg` and never to the accent.
    expect(
      contrast(PALETTE.classic.good, PALETTE.classic.surface),
    ).toBeLessThan(AA_TEXT);
    expect(
      contrast(PALETTE.classic.warn, PALETTE.classic.surface),
    ).toBeLessThan(AA_TEXT);
  });

  // Filled controls. `good-solid` exists because the accent could not carry a
  // label: the selected "+" direction toggle was white on emerald-600, 3.77:1,
  // which failed in BOTH appearances before this correction.
  it.each(THEMES)("keeps solid status fills readable on %s", (theme) => {
    const p = PALETTE[theme];
    for (const role of ["good", "danger"]) {
      const r = contrast(p[`${role}-solid-fg`], p[`${role}-solid`]);
      expect(
        r,
        `text-${role}-solid-fg on bg-${role}-solid (${theme}) is ${r.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  // A status box must be distinguishable from the page, or "warning" reads as
  // ordinary content. Borders are non-text.
  it.each(THEMES)("keeps status boxes distinguishable from the page on %s", (theme) => {
    const p = PALETTE[theme];
    for (const role of ROLES) {
      expect(
        contrast(p[`${role}-line`], p[`${role}-bg`]),
        `border-${role}-line on bg-${role}-bg (${theme})`,
      ).toBeGreaterThanOrEqual(1.2);
      expect(p[`${role}-bg`]).not.toEqual(p.surface);
    }
  });

  // Success / warning / danger / info must not collapse into each other.
  it.each(THEMES)("keeps the four status roles mutually distinct on %s", (theme) => {
    const seen = new Map<string, string>();
    for (const role of ROLES) {
      for (const part of ["-bg", "-fg"]) {
        const key = PALETTE[theme][`${role}${part}`].join(",");
        expect(
          seen.has(key) ? `${role}${part} duplicates ${seen.get(key)}` : "ok",
        ).toBe("ok");
        seen.set(key, `${role}${part}`);
      }
    }
  });

  // The receipt preview and the print root pin the palette back to Classic so
  // a thermal receipt is black on white whichever appearance is active. The
  // status roles are now themed, so they have to be pinned there too or a
  // status colour reaching a receipt would print at its Midnight value.
  it("pins the status roles inside the appearance-independent print roots", () => {
    const paperDoc = CSS.slice(
      CSS.indexOf(".greaz-paper-doc"),
      CSS.indexOf("}", CSS.indexOf(".greaz-paper-doc")),
    );
    const printRoot = CSS.slice(CSS.indexOf("@media print"));
    for (const role of ROLES) {
      for (const part of ["-fg", "-bg", "-line"]) {
        expect(paperDoc, `.greaz-paper-doc must pin --greaz-${role}${part}`).toContain(
          `--greaz-${role}${part}:`,
        );
        expect(printRoot, `@media print must pin --greaz-${role}${part}`).toContain(
          `--greaz-${role}${part}:`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// USAGE: the pattern itself.
// ---------------------------------------------------------------------------
const LITERAL_STATUS_UTILITY =
  /(?:^|["'\s`])(?:[a-z][a-z0-9-]*:)*(?:bg|text|border|ring|divide|placeholder)-(?:emerald|green|red|rose|amber|yellow|orange)-\d{2,3}/;
/** The same pattern, global, so every literal on a line is evaluated. */
const LITERAL_STATUS_UTILITY_ALL = new RegExp(
  LITERAL_STATUS_UTILITY.source,
  "g",
);

/**
 * Files allowed to keep a literal status hue, each for a stated reason.
 *
 * This is an allowlist of FILES rather than of lines so it stays readable, and
 * every entry carries why. Two reasons only:
 *
 *   - the sandbox hazard strip is deliberately identical in both appearances;
 *     it is a safety notice, not themed chrome, and its colours are
 *     self-paired (amber-950 on amber-500) so they cannot drift;
 *   - the movement-type and ledger-entry-type badges are CATEGORICAL palettes
 *     — six to eight kinds that must be told apart at a glance, not four
 *     status levels. Half-migrating them collapsed `return_out` and
 *     `adjustment` into one colour. They are self-paired (literal bg + literal
 *     text) so they are readable in both appearances; they are off-theme on
 *     Midnight, and they need a categorical token family, which is a design
 *     decision rather than an accessibility fix.
 */
const ALLOWED = new Map<string, RegExp>([
  ["components/SandboxBanner.tsx", /amber/],
  // Both halves of each categorical pair. Only the `-100` backgrounds were
  // listed before, because the scanner stopped at the first match on the line
  // and so never reached the `-800` text beside it. The pair is proved AA and
  // self-paired by "categorical badges stay self-paired" below.
  ["pages/Inventory.tsx", /(emerald|orange|amber)-(100|800)/],
  ["pages/SupplierDetail.tsx", /(emerald|amber)-(100|800)/],
  ["preview/StatesPreview.tsx", /./], // the before/after gallery, not shipped
]);

/**
 * Source lines paired with their 1-based numbers, with comment-only lines
 * dropped.
 *
 * The scanners below look for utilities by name, and those names also appear in
 * prose: the comments in this file and in the preview galleries discuss
 * `text-slate-400` and `text-brand` by name, and the pass-2 gallery prints them
 * in its own captions. A className never sits on a comment-only line, so
 * dropping those removes a whole class of false positive without weakening the
 * check on real code — including the categorical badge maps, whose entries are
 * bare `"bg-x-100 text-x-800"` strings with no `className` anywhere near them.
 */
function codeLines(file: string): [number, string][] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, i): [number, string] => [i + 1, line])
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("status colour usage", () => {
  it("uses no literal Tailwind status hue outside the documented exceptions", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      const allow = ALLOWED.get(rel);
      codeLines(file).forEach(([lineNo, line]) => {
          // EVERY literal on the line, not just the first. `line.match` with a
          // non-global regex returns one match, so a line whose first hue was
          // allowlisted hid every later hue on that same line — and these are
          // long `clsx` lines carrying several utilities each. That is how a
          // real offender could sit behind an allowed `emerald-100`.
          for (const m of line.matchAll(LITERAL_STATUS_UTILITY_ALL)) {
            if (allow && allow.test(m[0])) continue;
            offenders.push(`${rel}:${lineNo}  ${m[0].trim()}`);
          }
        });
    }
    expect(offenders, `use the semantic role instead:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("uses no hardcoded hex colour utility except the GREAZ wordmark", () => {
    // A raw `text-[#F5C35A]` is invisible to any class-name audit, which is how
    // the sandbox rail label stayed at 1.56:1 on Classic. The wordmark is a
    // logotype (WCAG 1.4.3 exempts it) and carries its own text-shadow.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      codeLines(file).forEach(([lineNo, line]) => {
          for (const m of line.matchAll(
            /(?:text|bg|border|ring|divide)-\[#[0-9A-Fa-f]{3,8}\]/g,
          )) {
            if (rel === "components/AppShell.tsx" && m[0] === "text-[#EF2442]") continue;
            offenders.push(`${rel}:${lineNo}  ${m[0]}`);
          }
        });
    }
    expect(offenders, `theme these through a token:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// PRODUCTION COMBINATIONS: the pairs the interface actually renders.
//
// The two suites above check token VALUES and literal-hue USAGE. Neither
// catches the second class of defect the review found, which was not a literal
// hue at all: a themed token used in a place its contrast does not hold. The
// menu price was `text-brand` — a correct, themed, non-literal token — on a
// themed tile, and it measured 3.52:1 because `--greaz-brand` is a FILL colour
// being asked to carry letterforms.
//
// So each row below names a real component, the tokens it pairs, and the font
// metrics it renders at, and derives the WCAG threshold from those metrics
// rather than from a hand-typed number.
//
// Every row also carries a PROOF: a substring that must still be present in
// the named file. Without it this table would slowly become a set of
// assertions about combinations the interface no longer has — passing forever
// while the screen regressed. If a proof fails, the component changed and the
// row must be re-derived from it, which is the intended outcome.
// ---------------------------------------------------------------------------

/** Composite a translucent layer over an opaque backdrop. */
function over(fg: number[], alpha: number, bg: number[]): number[] {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha));
}

/**
 * WCAG 2.2 1.4.3. Large text is >=24px, or >=18.66px at weight >=700.
 * Everything else is normal text and owes 4.5:1.
 */
function required(px: number, weight: number): number {
  return px >= 24 || (px >= 18.66 && weight >= 700) ? AA_NON_TEXT : AA_TEXT;
}

type Combo = {
  /** Component and what the user sees. */
  where: string;
  /** File under src/, and a substring proving this pairing is still rendered. */
  file: string;
  proof: string;
  fg: string;
  bg: string;
  /** Translucent text (an `opacity-*` ancestor). */
  fgAlpha?: number;
  /** A translucent wash over `bg`, as the F5 key cap has. */
  bgWash?: { color: number[]; alpha: number };
  px: number;
  weight: number;
  /**
   * Raise the bar above what the metrics alone demand. Used for ACTIVE
   * FINANCIAL figures: a cashier reads these out and keys them in, and a total
   * that is merely "large enough to be decorative" is not good enough at a
   * till.
   */
  min?: number;
};

const COMBOS: Combo[] = [
  // --- 1. Menu price, Classic and Midnight, including the squat layout -----
  {
    where: "menu tile price, squat layout (the 1366x768 till)",
    file: "components/pos/MenuTile.tsx",
    proof: "text-brand-ink squat:text-[22px]",
    fg: "brand-ink",
    bg: "tile",
    // Impact at 22px/400. This does NOT qualify as large text, which is why
    // the price needed a colour fix rather than a size bump.
    px: 22,
    weight: 400,
  },
  {
    where: "menu tile price, full layout",
    file: "components/pos/MenuTile.tsx",
    proof: "text-[24px] leading-none text-brand-ink",
    fg: "brand-ink",
    bg: "tile",
    px: 24,
    weight: 400,
    min: AA_TEXT, // 24px is large text, but a price is an active figure.
  },
  {
    where: "menu tile name",
    file: "components/pos/MenuTile.tsx",
    proof: "text-fg",
    fg: "fg",
    bg: "tile",
    px: 12,
    weight: 700,
  },
  {
    where: "menu tile meta line",
    file: "components/pos/MenuTile.tsx",
    proof: "text-[10px] leading-tight text-fg-muted",
    fg: "fg-muted",
    bg: "tile",
    px: 10,
    weight: 400,
  },
  {
    where: "menu tile out-of-stock pill",
    file: "components/pos/MenuTile.tsx",
    proof: "bg-warn-bg",
    fg: "warn-fg",
    bg: "warn-bg",
    px: 9,
    weight: 800,
  },

  // --- 2. Financial values and captions ------------------------------------
  {
    where: "shift summary muted financial value",
    file: "pages/ShiftSummary.tsx",
    proof: '? "text-fg-muted"',
    fg: "fg-muted",
    bg: "surface",
    px: 24,
    weight: 700,
    min: AA_TEXT, // an active financial value, not decoration
  },
  {
    where: "shift summary caption under a value (incl. the VAT-reversed hint)",
    file: "pages/ShiftSummary.tsx",
    proof: "text-xs text-fg-muted",
    fg: "fg-muted",
    bg: "surface",
    px: 12,
    weight: 400,
  },
  {
    where: "shift summary drawer row label",
    file: "pages/ShiftSummary.tsx",
    proof: "text-slate-600",
    fg: "slate-600",
    bg: "surface",
    px: 14,
    weight: 400,
  },
  {
    where: "shift summary USD/LBP column caption",
    file: "pages/ShiftSummary.tsx",
    proof: "uppercase tracking-wide text-fg-muted",
    fg: "fg-muted",
    bg: "surface",
    px: 12,
    weight: 600,
  },
  {
    where: "inventory valuation card caption (excl. VAT)",
    file: "pages/Inventory.tsx",
    proof: "text-xs text-fg-muted",
    fg: "fg-muted",
    bg: "surface",
    px: 12,
    weight: 400,
  },
  {
    where: "StatCard label (output VAT, VAT reversed)",
    file: "components/ui/StatCard.tsx",
    proof: "uppercase tracking-wide text-fg-muted",
    fg: "fg-muted",
    bg: "surface",
    px: 11,
    weight: 600,
  },
  {
    where: "StatCard hint",
    file: "components/ui/StatCard.tsx",
    proof: "text-xs text-fg-subtle",
    fg: "fg-subtle",
    bg: "surface",
    px: 12,
    weight: 400,
  },
  {
    where: "StatCard brand-tone value",
    file: "components/ui/StatCard.tsx",
    proof: '? "text-brand-ink"',
    fg: "brand-ink",
    bg: "surface",
    px: 24,
    weight: 700,
    min: AA_TEXT, // an active financial value
  },

  // --- 3. LBP amount-due equivalent ----------------------------------------
  {
    where: "checkout amount due, the big figure",
    file: "components/pos/OrderRail.tsx",
    proof: "bg-brand px-[15px] py-[15px] text-brand-fg",
    fg: "brand-fg",
    bg: "brand",
    px: 24, // the squat size; 29px at full width
    weight: 400,
    min: AA_TEXT, // the total the customer pays
  },
  {
    where: "checkout amount due, lira equivalent row",
    file: "components/pos/OrderRail.tsx",
    // The `opacity-90` this row used to carry is the defect; its absence from
    // the className is what this proof pins.
    proof: 'justify-between gap-3 text-[11px]">',
    fg: "brand-fg",
    bg: "brand",
    px: 11,
    weight: 400,
  },
  {
    where: "checkout amount due label",
    file: "components/pos/OrderRail.tsx",
    proof: "text-[11px] font-black uppercase tracking-wide",
    fg: "brand-fg",
    bg: "brand",
    px: 11,
    weight: 900,
  },

  // --- 4. Hero kicker and subtitle -----------------------------------------
  {
    where: "hero band kicker",
    file: "components/ui/PageHeader.tsx",
    proof: "text-banner-kicker",
    fg: "banner-kicker",
    bg: "banner",
    px: 10,
    weight: 900,
  },
  {
    where: "hero band subtitle",
    file: "components/ui/PageHeader.tsx",
    proof: "text-banner-sub",
    fg: "banner-sub",
    bg: "banner",
    px: 11,
    weight: 400,
  },
  {
    where: "hero band title",
    file: "components/ui/PageHeader.tsx",
    proof: "greaz-poster",
    fg: "banner-fg",
    bg: "banner",
    px: 21, // the tiny breakpoint: the smallest it ever renders
    weight: 400,
  },
  {
    where: "non-hero page eyebrow",
    file: "components/ui/PageHeader.tsx",
    proof: "font-eyebrow text-[10px] text-brand-ink",
    fg: "brand-ink",
    bg: "page",
    px: 10,
    weight: 700,
  },

  // --- 5. The F5 shortcut on the post-sale button ---------------------------
  {
    where: "post-sale button F5 key cap",
    file: "pages/PosRegister.tsx",
    proof: "bg-black/20 px-1.5 py-0.5 text-[10px]",
    fg: "brand-fg",
    bg: "brand",
    bgWash: { color: [0, 0, 0], alpha: 0.2 },
    px: 10,
    weight: 600,
  },

  // --- 6. Workspace label ---------------------------------------------------
  {
    where: "top-bar workspace label",
    file: "components/AppShell.tsx",
    proof: "text-[10px] text-fg-subtle",
    fg: "fg-subtle",
    bg: "surface",
    px: 10,
    weight: 700,
  },
  {
    where: "cart line remove glyph",
    file: "components/pos/OrderRail.tsx",
    proof: "rounded-full text-fg-subtle",
    fg: "fg-subtle",
    bg: "paper",
    px: 12,
    weight: 400,
  },

  // --- 7. Active status, warning and error text -----------------------------
  {
    where: "shift-open status banner",
    file: "pages/ShiftSummary.tsx",
    proof: "bg-good-bg",
    fg: "good-fg",
    bg: "good-bg",
    px: 14,
    weight: 600,
  },
  {
    where: "no-open-shift error banner",
    file: "pages/ShiftSummary.tsx",
    proof: "bg-danger-bg",
    fg: "danger-fg",
    bg: "danger-bg",
    px: 14,
    weight: 400,
  },
  {
    where: "exchange-rate missing warning",
    file: "pages/ExchangeRate.tsx",
    proof: "bg-warn-bg",
    fg: "warn-fg",
    bg: "warn-bg",
    px: 14,
    weight: 400,
  },
  {
    where: "field validation error message",
    file: "components/ui/Input.tsx",
    proof: "text-danger-fg",
    fg: "danger-fg",
    bg: "surface",
    px: 12,
    weight: 400,
  },
  {
    where: "refund/return cash-unavailable warning",
    file: "components/CreateReturnModal.tsx",
    proof: "text-warn-fg",
    fg: "warn-fg",
    bg: "warn-bg",
    px: 14,
    weight: 400,
  },
  {
    where: "POS shift warning hint (carries opacity-90)",
    file: "pages/PosRegister.tsx",
    proof: "text-warn-fg opacity-90",
    fg: "warn-fg",
    bg: "warn-bg",
    fgAlpha: 0.9,
    px: 10,
    weight: 400,
  },
];

describe("rendered production combinations", () => {
  it("names a pairing that the component still renders", () => {
    const stale = COMBOS.filter(
      (c) => !readFileSync(join(SRC, c.file), "utf8").includes(c.proof),
    ).map((c) => `${c.file}  no longer contains  ${c.proof}  (${c.where})`);
    expect(
      stale,
      `re-derive these rows from the component as it now stands:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it.each(THEMES)("meets the WCAG AA threshold for its metrics on %s", (theme) => {
    const p = PALETTE[theme];
    const failures: string[] = [];
    for (const c of COMBOS) {
      expect(p[c.fg], `--greaz-${c.fg} missing from ${theme}`).toBeDefined();
      expect(p[c.bg], `--greaz-${c.bg} missing from ${theme}`).toBeDefined();

      const bg = c.bgWash ? over(c.bgWash.color, c.bgWash.alpha, p[c.bg]) : p[c.bg];
      const fg = c.fgAlpha === undefined ? p[c.fg] : over(p[c.fg], c.fgAlpha, bg);
      const need = Math.max(required(c.px, c.weight), c.min ?? 0);
      const r = contrast(fg, bg);
      if (r < need) {
        failures.push(
          `${r.toFixed(2)}:1 < ${need}:1  ${c.where} — text-${c.fg} on bg-${c.bg}` +
            ` at ${c.px}px/${c.weight} (${c.file})`,
        );
      }
    }
    expect(failures, `below AA on ${theme}:\n${failures.join("\n")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The brand red is a FILL. Letterforms use `brand-ink`.
// ---------------------------------------------------------------------------
describe("brand red as text", () => {
  it.each(THEMES)("keeps brand-ink readable on every surface on %s", (theme) => {
    const p = PALETTE[theme];
    for (const bg of ["surface", "paper", "page", "tile", "rail", "slate-50"]) {
      const r = contrast(p["brand-ink"], p[bg]);
      expect(
        r,
        `text-brand-ink on bg-${bg} (${theme}) is ${r.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  // Why `brand-ink` has to exist at all. The fill is below AA as text on
  // Midnight, so "simplifying" text-brand-ink back to text-brand reintroduces
  // the menu-price defect exactly.
  it("records that the brand FILL cannot carry text on Midnight", () => {
    const r = contrast(PALETTE.midnight.brand, PALETTE.midnight.tile);
    expect(r).toBeLessThan(AA_TEXT);
    // Classic needed no adjustment and gets none: the two are the same colour.
    expect(PALETTE.classic["brand-ink"]).toEqual(PALETTE.classic.brand);
  });

  // `text-brand` survives in exactly one place: the return-modal checkbox,
  // where it is the control's checked FILL and the tick on it is white.
  // Everywhere else a bare `text-brand` is the defect.
  it("uses no bare text-brand outside the documented checkbox fill", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (rel === "preview/StatesPreview.tsx") continue;
      codeLines(file).forEach(([lineNo, line]) => {
          for (const m of line.matchAll(/\btext-brand(?![-\w/])/g)) {
            if (
              rel === "components/CreateReturnModal.tsx" &&
              line.includes("h-4 w-4 rounded")
            ) {
              continue;
            }
            offenders.push(`${rel}:${lineNo}  ${m[0]}`);
          }
        });
    }
    expect(
      offenders,
      `brand letterforms use text-brand-ink:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("pins brand-ink inside the appearance-independent print roots", () => {
    const paperDoc = CSS.slice(
      CSS.indexOf(".greaz-paper-doc"),
      CSS.indexOf("}", CSS.indexOf(".greaz-paper-doc")),
    );
    const printRoot = CSS.slice(CSS.indexOf("@media print"));
    expect(paperDoc).toContain("--greaz-brand-ink:");
    expect(printRoot).toContain("--greaz-brand-ink:");
  });
});

// ---------------------------------------------------------------------------
// The muted tiers. Both carry active text, so both owe 4.5:1 everywhere.
// ---------------------------------------------------------------------------
describe("muted text tiers", () => {
  const EVERY_SURFACE = [
    "surface",
    "paper",
    "page",
    "tile",
    "rail",
    "slate-50",
    "slate-100",
  ];

  it.each(THEMES)(
    "keeps fg-muted and fg-subtle readable on every surface on %s",
    (theme) => {
      const p = PALETTE[theme];
      for (const role of ["fg-muted", "fg-subtle"]) {
        for (const bg of EVERY_SURFACE) {
          const r = contrast(p[role], p[bg]);
          expect(
            r,
            `text-${role} on bg-${bg} (${theme}) is ${r.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    },
  );

  // The hierarchy the approved design relies on: three distinct tiers, not a
  // flat one. `fg-subtle` is allowed to be the faintest, but not illegible.
  it.each(THEMES)("keeps the three text tiers ordered and distinct on %s", (theme) => {
    const p = PALETTE[theme];
    const fg = contrast(p.fg, p.surface);
    const muted = contrast(p["fg-muted"], p.surface);
    const subtle = contrast(p["fg-subtle"], p.surface);
    expect(fg).toBeGreaterThan(muted);
    expect(muted).toBeGreaterThan(subtle);
    expect(p["fg-subtle"]).not.toEqual(p["fg-muted"]);
  });

  // `slate-400` was the caption role on the un-migrated pages and is 2.56:1 on
  // Classic white. Every usage moved to `fg-muted`; this stops it coming back.
  it("uses no text-slate-400, the caption role that failed at 2.56:1", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      codeLines(file).forEach(([lineNo, line]) => {
          for (const m of line.matchAll(/\btext-slate-400\b/g)) {
            offenders.push(`${rel}:${lineNo}  ${m[0]}`);
          }
        });
    }
    expect(offenders, `use text-fg-muted:\n${offenders.join("\n")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The categorical badge palettes. These are the only literal hues left in app
// code, and this is where that exemption is EARNED rather than asserted.
//
// A movement type or a ledger-entry type is one of six to eight KINDS that a
// manager tells apart at a glance. That is a categorical palette, not the four
// status levels, and migrating it to the status roles collapsed `return_out`
// and `adjustment` into one colour. It stays literal until it has a
// categorical token family, which is a design decision.
//
// What makes it SAFE to stay literal is that both halves are literal: a
// `bg-X-100` paired with a `text-X-800` on the same element renders
// identically in Classic and Midnight, so it cannot drift the way
// `bg-emerald-50` under themed text did. This test proves exactly that — every
// pair is self-paired on one hue and clears AA — so if someone later edits one
// half alone, or swaps in an unlisted hue, it fails here.
// ---------------------------------------------------------------------------

/** Tailwind v3's own hexes for the rungs these palettes use. */
const TAILWIND_LITERAL: Record<string, number[]> = {
  "emerald-100": [209, 250, 229],
  "emerald-800": [6, 95, 70],
  "indigo-100": [224, 231, 255],
  // The Products/Inventory "service" badge uses the 700 rung, not 800.
  "indigo-700": [67, 56, 202],
  "indigo-800": [55, 48, 163],
  "blue-100": [219, 234, 254],
  "blue-800": [30, 64, 175],
  "teal-100": [204, 251, 241],
  "teal-800": [17, 94, 89],
  "orange-100": [255, 237, 213],
  "orange-800": [154, 52, 18],
  "amber-100": [254, 243, 199],
  "amber-800": [146, 64, 14],
  "slate-200": [226, 232, 240],
  "slate-700": [51, 65, 85],
};

describe("categorical badges stay self-paired", () => {
  const FILES = ["pages/Inventory.tsx", "pages/SupplierDetail.tsx"];

  it("pairs a literal background with a literal text colour of the same hue", () => {
    const problems: string[] = [];
    let pairs = 0;

    for (const file of FILES) {
      codeLines(join(SRC, file)).forEach(([lineNo, line]) => {
        // Only the badge palette lines: a className string carrying a literal
        // `bg-*-NNN` and a literal `text-*-NNN` together.
        const bgs = [...line.matchAll(/\bbg-([a-z]+)-(\d{3})\b/g)];
        const fgs = [...line.matchAll(/\btext-([a-z]+)-(\d{3})\b/g)];
        if (!bgs.length || !fgs.length) return;
        if (bgs.length !== 1 || fgs.length !== 1) {
          problems.push(`${file}:${lineNo}  expected one bg and one text literal`);
          return;
        }
        const bgKey = `${bgs[0][1]}-${bgs[0][2]}`;
        const fgKey = `${fgs[0][1]}-${fgs[0][2]}`;

        // Same hue family on both halves: that is what makes the pair immune
        // to the appearance switch.
        if (bgs[0][1] !== fgs[0][1]) {
          problems.push(`${file}:${lineNo}  ${fgKey} is not the text rung of ${bgKey}`);
          return;
        }
        const bg = TAILWIND_LITERAL[bgKey];
        const fg = TAILWIND_LITERAL[fgKey];
        if (!bg || !fg) {
          problems.push(
            `${file}:${lineNo}  ${bgKey}/${fgKey} is not in the known literal table` +
              ` — add its hex before using it`,
          );
          return;
        }
        const r = contrast(fg, bg);
        if (r < AA_TEXT) {
          problems.push(
            `${file}:${lineNo}  text-${fgKey} on bg-${bgKey} is ${r.toFixed(2)}:1`,
          );
        }
        pairs++;
      });
    }

    // If the maps are ever refactored out of a one-line-per-entry shape this
    // count drops and the test says so, rather than silently proving nothing.
    expect(pairs, "expected to find the categorical badge pairs").toBeGreaterThanOrEqual(
      12,
    );
    expect(problems, `categorical badges:\n${problems.join("\n")}`).toEqual([]);
  });
});
