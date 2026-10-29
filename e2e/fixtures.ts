import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import { Contract, JsonRpcProvider, getAddress, type TransactionReceipt } from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export { expect };
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
export const P = 1_000_000000n;
export const I = P * 200n * (180n * 86400n) / (10000n * 365n * 86400n);

export interface Chain {
  provider: JsonRpcProvider;
  accounts: string[];
  core: Contract;
  vault: Contract;
  token: Contract;
  addresses: Record<string, string>;
  reset(): Promise<void>;
  advance(id: bigint, grace?: boolean): Promise<void>;
}
interface Wallet {
  account: string;
  receipts: TransactionReceipt[];
  select(index: number): Promise<void>;
  evidence: Record<string, unknown>;
}
type Fixtures = { wallet: Wallet };
type Workers = { chain: Chain };

export const test = base.extend<Fixtures, Workers>({
  chain: [async ({}, use) => {
    const active = await json(".e2e/runtime/active.json");
    active.accounts = active.accounts.map((account: string) => getAddress(account));
    const manifest = await json(path.join(active.root, "deployments/localhost.json"));
    const provider = new JsonRpcProvider(active.rpc, undefined, { cacheTimeout: -1 });
    const addresses: Record<string, string> = {};
    const contracts: Record<string, Contract> = {};
    for (const name of ["MockUSDC", "SavingCore", "VaultManager"]) {
      const artifact = await json(path.join(active.root, `exports/contracts/${name}.json`));
      addresses[name] = manifest.contracts[name].address;
      contracts[name] = new Contract(addresses[name], artifact.abi, provider);
    }
    let snapshot: string = active.snapshot;
    const chain: Chain = {
      provider, addresses, accounts: active.accounts,
      core: contracts.SavingCore, vault: contracts.VaultManager, token: contracts.MockUSDC,
      async reset() {
        if (snapshot) expect(await provider.send("evm_revert", [snapshot])).toBe(true);
        snapshot = await provider.send("evm_snapshot", []);
        // Persist the fresh baseline token across Playwright worker restarts.
        await writeFile(".e2e/runtime/active.json", JSON.stringify({ ...active, snapshot }));
      },
      async advance(id, grace = false) {
        await promisify(execFile)(process.execPath, ["scripts/e2e/advance-time.mjs", grace ? "--grace" : "--deposit", id.toString()], { windowsHide: true });
      },
    };
    await use(chain);
    provider.destroy();
  }, { scope: "worker" }],
  wallet: async ({ context, page, chain }, use, info) => {
    await chain.reset();
    const wallet: Wallet = {
      account: chain.accounts[2], receipts: [], evidence: {},
      async select(index) {
        wallet.account = chain.accounts[index];
        await page.evaluate((account) => {
          (window as unknown as { __walletEmit: (event: string, args: string[]) => void }).__walletEmit("accountsChanged", [account]);
        }, wallet.account);
        await expect(page.locator(".header-actions [title]").filter({ hasText: /^0x/ })).toHaveAttribute("title", wallet.account);
      },
    };
    await installWallet(context, chain, wallet);
    await use(wallet);
    const transactions = [];
    for (const receipt of wallet.receipts) {
      const tx = await chain.provider.getTransaction(receipt.hash);
      const block = await chain.provider.getBlock(receipt.blockNumber);
      transactions.push({ ...receipt.toJSON(), from: tx?.from, to: tx?.to, data: tx?.data, timestamp: block?.timestamp });
    }
    const evidence = { scenario: info.title, status: info.status, chainId: 31337,
      contracts: chain.addresses, accounts: chain.accounts.slice(0, 5), transactions, assertions: wallet.evidence };
    const file = info.outputPath("on-chain.json");
    await writeFile(file, JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    await info.attach("On-chain receipts and assertions", { path: file, contentType: "application/json" });
    if (!page.isClosed()) {
      await page.screenshot({ path: info.outputPath("ui.png"), fullPage: true });
      await info.attach("UI result", { path: info.outputPath("ui.png"), contentType: "image/png" });
    }
  },
});

async function installWallet(context: BrowserContext, chain: Chain, wallet: Wallet) {
  let connected = false;
  await context.exposeBinding("__walletRequest", async (_source, request: { method: string; params?: unknown[] }) => {
    try {
      const { method, params = [] } = request;
      if (method === "eth_requestAccounts") { connected = true; return { result: [wallet.account] }; }
      if (method === "eth_accounts") return { result: connected ? [wallet.account] : [] };
      if (method.startsWith("wallet_")) throw Object.assign(new Error("E2E wallet is restricted to Hardhat 31337"), { code: 4902 });
      if (method === "eth_sendTransaction") {
        const tx = params[0] as { from?: string };
        if (!connected || tx.from?.toLowerCase() !== wallet.account.toLowerCase()) throw new Error("Unauthorized E2E sender");
      }
      const result = await chain.provider.send(method, params);
      if (method === "eth_sendTransaction") {
        const receipt = await chain.provider.getTransactionReceipt(result) ?? await chain.provider.waitForTransaction(result);
        if (!receipt || receipt.status !== 1) throw new Error(`Transaction failed: ${result}`);
        wallet.receipts.push(receipt);
      }
      return { result };
    } catch (error) {
      const err = error as { message: string; code?: number; info?: { error?: unknown }; data?: unknown };
      return { error: err.info?.error ?? { message: err.message, code: err.code ?? -32603, data: err.data } };
    }
  });
  await context.addInitScript(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const scope = window as unknown as {
      __walletRequest: (request: unknown) => Promise<{ result?: unknown; error?: object }>;
      __walletEmit: (event: string, args: unknown[]) => void;
      ethereum: object;
    };
    scope.__walletEmit = (event, args) => listeners.get(event)?.forEach(fn => fn(args));
    scope.ethereum = {
      async request(request: unknown) {
        const reply = await scope.__walletRequest(request);
        if (reply.error) throw Object.assign(new Error("Wallet request failed"), reply.error);
        return reply.result;
      },
      on(event: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener(event: string, fn: (...args: unknown[]) => void) { listeners.get(event)?.delete(fn); },
    };
  });
}

export async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect MetaMask", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect(page.locator(".form-card")).toContainText("Selected: Plan #1");
}
export async function openDeposit(page: Page, chain: Chain, wallet: Wallet, amount = "1000") {
  await page.getByRole("tab", { name: "Saving Plans & Open", exact: true }).click();
  await page.locator(".form-card input").fill(amount);
  const approve = page.getByRole("button", { name: /^Step 1\/2: Approve/ });
  const open = page.getByRole("button", { name: /^Step 2\/2: Open Deposit/ });
  await expect(approve.or(open)).toBeEnabled();
  if (await approve.isVisible()) {
    await approve.click();
    await expect(open).toBeEnabled();
  }
  const before = wallet.receipts.length;
  await open.click();
  await expect.poll(() => wallet.receipts.length).toBeGreaterThan(before);
  const receipt = wallet.receipts.at(-1)!;
  const event = receipt.logs.map(log => { try { return chain.core.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === "DepositOpened");
  expect(event, "DepositOpened must originate from the UI transaction").toBeTruthy();
  const id = event!.args.depositId as bigint;
  await expect(page.getByText(/Deposit Confirmed|Deposit Opened|Deposit Successfully/i).first()).toBeVisible();
  expect(await chain.core.ownerOf(id)).toBe(wallet.account);
  return id;
}
export async function portfolio(page: Page) {
  await page.getByRole("tab", { name: /^My Portfolio/ }).click();
  await page.getByRole("button", { name: /Refresh/ }).click();
}
export function certificate(page: Page, id: bigint) {
  return page.locator("article.deposit-card").filter({ has: page.getByText(`Certificate #${id}`, { exact: true }) });
}
export async function admin(page: Page) {
  await page.getByRole("tab", { name: /^Admin Portal/ }).click();
  await expect(page.getByText("Bank Administrator Authenticated", { exact: true })).toBeVisible();
}
export async function adminAction(page: Page, button: string, result: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.locator(".alert-banner.success")).toContainText(result);
}
export function eventArgs(chain: Chain, wallet: Wallet, name: string, target: "core" | "vault" = "core") {
  const parsed = wallet.receipts.at(-1)!.logs
    .map(log => { try { return chain[target].interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === name);
  expect(parsed, `${name} event`).toBeTruthy();
  return parsed!.args;
}
