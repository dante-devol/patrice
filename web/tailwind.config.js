/**
 * Tailwind theme for the "graphite sheet" visual language — see `web/DESIGN.md`, which is
 * the source of truth for every token here. Cool grey board, white ruled sheets, graphite
 * ink; Bricolage Grotesque (`font-display`) for names of things, Atkinson Hyperlegible
 * (`font-sans`) for everything else. There is deliberately no monospace or serif family.
 *
 * Preflight is disabled: the semantic element styles in `styles.css` (`.panel`, `button`,
 * `table`, `label`…) theme the non-Tailwind pages, and Tailwind stays additive.
 *
 * Division/team hues are DB-configurable eventually (a `color` column is a pending backend
 * gap); the `div.*` values are the current client-side defaults, mirrored in
 * `task-presentation.ts` and as CSS vars in `styles.css`.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  // Stamp modifiers are built at runtime (`stamp--${status}`, `stamp--lc-${state}`), so the
  // content scan can't see them; keep every one of them.
  safelist: [{ pattern: /^stamp--/ }],
  corePlugins: {
    // Keep Tailwind additive — utilities only, no global reset (see note above).
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Atkinson Hyperlegible"', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', '"Atkinson Hyperlegible"', 'system-ui', 'sans-serif'],
      },
      colors: {
        board: '#E2E4E7',
        paper: '#FFFFFF',
        'paper-alt': '#F5F6F8',
        'paper-hover': '#EEF0F3',
        ink: '#2A2D32',
        'ink-soft': '#62666E',
        line: '#D5D8DD',
        margin: '#9AA6B6',
        faint: '#A3A7AE',
        rust: '#8E3B26',
        // The primary action is graphite; `accent` names the role, not a hue.
        accent: '#2A2D32',
        'accent-ink': '#43474F',
        div: {
          writing: '#3F5FB5',
          art: '#C0563A',
          scripting: '#2D8060',
          testing: '#7B57A8',
          leadership: '#A57F12',
        },
      },
      borderRadius: {
        DEFAULT: '2px',
      },
    },
  },
  plugins: [],
};
