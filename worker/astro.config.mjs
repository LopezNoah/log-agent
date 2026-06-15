import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// SPA-like Astro app on Cloudflare. `output: 'server'` keeps every route flowing through our
// custom worker entry (src/worker.ts) so the Hono auth/proxy/API pipeline runs before any page
// renders. `imageService: 'compile'` skips the runtime Cloudflare Images binding (we ship no
// <Image> usage). The deployed worker entry, DO export, cron, and bindings live in src/worker.ts
// + wrangler.toml; the adapter bundles them into dist/server/ at build time.
export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "compile" }),
});
