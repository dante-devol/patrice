/**
 * Tailwind theme for the Tasks slice (ui-tailwind). The tokens mirror the approved
 * design spike (`web/design/`): a cool "drafting board" palette with the IBM Plex trio.
 *
 * Scope note: Tailwind's utilities are global, but only the Tasks pages use the light
 * board theme — the rest of the app (admin/auth) still rides the dark token set in
 * `styles.css`. Preflight is disabled so adding Tailwind doesn't reset the existing
 * hand-written component styles those pages depend on.
 *
 * Division/team hues are DB-configurable (a `color` column is a pending backend gap);
 * the values here are the current client-side defaults, also mirrored as CSS vars in
 * `styles.css` for the per-row `--c` / `--tc` spine + tag colors.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  corePlugins: {
    // The app's other pages still use the legacy dark stylesheet; Preflight would
    // reset their elements. Keep Tailwind additive — utilities only, no global reset.
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        serif: ['"IBM Plex Serif"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        board: '#E7E8E1',
        paper: '#FBFBF8',
        ink: '#191B19',
        'ink-soft': '#5B605C',
        line: '#D3D5CC',
        accent: '#0F7A6B',
        'accent-ink': '#0A5249',
        div: {
          writing: '#3C5BA0',
          art: '#B0573C',
          scripting: '#2E7D5B',
          testing: '#7E54A3',
          leadership: '#A9810F',
        },
      },
      boxShadow: {
        card: '0 1px 0 rgba(25,27,25,0.04), 0 1px 2px rgba(25,27,25,0.05)',
      },
    },
  },
  plugins: [],
};
