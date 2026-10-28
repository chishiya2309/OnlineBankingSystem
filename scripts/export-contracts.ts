import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACTS_DIR,
  DEPLOYMENTS_DIR,
  EXPORTS_DIR,
  exportContracts,
  readManifest,
  type DeploymentManifest,
} from "./helpers/deployment-manifest.js";

export async function runContractExport(): Promise<void> {
  console.log(`\n================================================================`);
  console.log(`  EXPORTING CONTRACT ABIs AND DEPLOYMENT MANIFESTS`);
  console.log(`================================================================\n`);

  await fs.mkdir(EXPORTS_DIR, { recursive: true });

  const networkFiles = ["hardhatMainnet", "sepolia", "localhost"];
  let exportedAny = false;

  for (const net of networkFiles) {
    const manifest = await readManifest(net);
    if (manifest) {
      console.log(`Exporting deployment for network: ${net} (Chain ID: ${manifest.chainId})...`);
      await exportContracts(manifest);
      exportedAny = true;
    }
  }

  // If no manifests exist yet, export ABIs with empty address fields so frontend can still compile
  if (!exportedAny) {
    console.log(`No deployment manifests found yet. Exporting standard ABIs without addresses...`);
    const dummyManifest: DeploymentManifest = {
      network: "unspecified",
      chainId: 0,
      deployedAt: new Date().toISOString(),
      deployer: "",
      bankAdmin: "",
      feeReceiver: "",
      contracts: {
        MockUSDC: { address: "", deploymentTxHash: "" },
        VaultManager: { address: "", deploymentTxHash: "" },
        SavingCore: { address: "", deploymentTxHash: "" },
      },
      binding: { verified: false },
    };
    await exportContracts(dummyManifest);
  }

  // Verification & Secret Audit of Exported Files
  console.log(`\n--- Secret Audit on Exported Artifacts ---`);
  const exportedFiles = await fs.readdir(EXPORTS_DIR);
  for (const file of exportedFiles) {
    const fullPath = path.join(EXPORTS_DIR, file);
    const content = await fs.readFile(fullPath, "utf-8");

    // Check for common private key patterns or sensitive keywords
    const lower = content.toLowerCase();
    if (
      lower.includes("privatekey") ||
      lower.includes("mnemonic") ||
      lower.includes("secret") ||
      lower.includes("seedphrase")
    ) {
      throw new Error(`SECURITY ALERT: Potential sensitive credential detected in ${file}!`);
    }
    console.log(`[SAFE] ${file} (${Buffer.byteLength(content)} bytes) verified clean of secrets.`);
  }

  console.log(`\n================================================================`);
  console.log(`  EXPORT COMPLETED SUCCESSFULLY: ${EXPORTS_DIR}`);
  console.log(`================================================================\n`);
}

// Auto-run if executed directly via CLI or hardhat run
if (process.argv.some((arg) => arg.includes("export-contracts"))) {
  runContractExport()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Export script failed:", err.message || err);
      process.exit(1);
    });
}
