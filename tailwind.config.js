/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Warm paper neutrals (inverted): surfaces are cream/white, text is ink.
        // Tones only — the COLOR comes from the teal sidebar, coral accent,
        // and per-stage jewel hues.
        zinc: {
          50: '#20180f',
          100: '#2b2115',
          200: '#3a2d1e',
          300: '#4f3e2a',
          400: '#6b573f',
          500: '#857052',
          600: '#a08b6d',
          700: '#ddd0ba',
          800: '#f0e7d5',
          900: '#fffdf7',
          950: '#faf5ec',
        },
        // Coral accent scale (complementary to the teal sidebar).
        accent: {
          50: '#fff4f1',
          100: '#ffe6de',
          200: '#ffcabd',
          300: '#ffa48d',
          400: '#fb7a55',
          500: '#f0563a',
          600: '#dd3f20',
          700: '#b93518',
          800: '#972f1a',
          900: '#7d2d1e',
        },
      },
    },
  },
  plugins: [],
};
