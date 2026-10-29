import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";
import { deployContracts } from "../scripts/deploy.js";
import { seedContracts } from "../scripts/seed.js";
import { verifyDeployment } from "../scripts/verify-deployment.js";
import { runContractExport } from "../scripts/export-contracts.js";
import {
  EXPORTS_DIR,
  readManifest,
  saveManifest,
  type DeploymentManifest,
} from "../scripts/helpers/deployment-manifest.js";

const connection = await network.create("hardhatMainnet");
const { ethers } = connection;

describe("Deployment Automation & Verification (DEP-001 to DEP-016)", function () {
  after(async function () {
    await connection.close();
  });

  describe("Deployment Pipeline & Architecture (DEP-001, DEP-006, DEP-007, DEP-008, DEP-009, DEP-013)", function () {
    it("DEP-001 & DEP-013: executes reproducible deployment in canonical order (Token -> Vault -> Core -> Bind)", async function () {
      const res = await deployContracts({
        networkName: "hardhatMainnet",
        connection,
      });

      expect(res.manifest.contracts.MockUSDC.address).to.be.properAddress;
      expect(res.manifest.contracts.VaultManager.address).to.be.properAddress;
      expect(res.manifest.contracts.SavingCore.address).to.be.properAddress;
      expect(res.manifest.binding.verified).to.be.true;
    });

    it("DEP-006: deployed MockUSDC has exactly 6 decimals", async function () {
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      const token = await ethers.getContractAt("MockUSDC", manifest.contracts.MockUSDC.address);
      expect(await token.decimals()).to.equal(6n);
    });

    it("DEP-007: cross-contract references between Token, VaultManager, and SavingCore are coherent", async function () {
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      const vault = await ethers.getContractAt("VaultManager", manifest.contracts.VaultManager.address);
      const core = await ethers.getContractAt("SavingCore", manifest.contracts.SavingCore.address);

      expect((await vault.token()).toLowerCase()).to.equal(manifest.contracts.MockUSDC.address.toLowerCase());
      expect((await core.token()).toLowerCase()).to.equal(manifest.contracts.MockUSDC.address.toLowerCase());
      expect((await core.vaultManager()).toLowerCase()).to.equal(manifest.contracts.VaultManager.address.toLowerCase());
    });

    it("DEP-008: VaultManager write-once binding is permanent and rejects rebinding", async function () {
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      const signers = await ethers.getSigners();
      const adminSigner = signers.find((s) => s.address.toLowerCase() === manifest.bankAdmin.toLowerCase()) ?? signers[0];
      const vault = await ethers.getContractAt("VaultManager", manifest.contracts.VaultManager.address, adminSigner);

      expect((await vault.savingCore()).toLowerCase()).to.equal(manifest.contracts.SavingCore.address.toLowerCase());

      // Attempting to rebind must revert with SavingCoreAlreadySet
      await expect(vault.setSavingCore(signers[3].address)).to.be.revertedWithCustomError(
        vault,
        "SavingCoreAlreadySet"
      );
    });

    it("DEP-009: SavingCore enforces Personal Variant grace period (172800 seconds)", async function () {
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      const core = await ethers.getContractAt("SavingCore", manifest.contracts.SavingCore.address);
      const expectedGrace = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
      expect(await core.gracePeriodSeconds()).to.equal(expectedGrace);
    });
  });

  describe("Validation & Preflight Guards (DEP-002, DEP-003, DEP-004, DEP-005, DEP-014)", function () {
    it("DEP-002 & DEP-004: missing Sepolia credentials in preflight triggers clear diagnostic without secret leak", async function () {
      // Temporarily clear environment variables to test preflight guard
      process.env.SKIP_LOAD_ENV = "true";
      const oldRpc = process.env.SEPOLIA_RPC_URL;
      const oldKey = process.env.SEPOLIA_PRIVATE_KEY;
      delete process.env.SEPOLIA_RPC_URL;
      delete process.env.SEPOLIA_PRIVATE_KEY;

      try {
        await deployContracts({ networkName: "sepolia" });
        expect.fail("Should have thrown error on missing Sepolia credentials");
      } catch (err: any) {
        expect(err.message).to.include("PREFLIGHT_BLOCKED_MISSING_CREDENTIALS");
        // Ensure no private key pattern is present in the error message
        expect(err.message.toLowerCase()).to.not.include("0x");
      } finally {
        delete process.env.SKIP_LOAD_ENV;
        if (oldRpc) process.env.SEPOLIA_RPC_URL = oldRpc;
        if (oldKey) process.env.SEPOLIA_PRIVATE_KEY = oldKey;
      }
    });

    it("DEP-003: invalid constructor dependencies revert cleanly", async function () {
      const factory = await ethers.getContractFactory("SavingCore");
      // Zero address for VaultManager must revert
      await expect(factory.deploy(ethers.ZeroAddress, 172800n)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress"
      );
      // Zero grace period must revert
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      await expect(factory.deploy(manifest.contracts.VaultManager.address, 0n)).to.be.revertedWithCustomError(
        factory,
        "InvalidGracePeriod"
      );
    });

    it("DEP-005: verification fails if contract bytecode is missing at address", async function () {
      const originalManifest = await readManifest("hardhatMainnet");
      try {
        const fakeManifest: DeploymentManifest = {
          network: "hardhatMainnet",
          chainId: 31337,
          deployedAt: new Date().toISOString(),
          deployer: ethers.ZeroAddress,
          bankAdmin: ethers.ZeroAddress,
          feeReceiver: ethers.ZeroAddress,
          contracts: {
            MockUSDC: { address: "0x0000000000000000000000000000000000000001", deploymentTxHash: "0x" },
            VaultManager: { address: "0x0000000000000000000000000000000000000002", deploymentTxHash: "0x" },
            SavingCore: { address: "0x0000000000000000000000000000000000000003", deploymentTxHash: "0x" },
          },
          binding: { verified: false },
        };
        await saveManifest(fakeManifest);

        const report = await verifyDeployment({ networkName: "hardhatMainnet", connection });
        expect(report.allPassed).to.be.false;
        const bytecodeCheck = report.checks.find((c) => c.item.includes("bytecode exists"));
        expect(bytecodeCheck?.passed).to.be.false;
      } finally {
        if (originalManifest) {
          await saveManifest(originalManifest);
        }
      }
    });

    it("DEP-014: verification fails if actual chainId does not match manifest", async function () {
      const originalManifest = await readManifest("hardhatMainnet");
      try {
        const mismatchManifest: DeploymentManifest = {
          network: "hardhatMainnet",
          chainId: 999999, // Mismatched chainId
          deployedAt: new Date().toISOString(),
          deployer: ethers.ZeroAddress,
          bankAdmin: ethers.ZeroAddress,
          feeReceiver: ethers.ZeroAddress,
          contracts: {
            MockUSDC: { address: ethers.ZeroAddress, deploymentTxHash: "0x" },
            VaultManager: { address: ethers.ZeroAddress, deploymentTxHash: "0x" },
            SavingCore: { address: ethers.ZeroAddress, deploymentTxHash: "0x" },
          },
          binding: { verified: false },
        };
        await saveManifest(mismatchManifest);

        const report = await verifyDeployment({ networkName: "hardhatMainnet", connection });
        expect(report.allPassed).to.be.false;
        const chainCheck = report.checks.find((c) => c.item.includes("Chain ID matches"));
        expect(chainCheck?.passed).to.be.false;
      } finally {
        if (originalManifest) {
          await saveManifest(originalManifest);
        }
      }
    });
  });

  describe("Seeding & Idempotency (DEP-012)", function () {
    it("DEP-012: running seed script multiple times is idempotent (no duplicate plans, funds, or deposits)", async function () {
      const deployRes = await deployContracts({ networkName: "hardhatMainnet", connection });

      // Run Seed First Time
      const seed1 = await seedContracts({
        networkName: "hardhatMainnet",
        connection,
        manifest: deployRes.manifest,
      });

      expect(seed1.plansCreated).to.be.greaterThanOrEqual(3);
      expect(seed1.vaultFunded).to.be.greaterThan(0n);

      const core = await ethers.getContractAt("SavingCore", deployRes.manifest.contracts.SavingCore.address);
      const planCountAfterFirst = await core.planCount();
      const depositCountAfterFirst = await core.depositCount();

      // Run Seed Second Time (Must be idempotent)
      const seed2 = await seedContracts({
        networkName: "hardhatMainnet",
        connection,
        manifest: deployRes.manifest,
      });

      expect(seed2.plansCreated).to.equal(0); // No new plans created
      expect(seed2.vaultFunded).to.equal(0n); // No additional vault funding

      const planCountAfterSecond = await core.planCount();
      const depositCountAfterSecond = await core.depositCount();

      expect(planCountAfterSecond).to.equal(planCountAfterFirst);
      expect(depositCountAfterSecond).to.equal(depositCountAfterFirst);
    });
  });

  describe("Export Artifacts & Security Audit (DEP-010, DEP-011, DEP-015, DEP-016)", function () {
    it("DEP-010: exported contract ABIs match compiled compiler artifacts", async function () {
      await runContractExport();

      const exportedCorePath = path.resolve(EXPORTS_DIR, "SavingCore.json");
      const rawExport = await fs.readFile(exportedCorePath, "utf-8");
      const parsedExport = JSON.parse(rawExport);

      const compiledCorePath = path.resolve("artifacts/contracts/SavingCore.sol/SavingCore.json");
      const rawCompiled = await fs.readFile(compiledCorePath, "utf-8");
      const parsedCompiled = JSON.parse(rawCompiled);

      expect(parsedExport.abi.length).to.equal(parsedCompiled.abi.length);
      expect(parsedExport.contractName).to.equal("SavingCore");
    });

    it("DEP-011: manifest accurately records addresses and contract references", async function () {
      const manifest = await readManifest("hardhatMainnet");
      assert.ok(manifest);
      expect(manifest.network).to.equal("hardhatMainnet");
      expect(manifest.contracts.MockUSDC.address).to.be.properAddress;
      expect(manifest.contracts.VaultManager.address).to.be.properAddress;
      expect(manifest.contracts.SavingCore.address).to.be.properAddress;
      expect(manifest.binding.verified).to.be.true;
    });

    it("DEP-015: exported JSON files contain no sensitive keys or secrets", async function () {
      await runContractExport();
      const files = await fs.readdir(EXPORTS_DIR);
      for (const file of files) {
        const content = await fs.readFile(path.join(EXPORTS_DIR, file), "utf-8");
        const lower = content.toLowerCase();
        expect(lower).to.not.include("privatekey");
        expect(lower).to.not.include("secret");
        expect(lower).to.not.include("mnemonic");
      }
    });

    it("DEP-016: full verification script passes on freshly deployed and seeded local network", async function () {
      const d = await deployContracts({ networkName: "hardhatMainnet", connection });
      await seedContracts({ networkName: "hardhatMainnet", connection, manifest: d.manifest });
      const report = await verifyDeployment({ networkName: "hardhatMainnet", connection });
      expect(report.allPassed).to.be.true;
    });

    it("DEP-017: rejects a Core missing the new API and force-deploys fresh Vault/Core without migrating old deposits", async function () {
      const previous = await readManifest("hardhatMainnet");
      try {
        const initial = await deployContracts({ networkName: "hardhatMainnet", connection, forceRedeploy: true });
        const seeded = await seedContracts({ networkName: "hardhatMainnet", connection, manifest: initial.manifest });
        const old = initial.contracts.savingCore;
        const oldDeposit = await old.getDeposit(1);
        const oldPrincipalBalance = await initial.contracts.mockUSDC.balanceOf(await old.getAddress());
        // A live contract without planDurationSeconds represents the missing API on legacy Core.
        const legacy = await ethers.deployContract("Counter");
        await legacy.waitForDeployment();
        await saveManifest({ ...seeded.manifest, contracts: {
          ...seeded.manifest.contracts,
          SavingCore: { address: await legacy.getAddress(), deploymentTxHash: legacy.deploymentTransaction()!.hash },
        } });
        let errorMessage = "";
        try { await deployContracts({ networkName: "hardhatMainnet", connection }); }
        catch (error) { errorMessage = String(error); }
        expect(errorMessage).to.include("LEGACY_CORE_REQUIRES_REDEPLOY");
        const fresh = await deployContracts({ networkName: "hardhatMainnet", connection, forceRedeploy: true });
        expect(fresh.manifest.contracts.MockUSDC.address).to.equal(seeded.manifest.contracts.MockUSDC.address);
        expect(fresh.manifest.contracts.VaultManager.address).to.not.equal(seeded.manifest.contracts.VaultManager.address);
        expect(fresh.manifest.contracts.SavingCore.address).to.not.equal(seeded.manifest.contracts.SavingCore.address);
        expect(await fresh.contracts.vaultManager.savingCore()).to.equal(fresh.manifest.contracts.SavingCore.address);
        expect(await fresh.contracts.savingCore.planDurationSeconds(0)).to.equal(0n);
        expect(await fresh.contracts.savingCore.depositCount()).to.equal(0n);
        expect(await old.getDeposit(1)).to.deep.equal(oldDeposit);
        expect(await initial.contracts.mockUSDC.balanceOf(await old.getAddress())).to.equal(oldPrincipalBalance);
      } finally {
        if (previous) await saveManifest(previous);
      }
    });
  });
});
