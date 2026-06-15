import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "public",
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
