import { defineConfig } from "vite";

// Client bundle for the SPA. The entry stays the vanilla src/app/main.js while we incrementally
// port screens to Remix 3 (remix/ui) components under src/client/*.tsx. esbuild compiles their JSX
// with the remix/ui automatic runtime; main.js itself has no JSX so it's unaffected.
export default defineConfig({
  publicDir: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "remix/ui",
  },
  build: {
    outDir: "public",
    target: "es2022",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/app/main.js",
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
