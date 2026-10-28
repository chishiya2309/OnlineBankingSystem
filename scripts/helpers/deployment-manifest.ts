import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "../..");
export const DEPLOYMENTS_DIR = path.resolve(PROJECT_ROOT, "deployments");
export const EXPORTS_DIR = path.resolve(PROJECT_ROOT, "exports/contracts");
export const ARTIFACTS_DIR = path.resolve(PROJECT_ROOT, "artifacts/contracts");

export interface ContractDeploymentRecord {
  address: string;
  deploymentTxHash: string;
  blockNumber?: number;
}

export interface DeploymentManifest {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  bankAdmin: string;
  feeReceiver: string;
  contracts: {
    MockUSDC: ContractDeploymentRecord;
    VaultManager: ContractDeploymentRecord;
    SavingCore: ContractDeploymentRecord;
  };
  binding: {
    txHash?: string;
    verified: boolean;
  };
  seed?: {
    verified: boolean;
    seededAt?: string;
    planCount?: number;
    vaultFundedAmount?: string;
    demoUserMinted?: string;
    sampleDepositId?: number;
  };
}

export interface NetworkMapping {
  name: string;
  chainId: number;
  contracts: {
    MockUSDC: string;
    VaultManager: string;
    SavingCore: string;
  };
}

/**
 * Loads .env file if it exists without external dotenv dependency.
 */
export async function loadEnvFile(): Promise<void> {
  if (process.env.SKIP_LOAD_ENV === "true") return;
  const envPath = path.resolve(PROJECT_ROOT, ".env");
  try {
    const content = await fs.readFile(envPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional
  }
}

export function getManifestPath(networkName: string): string {
  return path.resolve(DEPLOYMENTS_DIR, `${networkName}.json`);
}

export async function saveManifest(manifest: DeploymentManifest): Promise<void> {
  await fs.mkdir(DEPLOYMENTS_DIR, { recursive: true });
  const manifestPath = getManifestPath(manifest.network);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

export async function readManifest(networkName: string): Promise<DeploymentManifest | null> {
  const manifestPath = getManifestPath(networkName);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as DeploymentManifest;
  } catch {
    return null;
  }
}

/**
 * Exports contract ABI and address mappings to exports/contracts/ for frontend integration.
 */
export async function exportContracts(manifest: DeploymentManifest): Promise<void> {
  await fs.mkdir(EXPORTS_DIR, { recursive: true });

  const contractNames = ["MockUSDC", "VaultManager", "SavingCore"] as const;

  for (const name of contractNames) {
    const artifactPath = path.resolve(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
    const rawArtifact = await fs.readFile(artifactPath, "utf-8");
    const parsed = JSON.parse(rawArtifact);

    const exportData = {
      contractName: name,
      address: manifest.contracts[name]?.address ?? "",
      deploymentTxHash: manifest.contracts[name]?.deploymentTxHash ?? "",
      blockNumber: manifest.contracts[name]?.blockNumber ?? 0,
      network: manifest.network,
      chainId: manifest.chainId,
      abi: parsed.abi,
    };

    const outPath = path.resolve(EXPORTS_DIR, `${name}.json`);
    await fs.writeFile(outPath, JSON.stringify(exportData, null, 2), "utf-8");
  }

  // Update networks.json
  const networksPath = path.resolve(EXPORTS_DIR, "networks.json");
  let networks: Record<string, NetworkMapping> = {};
  try {
    const existing = await fs.readFile(networksPath, "utf-8");
    networks = JSON.parse(existing);
  } catch {
    networks = {};
  }

  // Purge test chain IDs that are not standard supported networks
  delete networks["999999"];
  delete networks["0"];

  if (manifest.chainId && manifest.chainId !== 999999) {
    networks[manifest.chainId.toString()] = {
      name: manifest.network,
      chainId: manifest.chainId,
      contracts: {
        MockUSDC: manifest.contracts.MockUSDC.address,
        VaultManager: manifest.contracts.VaultManager.address,
        SavingCore: manifest.contracts.SavingCore.address,
      },
    };
  }

  await fs.writeFile(networksPath, JSON.stringify(networks, null, 2), "utf-8");

}
