import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".e2e/runtime");
const env = { ...process.env, SKIP_LOAD_ENV: "true", BANKING_ARTIFACT_ROOT: output,
  LOCAL_RPC_URL: "http://127.0.0.1:18545", VITE_LOCAL_RPC_URL: "http://127.0.0.1:18545" };
const children = new Set();
let stopping = false;

function launch(cli, args, log = false) {
  const child = spawn(process.execPath, [path.join(root, cli), ...args], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", data => { if (log) process.stdout.write(data); });
  child.stderr.on("data", data => process.stderr.write(data));
  child.on("exit", code => {
    children.delete(child);
    if (!stopping && code !== 0) { console.error(`Child exited: ${cli} (${code})`); stop(1); }
  });
  child.on("error", error => { console.error(error); stop(1); });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 200);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

async function portFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is occupied; existing services will not be reused.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function run(args) {
  const child = launch("node_modules/hardhat/dist/src/cli.js", args, true);
  await new Promise((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Hardhat failed (${code})`))));
}

try {
  await portFree(18545);
  await portFree(5174);
  // Fresh process + empty manifest per run; no deletion of user deployments.
  await mkdir(output, { recursive: true });
  const runRoot = path.join(output, `${Date.now()}-${process.pid}`);
  env.BANKING_ARTIFACT_ROOT = runRoot;
  const node = launch("node_modules/hardhat/dist/src/cli.js", ["node", "--network", "hardhatMainnet", "--hostname", "127.0.0.1", "--port", "18545"]);
  const provider = new JsonRpcProvider(env.LOCAL_RPC_URL, undefined, { cacheTimeout: -1 });
  let accounts;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && node.exitCode === null) {
    try { accounts = await provider.send("eth_accounts", []); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!accounts || Number((await provider.getNetwork()).chainId) !== 31337) throw new Error("Local E2E chain unavailable or wrong chain ID");
  env.BANK_ADMIN_ADDRESS = accounts[1];
  env.DEMO_USER_ADDRESS = accounts[2];
  env.FEE_RECEIVER_ADDRESS = accounts[4];
  await run(["run", "scripts/deploy.ts", "--network", "localhost"]);
  await run(["run", "scripts/seed.ts", "--network", "localhost"]);
  await run(["run", "scripts/verify-deployment.ts", "--network", "localhost"]);
  const snapshot = await provider.send("evm_snapshot", []);
  await writeFile(path.join(output, "active.json"), JSON.stringify({ root: runRoot, accounts, rpc: env.LOCAL_RPC_URL, snapshot }));
  provider.destroy();
  launch("frontend/node_modules/vite/bin/vite.js", ["frontend", "--config", "frontend/vite.config.ts", "--mode", "e2e", "--host", "127.0.0.1", "--port", "5174", "--strictPort"], true);
} catch (error) {
  console.error(error);
  stop(1);
}
