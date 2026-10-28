# LEDGER — Web3 Digital Savings & Term Deposit Frontend

A production-grade, fintech-focused Web3 frontend for the **Online Banking System (Blockchain-based Term Deposit)**. Built with **React 18, TypeScript, Vite, ethers.js 6**, and designed under the **Nutlope/Hallmark** design framework (Theme: **Dusk — Ledger / Digital Savings**).

---

## Key Features

- **MetaMask Web3 Connection**: Native EIP-1193 integration with real-time account and network state detection, automatic event listeners, and seamless network switching.
- **Local-first Architecture**: Direct persistent connection to Hardhat local node (`http://127.0.0.1:8545`, Chain ID `31337`), with optional, non-blocking support for Ethereum Sepolia (`11155111`).
- **Live On-chain Term Deposit Plans**: Dynamic querying of `planCount()` and `getPlan()` from `SavingCore.sol`. Accurately handles active and disabled states.
- **6-Decimal Token Arithmetic**: Strict precision formatting and parsing for `MockUSDC` (using `ethers.parseUnits(amount, 6)`); eliminates JavaScript floating-point errors.
- **Two-Step Approve & Open Deposit Flow**: Automatic detection of existing ERC20 allowances. Skips redundant approvals when allowance is already sufficient.
- **On-chain NFT Certificate Verification**: Parses the `DepositOpened` event upon transaction confirmation, queries `ownerOf(depositId)` to confirm ERC721 certificate ownership, and verifies active deposit state.
- **Hallmark Anti-AI-Slop Design**: Dusk palette featuring dark twilight slate surfaces, smoked glass product containers with lit edges, periwinkle and apricot signals, Wix Madefor typography, tabular numerals for all financial figures, and strict `:focus-visible` accessibility.
- **Built-in Demo Faucet**: One-click "Mint 1,000 USDC" action leveraging `MockUSDC.mint()` for self-serve testing with any connected MetaMask account.

---

## Project Structure

```
frontend/
├── public/
├── src/
│   ├── app/
│   │   └── App.tsx                 # Main application dashboard layout
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx          # Wordmark, network indicator, wallet connection
│   │   │   └── Footer.tsx          # Contract transparency & design attribution
│   │   ├── overview/
│   │   │   └── AccountOverview.tsx # Balances, allowances, and demo minting
│   │   ├── plans/
│   │   │   ├── PlanList.tsx        # Dynamic on-chain plans grid
│   │   │   └── PlanCard.tsx        # Individual plan terms (APR, tenor, penalty)
│   │   └── deposit/
│   │       ├── DepositForm.tsx     # Amount input, interest preview, approve & deposit
│   │       └── TransactionReceiptCard.tsx # Confirmed receipt & NFT proof
│   ├── config/
│   │   └── networks.ts             # Supported chains (31337 Localhost, 11155111 Sepolia)
│   ├── contracts/                  # Exported ABIs & address manifests (networks.json)
│   ├── hooks/
│   │   ├── useWallet.ts            # EIP-1193 MetaMask integration & listeners
│   │   ├── useContracts.ts         # Contract instances & runtime bytecode guards
│   │   ├── useSavingPlans.ts       # On-chain plan querying
│   │   └── useDepositFlow.ts       # Allowance, approve, openDeposit, and receipt parsing
│   ├── lib/
│   │   ├── contracts.ts            # Contract loader and bytecode verification
│   │   ├── errors.ts               # Human-readable Web3 and Solidity error translation
│   │   ├── financials.ts           # Exact contractual interest and penalty math
│   │   └── format.ts               # 6-decimal USDC, bps, duration, address formatters
│   ├── styles/
│   │   ├── tokens.css              # Hallmark Dusk CSS custom properties
│   │   ├── base.css                # Hallmark Floor constraints, focus, reset
│   │   └── app.css                 # Fintech dashboard design system
│   ├── test/                       # Vitest component & business logic unit tests
│   ├── types/                      # TypeScript domain models
│   ├── main.tsx                    # React application entry point
│   └── vite-env.d.ts               # Window.ethereum and Vite client declarations
├── index.html                      # HTML entry with Wix Madefor font imports
├── package.json                    # Dependencies & build scripts
├── tsconfig.json                   # Strict TypeScript configuration
└── vite.config.ts                  # Vite + Vitest configuration
```

---

## Getting Started

### 1. Ensure Hardhat Local Node is Running
From the repository root:
```powershell
npm run node
```
Keep this terminal running.

### 2. Deploy and Seed Contracts
In a second terminal:
```powershell
npm run deploy:localhost
npm run seed:localhost
npm run verify-deploy:localhost
npm run export-contracts
```

### 3. Launch Frontend Development Server
```powershell
cd frontend
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Connect MetaMask
1. Add/switch to network: **Hardhat Localhost**
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `31337`
   - Currency Symbol: `ETH`
2. Connect your account.
3. If your balance is 0.00 USDC, click **+ Mint 1,000 USDC**.
4. Select **Plan #1** (180 days, 2.00% APR).
5. Enter amount (e.g. `500.00` USDC).
6. Click **Step 1/2: Approve 500.00 MockUSDC** and confirm in MetaMask.
7. Click **Step 2/2: Open Deposit (500.00 USDC)** and confirm in MetaMask.
8. View your confirmed on-chain deposit receipt with new Certificate NFT ID (`#2 SDC`).

---

## Testing & Quality Assurance

- **TypeScript Typecheck**:
  ```powershell
  npm run typecheck
  ```
- **Vitest Unit Tests**:
  ```powershell
  npm test
  ```
- **Hallmark Sloplint Audit**:
  ```powershell
  npm run lint:hallmark
  ```
- **Production Build**:
  ```powershell
  npm run build
  ```
