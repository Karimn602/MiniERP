/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic palette — we'll reference these everywhere
        // rather than raw color values, so a future theme swap is one place.
        brand: {
          DEFAULT: "#0f766e", // teal-700
          fg: "#ffffff",
        },
      },
    },
  },
  plugins: [],
};
