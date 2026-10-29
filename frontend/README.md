# Ledger — Frontend user/admin

React 18 + TypeScript + Vite + ethers v6 cho Online Banking System. Hướng dẫn đầy đủ về kiến trúc, Personal Variant, setup, migration và 7 Design Answers nằm trong [README gốc](../README.md).

## Chạy nhanh

Từ root repository:

```powershell
npm.cmd ci
npm.cmd --prefix frontend ci
npm.cmd run demo:local
```

Mở `http://127.0.0.1:5174`, cấu hình MetaMask với RPC `http://127.0.0.1:18545`, chain ID 31337. Stack tự deploy/seed contract mới. Chi tiết tài khoản demo nằm trong README gốc và [D5-02](../document/D5-02.md).

Nếu dùng node persistent riêng tại 8545, chạy `deploy:localhost`, `seed:localhost`, `verify-deploy:localhost` từ root rồi `frontend:dev`; UI mặc định tại 5173. Với Sepolia, deploy/seed/verify đúng network trước và chọn chain 11155111 trong MetaMask.

## Luồng user

- Connect MetaMask, xem plan và số dư MockUSDC; faucet dùng token test permissionless.
- Chọn plan, nhập principal; approve nếu thiếu allowance rồi Open Deposit để nhận NFT.
- Portfolio đọc `ownerOf`, hiển thị Active/History và lineage; holder hiện tại được rút hoặc manual renew.
- Early withdrawal trả P − penalty; maturity trả P + I; manual renewal chọn target enabled; auto-renew giữ snapshot cũ sau grace.
- Eligibility dùng block timestamp; Refresh Portfolio sau thời gian thay đổi hoặc giao dịch bên ngoài. Receipt và balance được tải lại sau action thành công.

## Luồng admin

Admin Portal đọc role từ `VaultManager.owner()`. Có thể tạo plan với duration **Days/Minutes/Seconds**, sửa APR cho deposit tương lai, enable/disable plan, fund/withdraw vault, đổi feeReceiver và pause/unpause.

**Không có UI/API sửa timeline của deposit đang mở.** Kỳ hạn được chốt khi mở deposit; plan 5 giây vẫn dùng APR theo năm và grace 2 ngày. Lãi/payout của deposit dưới một ngày hiển thị đủ 6 decimals, ví dụ `0.000003 USDC`; timestamp hiển thị cả giây.

`planDurationSeconds` là nguồn duration chính xác. Trên deployment cũ, giao diện vẫn có thể đọc plan theo ngày nhưng không cho tạo plan ngắn và hiển thị yêu cầu deploy bản mới. Chỉ thay ABI/ẩn UI không loại bỏ được quyền timeline trên contract cũ; cần VaultManager/Core mới theo hướng dẫn migration ở README gốc.

## Kiểm thử

```powershell
npm.cmd --prefix frontend run typecheck
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:e2e:report
```

Đã xác minh 29/10/2026: **76 Vitest tests**, **10 browser E2E**, typecheck và build đạt. Browser E2E dùng provider EIP-1193 thử nghiệm với giao dịch thật trên Hardhat; không phải một phiên điều khiển extension MetaMask thật. Xem [D5-03](../document/D5-03.md) để biết bằng chứng mới nhất.

## Cấu hình và mã nguồn

`VITE_LOCAL_RPC_URL` đổi RPC local mặc định 8545; demo/E2E dùng 18545. ABI/địa chỉ nằm trong `src/contracts/`, được deploy/seed/export scripts sinh ra. Khi `BANKING_ARTIFACT_ROOT` được đặt cho demo/E2E, Vite dùng ABI/registry của thư mục output riêng, không ghi đè manifests đang dùng.

`src/hooks/` quản lý wallet, contracts, plans, deposit, portfolio, withdrawals, renewals và admin. `src/lib/` chứa math BigInt, format duration/USDC, giải mã revert bytes và portfolio discovery. `src/components/` chứa các view plans/deposit/portfolio/admin; `src/test/` là Vitest tests. Browser tests nằm tại `../e2e/`.
