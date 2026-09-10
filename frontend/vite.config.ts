import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  // Overridable so a poisoned cache dir can't block the dev server: a root-
  // owned node_modules/.vite (left behind when a container wrote into the
  // bind-mounted frontend/) makes Vite's re-optimize step fail with EACCES on
  // unlink, and it can't be cleared without root. Set VITE_CACHE_DIR to route
  // around it.
  cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
