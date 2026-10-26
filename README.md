# Online Banking System

Dự án tiền gửi có kỳ hạn trên blockchain. D1-02 chuẩn bị môi trường phát triển
smart contracts với Hardhat, TypeScript và ethers.js; hiện có contract mẫu Counter.

## Personal Variant

| Thông số | Giá trị |
| --- | --- |
| Hai chữ số cuối Student ID | 10 |
| A / B | 0 / 1 |
| Grace period | 2 ngày |
| Default APR | 200 bps (2.00%) |
| Early withdrawal penalty | 350 bps (3.50%) |
| Default tenor | 180 ngày |

Các giá trị nằm trong `config/personal-variant.ts`, chưa được đưa vào business
logic hoặc sample test. Theo công thức §8.1: grace = `(A % 3) + 2`, APR =
`200 + A * 25`, penalty = `300 + B * 50`; B lẻ nên tenor là 180 ngày.

Part D của [D1-01](document/D1-01.docx) và yêu cầu D1-02 xác định suffix 10.
Phần mở đầu, AD-01 và F2 của D1-01 vẫn nói A/B chưa xác nhận; đây là thông tin
chưa đồng bộ trong tài liệu. D1-02 giữ nguyên tài liệu gốc và chỉ lưu cấu hình.

## Yêu cầu môi trường

- Node.js: Hardhat 3 hỗ trợ từ 22.13.0 và các major chẵn còn được duy trì.
  Đã chọn Node.js **24.20.0**, ghi trong `.node-version`.
- npm **11.21.0**, Git; các lệnh dưới đây dùng PowerShell trên Windows.
- Cần mạng để tải dependencies và Solidity compiler trong lần chạy đầu.
- Chạy lệnh từ thư mục gốc chứa `package.json` và `hardhat.config.ts`.

```powershell
Set-Location 'D:\AppsCycloneIntern\OnlineBankingSystem'
node --version
npm.cmd --version
git --version
npm.cmd ci
```

`npm ci` cài đúng theo `package-lock.json` và thay thế thư mục `node_modules`
hiện có. Sau khi clone repo, dùng lệnh này để tái lập dependencies.
Trên macOS/Linux có thể dùng `npm`/`npx` thay cho `npm.cmd`/`npx.cmd`.

## Compile và test

```powershell
npm.cmd run compile
npm.cmd run typecheck
npm.cmd test
npm.cmd run coverage
```

Compile tạo artifacts và các type ethers trong `types/`.
Chạy compile trước typecheck, đặc biệt sau khi clone hoặc clean.
Hai tests kiểm tra `x = 0` khi deploy và `x = 1` sau một giao dịch `inc()` thành
công. Tests chạy trên blockchain local trong bộ nhớ, không cần chạy node riêng.

Coverage dùng tính năng tích hợp của Hardhat 3; báo cáo ở `coverage/`.
Coverage của Counter chỉ xác minh toolchain. Yêu cầu trên 90% của bài tập sẽ
được đánh giá trên business contracts và bộ tests nghiệp vụ ở các task sau.

## Các lệnh hỗ trợ

| Lệnh PowerShell | Công dụng |
| --- | --- |
| `npx.cmd hardhat --version` | Kiểm tra bản Hardhat local |
| `npm.cmd run compile` | Biên dịch Solidity |
| `npm.cmd test` | Chạy tests |
| `npm.cmd run typecheck` | Kiểm tra kiểu TypeScript |
| `npm.cmd run coverage` | Chạy tests kèm coverage |
| `npm.cmd run clean` | Xóa outputs có thể tái tạo của Hardhat |
| `npm.cmd run node` | Chạy JSON-RPC node local, để terminal mở |
| `npm.cmd ls` | Kiểm tra dependencies trực tiếp và peer dependencies |

Sau `clean`, chạy lại compile để tạo artifacts và types.
Mạng `hardhatMainnet` là mô phỏng L1 local; không kết nối Ethereum mainnet.
D1-02 không cần `.env`, RPC API key hoặc private key.

## Toolchain

| Package / công cụ | Phiên bản | Mục đích |
| --- | --- | --- |
| `hardhat` | 3.21.0 | Compiler orchestration, local network, tests và coverage |
| `@nomicfoundation/hardhat-toolbox-mocha-ethers` | 4.0.0 | Bộ plugin ethers, Mocha, Chai matchers, TypeChain, network helpers và Ignition |
| `typescript` | 6.0.3 | Typecheck; theo template Hardhat 3.21.0 |
| `ethers` | 6.17.0 | Deploy và gọi contracts trong TypeScript |
| `mocha` | 12.0.3 | Test runner |
| `chai` | 6.3.0 | Assertions |
| `@types/node` | 22.8.5 | Node types theo baseline của template |
| `@types/mocha` | 10.0.10 | Mocha types |
| `@types/chai` | 5.2.3 | Chai types theo template |
| `@openzeppelin/contracts` | 5.6.1 | ERC20, ERC721 và access control cho giai đoạn sau |
| Solidity | 0.8.34 | Compiler theo template, tương thích thư viện đã chọn |

OpenZeppelin thuộc `dependencies`; công cụ phát triển thuộc `devDependencies`.
Các dependencies trực tiếp được pin chính xác. npm giải quyết peer dependencies
của toolbox và lưu toàn bộ cây phụ thuộc trong lockfile; không đăng ký lại từng
plugin đã được toolbox nạp. Không cài coverage plugin riêng. npm 11.21 chỉ được phê duyệt script cài đặt của `esbuild@0.28.2`, theo phiên bản trong lockfile. Cache npm nằm trong `.npm-cache/` của project qua `.npmrc` để tránh ghi cache lớn vào ổ hệ điều hành.

Project được tạo trực tiếp theo template chính thức **Mocha and Ethers.js** của
Hardhat 3.21.0 trong repo hiện có. Cấu hình chỉ giữ mạng local, một Counter và
hai tests TypeScript. Cấu hình TypeScript dùng ESM, `module: node20`,
`target: es2023`, `strict: true`, `noEmit: true`; tests dùng
`await network.create()` của Hardhat 3.

## Cấu trúc

```text
config/personal-variant.ts   # Cấu hình cho các task tiếp theo
contracts/Counter.sol       # Sample contract
test/Counter.ts             # Hai smoke tests TypeScript
scripts/                    # Chỗ cho scripts sau này
ignition/modules/           # Chỗ cho deployment modules sau này
frontend/                   # Chỗ cho React app sau này
document/                   # Hai tài liệu đầu vào và báo cáo D1-02
hardhat.config.ts
tsconfig.json
package.json
package-lock.json
```

Thư mục chưa có mã nguồn dùng `.gitkeep`. Artifacts, cache, generated types,
coverage, dependencies, `.env` và file Word tạm được Git bỏ qua.
`document/Document.docx` là tài liệu local ngoài phạm vi D1-02 và cũng được bỏ qua.

## Xử lý lỗi setup

- `HHE3: No Hardhat config file found`: kiểm tra đang đứng ở thư mục gốc repo.
- PowerShell chặn script `npm.ps1`: dùng `npm.cmd` và `npx.cmd` như trên.
- `ERESOLVE` hoặc peer dependency lỗi: đối chiếu phiên bản trong `package.json`
  với `npm.cmd ls`; xác định nguyên nhân trước khi chỉnh phiên bản. Không dùng
  `--force` hay `--legacy-peer-deps`.
- Lỗi download dependencies/compiler: kiểm tra mạng và quyền truy cập theo lỗi
  thực tế; giữ nguyên source và lockfile trong khi xử lý.
- TypeScript báo contract types chưa tồn tại: chạy compile trước typecheck.

## Kết quả kiểm tra dependencies

`npm ls --all` không phát hiện peer dependency conflict. `npm audit --omit=dev`
không phát hiện lỗ hổng. Full audit báo **13 high**, cùng bắt nguồn từ
`zod@3.25.76` trong Hardhat và các plugin, theo
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
Advisory mô tả nguy cơ cạn bộ nhớ khi xử lý collection quá lớn; bản vá là Zod
4.6.6, ngoài major mà toolchain hiện dùng. D1-02 giữ compatibility của stack đã
kiểm chứng và ghi nhận cảnh báo này; chưa có bản sửa trong phạm vi dependency
hiện tại. Cần cập nhật và kiểm thử lại khi upstream hỗ trợ bản đã vá.

Hai cảnh báo deprecated `glob@7.1.7` và `inflight@1.0.6` đến từ
`hardhat-typechain -> typechain@8.3.2 -> glob@7.1.7`; không ép đổi major của
package gián tiếp. Các cảnh báo này không làm thất bại compile hoặc sample tests.
## Tài liệu tham khảo

- [Final Assignment](document/Final_Assignment.docx)
- [Báo cáo D1-02](document/D1-02.md)
- [Hardhat 3 getting started](https://hardhat.org/docs/getting-started)
- [Hardhat Node.js support](https://hardhat.org/docs/reference/nodejs-support)
- [Mocha/ethers toolbox](https://hardhat.org/docs/plugins/hardhat-toolbox-mocha-ethers)
- [Testing với ethers](https://hardhat.org/docs/guides/testing/using-ethers)
- [Coverage tích hợp](https://hardhat.org/docs/guides/testing/code-coverage)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/5.x)

Các task sau triển khai MockUSDC (6 decimals), VaultManager và SavingCore
(ERC721 certificates), rồi mới tích hợp React/MetaMask và local deployment.
