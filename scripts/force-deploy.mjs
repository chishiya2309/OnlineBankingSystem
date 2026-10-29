import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const network = process.argv[2];
if (!["localhost", "sepolia"].includes(network)) {
  throw new Error("Usage: node scripts/force-deploy.mjs <localhost|sepolia>");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [path.join(root, "node_modules/hardhat/dist/src/cli.js"), "run", "scripts/deploy.ts", "--network", network], {
  cwd: root, env: { ...process.env, FORCE_REDEPLOY: "true" }, stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
