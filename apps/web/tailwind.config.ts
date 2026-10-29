import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#12201b",
        paper: "#f4f1ea",
        surface: "#fffcf7",
        muted: "#5c6b65",
        moss: "#0c7a5c",
        clay: "#c05621",
        rust: "#c31b1b",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        lift: "0 1px 2px rgba(18,32,27,0.04), 0 12px 32px rgba(18,32,27,0.05)",
      },
    },
  },
  plugins: [],
} satisfies Config;
