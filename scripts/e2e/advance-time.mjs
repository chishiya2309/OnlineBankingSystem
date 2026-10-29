import { readFile } from "node:fs/promises";
import path from "node:path";
import { Contract, JsonRpcProvider } from "ethers";

const args = process.argv.slice(2);
if (args.length !== 2 || !["--deposit", "--grace"].includes(args[0]) || !/^[1-9]\d*$/.test(args[1])) {
  console.error("Usage: npm run demo:time -- --deposit <id> OR --grace <id>");
  process.exit(1);
}
const active = JSON.parse(await readFile(".e2e/runtime/active.json", "utf8"));
if (active.rpc !== "http://127.0.0.1:18545") throw new Error("Only the isolated local demo node is allowed");
const provider = new JsonRpcProvider(active.rpc, undefined, { cacheTimeout: -1 });
try {
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Expected Hardhat chain ID 31337");
  const artifact = JSON.parse(await readFile(path.join(active.root, "exports/contracts/SavingCore.json"), "utf8"));
  const core = new Contract(artifact.address, artifact.abi, provider);
  const id = BigInt(args[1]);
  const deposit = await core.getDeposit(id);
  if (deposit.status !== 0n) throw new Error("Deposit must be Active");
  const target = deposit.maturityAt + (args[0] === "--grace" ? await core.gracePeriodSeconds() : 0n);
  const latest = await provider.getBlock("latest");
  if (target > BigInt(latest.timestamp)) {
    await provider.send("evm_setNextBlockTimestamp", [Number(target)]);
    await provider.send("evm_mine", []);
  }
  console.log(`Certificate #${id}: chain time ${(await provider.getBlock("latest")).timestamp}; target ${target}. Click Refresh Portfolio in the UI.`);
} finally {
  provider.destroy();
}
