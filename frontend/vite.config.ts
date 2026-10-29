/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      ...(process.env.BANKING_ARTIFACT_ROOT ? Object.fromEntries(
        ["MockUSDC", "SavingCore", "VaultManager", "networks"].map((name) => [
          `../contracts/${name}.json`,
          path.resolve(__dirname, "..", process.env.BANKING_ARTIFACT_ROOT!, "frontend/src/contracts", `${name}.json`),
        ])
      ) : {}),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
});
