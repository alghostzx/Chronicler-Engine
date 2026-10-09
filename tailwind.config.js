/** @type {import('tailwindcss').Config} */
export default {
  content: ['./public/index.html', './client/**/*.ts'],
  theme: {
    extend: {
      colors: {
        main: 'var(--bg-main)',
        panel: 'var(--bg-panel)',
        ink: 'var(--text-main)',
        muted: 'var(--text-muted)',
        strong: 'var(--text-strong)',
        accent: 'var(--accent)',
        line: 'var(--border)',
        'hp-ok': 'var(--hp-ok)',
        'hp-warn': 'var(--hp-warn)',
        'hp-low': 'var(--hp-low)',
      },
      fontFamily: {
        reading: 'var(--font-reading)',
        display: 'var(--font-display)',
      },
    },
  },
  plugins: [],
};
