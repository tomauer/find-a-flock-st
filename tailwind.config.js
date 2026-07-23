/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Seasonal accent palette used for scrubber season bands + legends.
        season: {
          winter: '#6ba3d6',
          spring: '#6fce8f',
          breeding: '#e6b84c',
          fall: '#d98a4b',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Inter', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
