import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        kvNamespaces: ["RATE_LIMIT_KV"],
        d1Databases: ["DB"],
        bindings: {
          DISCORD_WEBHOOK: "https://discord.example/webhook",
        },
      },
    }),
  ],
});
