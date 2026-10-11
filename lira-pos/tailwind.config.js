/** @type {import('tailwindcss').Config} */

// Every themed colour is `rgb(var(--token) / <alpha-value>)` so that Tailwind's
// opacity modifiers (`bg-surface/80`, `border-line/60`) keep working. The
// variables themselves live in `src/index.css`, under `:root` (Classic) and
// `[data-theme="midnight"]`.
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./preview.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ===================================================================
        // GREAZ design tokens — TWO APPEARANCES, ONE SET OF COMPONENTS.
        //
        // Approved concepts: Classic (C, light, default) and Midnight (B,
        // dark). See design-references/greaz-theme-references/.
        //
        // The rule: a component names a ROLE (`bg-surface`, `text-fg-muted`,
        // `border-line`) and never a literal colour. Switching appearance
        // rewrites the variables on <html>; not one className changes, so a
        // theme switch re-paints without re-rendering React at all.
        // ===================================================================

        // --- Brand -------------------------------------------------------
        // Greaz red. Shifts between appearances: #D11B32 on Classic's warm
        // white, #E51B3C on Midnight's near-black, because the darker red goes
        // muddy against #171617. `fg` is what sits ON brand and stays white in
        // both: white on #D11B32 is 5.4:1, on #E51B3C 4.7:1 — both AA for the
        // large, heavy type that actually uses them (tile prices, the amount
        // due, the Post Sale label).
        brand: {
          DEFAULT: token("--greaz-brand"),
          fg: token("--greaz-brand-fg"),
          hover: token("--greaz-brand-hover"),
          // Brand red as TEXT. `DEFAULT` is a FILL and is only 3.52:1 as
          // letterforms on the Midnight tile; this rung is the same red on
          // Classic and a lighter one on Midnight. Use it for any brand-
          // coloured glyph or figure; keep `bg-brand` for the fill.
          ink: token("--greaz-brand-ink"),
          soft: token("--greaz-brand-soft"),
          line: token("--greaz-brand-line"),
          // Kept so existing back-office usages (`bg-brand-50`, `text-brand-700`)
          // still resolve. Phase 2 migrates them onto the roles above.
          50: token("--greaz-brand-50"),
          100: token("--greaz-brand-100"),
          200: token("--greaz-brand-200"),
          300: token("--greaz-brand-300"),
          400: token("--greaz-brand-400"),
          600: token("--greaz-brand"),
          700: token("--greaz-brand-700"),
          800: token("--greaz-brand-800"),
          900: token("--greaz-brand-900"),
        },

        // --- Surfaces ----------------------------------------------------
        page: token("--greaz-page"), // app background behind everything
        surface: token("--greaz-surface"), // cards, panels, the toolbar
        paper: token("--greaz-paper"), // inset fills: inputs, soft boxes
        tile: token("--greaz-tile"), // menu tiles (≠ paper on Midnight)
        line: token("--greaz-line"), // every ordinary border

        // --- Text --------------------------------------------------------
        fg: {
          DEFAULT: token("--greaz-fg"),
          muted: token("--greaz-fg-muted"),
          subtle: token("--greaz-fg-subtle"),
        },

        // --- Sidebar rail --------------------------------------------------
        // Its own role set because the rail INVERTS between appearances: pale
        // (#FDF9F7, dark text) on Classic, near-black (#0D0C0D, warm white) on
        // Midnight. A rail hard-coded to ink could only ever be half right.
        rail: {
          DEFAULT: token("--greaz-rail"),
          fg: token("--greaz-rail-fg"),
          muted: token("--greaz-rail-muted"),
          line: token("--greaz-rail-line"),
          hover: token("--greaz-rail-hover"),
        },

        // --- Restaurant hero band ------------------------------------------
        // Paper with a border on Classic; solid #BD1029 on Midnight.
        banner: {
          DEFAULT: token("--greaz-banner"),
          fg: token("--greaz-banner-fg"),
          kicker: token("--greaz-banner-kicker"),
          sub: token("--greaz-banner-sub"),
        },
        // The status chip riding in the band ("shift open", locked rate).
        chip: {
          DEFAULT: token("--greaz-chip"),
          fg: token("--greaz-chip-fg"),
          line: token("--greaz-chip-line"),
        },

        // --- Semantic status ------------------------------------------------
        // Brand red is NOT a substitute for these. `danger` stays visibly
        // distinct from `brand` in both appearances, or "delete" starts
        // reading as "the main action".
        warn: {
          DEFAULT: token("--greaz-warn"),
          bg: token("--greaz-warn-bg"),
          line: token("--greaz-warn-line"),
          fg: token("--greaz-warn-fg"),
        },
        danger: {
          DEFAULT: token("--greaz-danger"),
          bg: token("--greaz-danger-bg"),
          line: token("--greaz-danger-line"),
          fg: token("--greaz-danger-fg"),
          solid: token("--greaz-danger-solid"),
          "solid-fg": token("--greaz-danger-solid-fg"),
        },
        good: {
          DEFAULT: token("--greaz-good"),
          bg: token("--greaz-good-bg"),
          line: token("--greaz-good-line"),
          fg: token("--greaz-good-fg"),
          // The positive counterpart of `danger-solid`: a FILL dark enough to
          // carry text. `good` itself is an accent (dots, icons) and is only
          // 3.8:1 under white, so a filled "+" toggle cannot use it.
          solid: token("--greaz-good-solid"),
          "solid-fg": token("--greaz-good-solid-fg"),
        },
        // Informational. The fourth status role, added so `Badge tone="info"`
        // stops being the one tone pinned to a literal Tailwind hue.
        info: {
          DEFAULT: token("--greaz-info"),
          bg: token("--greaz-info-bg"),
          line: token("--greaz-info-line"),
          fg: token("--greaz-info-fg"),
        },

        // Modal scrim. Deliberately NOT slate-900: a scrim must stay dark on a
        // dark appearance, and anything derived from a text ramp inverts.
        scrim: token("--greaz-scrim"),

        // --- Compatibility ramp: `slate-*` ------------------------------------
        // PHASE 1 SCAFFOLDING — read this before touching it.
        //
        // 783 `slate-*` usages remain across the back office, which Phase 2
        // migrates onto the roles above. Until then the ramp is variable-driven
        // so Midnight does not render those pages as black-on-black.
        //
        // The Classic values below are Tailwind v3's own slate hexes, VERBATIM.
        // That is the point: Phase 1 changes zero back-office pixels on the
        // default appearance, so this indirection cannot regress anything that
        // has not been looked at yet. The Midnight column is a warm inversion —
        // a readability net, not the Phase 2 design.
        slate: {
          50: token("--slate-50"),
          100: token("--slate-100"),
          200: token("--slate-200"),
          300: token("--slate-300"),
          400: token("--slate-400"),
          500: token("--slate-500"),
          600: token("--slate-600"),
          700: token("--slate-700"),
          800: token("--slate-800"),
          900: token("--slate-900"),
          950: token("--slate-950"),
        },

        // Warm near-black. Still literal: `ink` means "dark regardless of
        // appearance" and is what the receipt preview and the hazard strip's
        // text rely on.
        ink: {
          DEFAULT: "#1a1616",
          50: "#f7f6f6",
          100: "#e8e5e5",
          200: "#cfc9c9",
          300: "#a89f9f",
          400: "#7a6f6f",
          500: "#574e4e",
          600: "#403939",
          700: "#302b2b",
          800: "#221e1e",
          900: "#1a1616",
          950: "#110e0e",
        },
      },

      boxShadow: {
        // Panel elevation is a token: Classic lifts cards off warm white with a
        // soft warm shadow, Midnight uses a tighter, blacker one because a
        // diffuse shadow is invisible on #171617.
        panel: "var(--greaz-shadow-panel)",
        tile: "var(--greaz-shadow-tile)",
        "tile-hover": "var(--greaz-shadow-tile-hover)",
        card: "var(--greaz-shadow-panel)",
        "card-hover": "var(--greaz-shadow-tile-hover)",
        soft: "var(--greaz-shadow-soft)",
      },

      borderRadius: {
        // Geometry differs between the approved concepts — and NOT in the
        // direction most people assume. Classic is the squarer, crisper theme
        // (5px tiles, 8px panels); Midnight is the rounder one (13px / 14px).
        tile: "var(--greaz-radius-tile)",
        panel: "var(--greaz-radius-panel)",
        chip: "var(--greaz-radius-chip)",
        lg: "0.625rem",
        xl: "1rem",
        "2xl": "1.375rem",
        "3xl": "1.75rem",
      },

      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        // The Greaz poster face. Resolved through a variable because Impact has
        // NO ARABIC GLYPHS — `html[lang="ar"]` swaps the stack in index.css
        // rather than rendering tofu or silently falling back mid-word.
        display: "var(--greaz-font-display)",
      },

      screens: {
        // The approved concepts carry their own compact mode, and 1366x768 —
        // the target till resolution — is inside it. Every measurement the two
        // screenshots show is the SQUAT one, so this is part of the approved
        // design rather than a fallback: shorter hero, tighter cards, 31px
        // inputs, so the Post Sale button stays above the fold without
        // scrolling.
        squat: { raw: "(max-height: 800px) and (min-width: 1000px)" },
        // Shorter still: 1366x768 at Windows 125% scaling is a ~1093x614 CSS
        // viewport, and the till loses roughly 150px of height to it. `tiny`
        // trims the rail hard — one cart row before it scrolls, no secondary
        // currency line in the total block, tighter everything — so the cash
        // panel and Post Sale stay on screen instead of needing a scroll.
        tiny: { raw: "(max-height: 680px) and (min-width: 1000px)" },
      },

      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "scale-in": "scale-in 0.15s ease-out",
      },
    },
  },
  plugins: [],
};
