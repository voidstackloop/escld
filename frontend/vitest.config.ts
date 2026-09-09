import path from "path"
import { defineConfig } from "vitest/config"

// Separate from vite.config.ts: this project's Vite (rolldown-based, v8) and
// vitest's own bundled Vite dependency have incompatible Plugin types at the
// TypeScript level (a duplicate-package version mismatch, not a runtime
// issue) — merging vite.config.ts's plugins array directly into a
// `test: {...}` block there fails to type-check, and even @vitejs/plugin-react
// hits the same mismatch here. Not needed anyway: esbuild's default TSX
// transform (Vite's fallback without the plugin) is sufficient to run
// tests — only the "@" path alias below is actually required.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
})
