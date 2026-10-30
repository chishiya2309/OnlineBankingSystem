# Kịch bản quay video demo Online Banking System

Ngày biên soạn: 30/10/2026 (Asia/Saigon). Video thành phẩm: **4 phút 50 giây**, trong giới hạn 3–5 phút của `Final_Assignment.docx`. Hướng dẫn này bám source hiện tại; không xác nhận rằng các thao tác demo bên dưới đã được thực hiện trên Sepolia.

**Phương án:** giao dịch người dùng và quản trị trên Sepolia; auto-renew và pause trên Hardhat local. Khi đổi mạng phải có bảng chữ và thấy network badge. Thời lượng là thời gian sau dựng; buổi ghi hình thực tế lâu hơn vì chờ giao dịch.

## 1. Chuẩn bị ngoài thời lượng video

### 1.1. Bố trí màn hình và cửa sổ

- Quay 1920×1080, 30 fps, zoom trình duyệt 100%; nếu chữ nhỏ thì tăng 110% và kiểm tra form không bị cắt.
- Cửa sổ A: frontend Sepolia, MetaMask profile chứa admin/user Sepolia. Cửa sổ B: frontend local, profile MetaMask riêng chỉ dùng tài khoản test local. Đặt tên cửa sổ hoặc thêm overlay `SEPOLIA — giao dịch testnet` / `LOCAL — Hardhat 31337`.
- Ghim tab frontend, explorer và README. Thu gọn thanh bookmark, tắt notification; khi ký, để popup MetaMask hiện đủ network, tài khoản và nội dung giao dịch.
- Terminal chỉ xuất hiện trong cảnh local. Không ghi hình nội dung `.env`, private key, seed phrase hoặc màn hình import ví. Chuẩn bị tài khoản trước khi bật recorder.
- Dùng lời thoại ở mục 3 để thu âm trực tiếp hoặc voice-over. Dừng chuột 1–2 giây trên dữ liệu cần đọc; không cuộn trong khi đọc một con số.

### 1.2. Khởi chạy hai môi trường

Mở PowerShell tại repository. Nếu chưa cài dependencies, chạy trước buổi quay:

```powershell
Set-Location 'D:\AppsCycloneIntern\OnlineBankingSystem'
npm.cmd ci
npm.cmd --prefix frontend ci
```

Terminal A — frontend dùng registry Sepolia của repository:

```powershell
Set-Location 'D:\AppsCycloneIntern\OnlineBankingSystem'
Remove-Item Env:BANKING_ARTIFACT_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:VITE_LOCAL_RPC_URL -ErrorAction SilentlyContinue
npm.cmd run frontend:dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Mở **http://127.0.0.1:5173** trong cửa sổ A, chọn Sepolia trong MetaMask, bấm `Connect MetaMask`. Chain ID **11155111**. Không chạy deploy/seed lại chỉ để quay video.

Terminal B — stack demo local độc lập:

```powershell
Set-Location 'D:\AppsCycloneIntern\OnlineBankingSystem'
npm.cmd run demo:local
```

Chờ deploy, seed, verify và Vite sẵn sàng. Giữ terminal này chạy. Mở **http://127.0.0.1:5174** trong cửa sổ B. Network MetaMask local:

| Trường | Giá trị |
| --- | --- |
| Network name | Hardhat Demo |
| RPC URL | `http://127.0.0.1:18545` |
| Chain ID | `31337` |
| Currency symbol | `ETH` |
| Block explorer | Để trống |

Nếu đã có chain 31337 trỏ 8545, sửa RPC thành 18545. Dùng tài khoản fixture mặc định của Hardhat, tạo/import trước khi quay; chỉ dùng các tài khoản này ở local. Xem hướng dẫn fixture ở [D5-02](D5-02.md), không quay phần thông tin khôi phục ví.

| Vai trò local | Account | Địa chỉ |
| --- | --- | --- |
| Admin | #1, tài khoản thứ hai | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Alice/user | #2, tài khoản thứ ba | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |

Local seed thường có Alice 9.000 USDC còn trong ví và một sổ 1.000 USDC; luôn kiểm tra ID thực tế trên UI. Stack local xuất artifacts riêng trong `.e2e/runtime/`, không thay registry Sepolia. Không mở cửa sổ local bằng frontend 5173 vì nó có thể đọc địa chỉ local khác với stack demo.

### 1.3. Địa chỉ Sepolia cần đối chiếu

Các địa chỉ dưới lấy từ `deployments/sepolia.json` tại thời điểm soạn; trước buổi quay đối chiếu lại manifest và `Admin Portal`. Đây không phải truy vấn số dư live.

| Thành phần | Địa chỉ / explorer |
| --- | --- |
| Admin và feeReceiver cấu hình | `0xA4CDcB4eFd9D4615586a6d78CB1283656078249c` |
| SavingCore mới | [0x69371d5829aEb695BC4b12Bd9243AF8584eb0681](https://sepolia.etherscan.io/address/0x69371d5829aEb695BC4b12Bd9243AF8584eb0681) |
| VaultManager mới | [0xE3D2f34cAe33D694e649c5975A4875E026bdf4c2](https://sepolia.etherscan.io/address/0xE3D2f34cAe33D694e649c5975A4875E026bdf4c2) |
| MockUSDC giữ lại | [0x578d4C3f5A95a6797aD8445487062b6469768a58](https://sepolia.etherscan.io/address/0x578d4C3f5A95a6797aD8445487062b6469768a58) |

Ví admin Sepolia phải đúng quyền hiện tại trên chain. Dùng ví user riêng, có ETH Sepolia để trả gas. Không chuyển ETH thật sang ví test. Sổ trên Core cũ vẫn ở Core cũ, không tự chuyển sang Core mới.

### 1.4. Dữ liệu phải chuẩn bị trước

Trong form nhập **`1000`**, **`3.5`**, **`2`**; không nhập dấu phân cách hàng nghìn kiểu `1.000` hoặc `%`. Tài liệu dùng dấu phẩy thập phân khi giải thích; UI có thể định dạng theo locale khác.

1. Kiểm tra plan mặc định 180 ngày, APR 2%, penalty 3,5%, và plan 360 ngày APR 5% đang enabled. Nếu dữ liệu đã bị sửa, dùng admin khôi phục APR/trạng thái cho lần quay; ghi nhận mọi giao dịch chuẩn bị. Không mặc định ID vẫn là #1/#2 nếu registry thay đổi.
2. User bấm `+ Mint 1,000 USDC` ở phần tổng quan tài khoản, ký và chờ xác nhận. Lặp đủ để chuẩn bị hai sổ bên dưới và còn ít nhất 1.000 USDC cho cảnh mở sổ mới. Dự trù **ít nhất 3.000 USDC trước khi tạo hai sổ chuẩn bị**. Đây là faucet MockUSDC, không phải USDC thật.
3. Mở trước sổ **E**: plan 180 ngày, principal `1000`, để Active cho cảnh rút sớm. Chụp `Fixed APR Snapshot`, `Maturity Date`, penalty và ID.
4. Admin tạo trước plan **P_PREP**: 5 giây, APR 2%, penalty 3,5%, min 1, max trống, enabled. User mở trước sổ **M** principal `1000` trên plan này; chờ đáo hạn nhưng không rút/renew. Quay phần chuẩn bị này làm footage dự phòng. **Không dùng P_PREP làm plan vừa tạo trong cảnh 2.**
5. Mỗi lần approve mở sổ, giữ hạn mức đúng số tiền nếu muốn allowance về 0 sau mở. Trước cảnh 3 kiểm tra thông báo/bước trên UI: nếu nút hiện `Step 2/2`, allowance đã đủ; chuẩn bị ví khác hoặc thu hồi allowance với công cụ ví có hỗ trợ trước khi quay. Không giả vờ đã approve nếu UI bỏ qua bước này.
6. Admin kiểm tra `Vault interest pool` đủ lãi cho các cảnh và ví có ≥100 MockUSDC để fund. Có thể bấm `+ Mint 5,000 test USDC` ngoài video nếu cần. Số dư 5.000 từ seed chỉ là lịch sử, không đảm bảo số dư hiện tại.
7. Local: ghi sổ Active của Alice làm **L_AUTO**. Tạo thêm một sổ riêng **L_PAUSE**, principal `1000`, plan 180 ngày, để thử rút sau cảnh auto. Việc tua đến grace của L_AUTO có thể khiến L_PAUSE cũng đáo hạn; lúc đó dùng `Withdraw at Maturity`, không cố rút sớm.
8. Lưu một bản ảnh snapshot của E/M và một bản của sổ đối chiếu **S_SNAPSHOT** sẽ tạo trong cảnh 3 theo hướng dẫn cảnh 6. Chuẩn bị clipboard giá trị `1000`, `100`, `50`, và lệnh local đã thay ID.

### 1.5. Phiếu ghi dữ liệu thực tế

Điền vào bản sao của bảng này khi rehearsal. Các ký hiệu là nhãn trong kịch bản, không phải ID on-chain.

| Nhãn | Mạng | Plan ID | Deposit ID | Tx hash / ghi chú |
| --- | --- | --- | --- | --- |
| User | Sepolia | — | — | Địa chỉ: … |
| E — rút sớm | Sepolia | … | … | Open: …; Withdraw: … |
| P_PREP / M — manual renew | Sepolia | … | … | Open: …; Renew: …; successor: … |
| P_LIVE — tạo trong cảnh 2 | Sepolia | … | — | Create: … |
| W — rút đáo hạn trong cảnh 3 | Sepolia | P_LIVE | … | Approve: …; Open: …; Withdraw: … |
| S_SNAPSHOT — đối chiếu APR | Sepolia | P_LIVE | … | Open: …; APR cũ: …; maturity: … |
| L_AUTO | Local | … | … | Renew: …; successor: … |
| L_PAUSE | Local | … | … | Withdraw sau unpause: … |
| Vault admin | Sepolia | — | — | Balance trước: …; Fund: …; Withdraw: … |

## 2. Timeline thành phẩm

| Thời gian | Cảnh | Mạng |
| --- | --- | --- |
| 00:00–00:25 | Giới thiệu và Personal Variant | Sepolia + README |
| 00:25–00:55 | Admin tạo plan 5 giây | Sepolia |
| 00:55–01:40 | User approve, mở sổ, rút đáo hạn | Sepolia |
| 01:40–02:10 | Rút sớm sổ E | Sepolia |
| 02:10–02:40 | Manual renew sổ M | Sepolia |
| 02:40–03:20 | APR snapshot, disable/enable, fund/withdraw | Sepolia |
| 03:20–04:15 | Auto-renew sau grace 2 ngày | Local |
| 04:15–04:50 | Pause/unpause và kết quả kiểm thử | Local + README |

## 3. Kịch bản từng cảnh

### Cảnh 1 — 00:00–00:25: Giới thiệu

**Màn hình:** cửa sổ A, `Saving Plans & Open`, thấy badge Sepolia; tiếp đó tab README phần Personal Variant.

**Thao tác:** trỏ plan mặc định 180 ngày/2%; chuyển README chỉ vào suffix `10`, tenor 180 ngày, APR 200 bps, penalty 350 bps, grace 172.800 giây; trở lại frontend.

**Lời thoại:**

> “Đây là hệ thống sổ tiết kiệm blockchain với vai trò người gửi và quản trị ngân hàng. Personal Variant của em là kỳ hạn mặc định 180 ngày, lãi suất năm 2%, phí rút sớm 3,5%, grace 2 ngày. SavingCore giữ tiền gốc và chứng chỉ NFT; VaultManager giữ quỹ trả lãi. Phần đầu em demo giao dịch thật trên Sepolia.”

**Output:** số trên README khớp plan mặc định. **Cắt dựng:** chuyển tab gọn, không quay màn hình tìm file. Hiện overlay `MockUSDC test token — Sepolia`.

### Cảnh 2 — 00:25–00:55: Admin tạo plan demo 5 giây

**Màn hình:** MetaMask chọn admin → frontend `Admin Portal` → `Saving plans management`.

**Thao tác và dữ liệu:**

1. Kiểm tra địa chỉ admin và contract mới. Bấm `+ New saving plan`.
2. `Duration unit` = `Seconds`; `Tenor (seconds)` = `5`; `Contractual APR (%)` = `2`; `Early penalty (%)` = `3.5`.
3. `Min deposit (USDC)` = `1`; max để trống (không giới hạn); `Enabled immediately` bật. Nếu chữ hoa/thường của nhãn min/max khác, dùng đúng hai trường min/max trong form.
4. Bấm `Create saving plan`, ký MetaMask, chờ receipt. Ghi ID plan mới vào **P_LIVE**.

**Lời thoại:**

> “Admin tạo thêm plan 5 giây để quay cảnh đáo hạn mà không chờ 180 ngày. APR vẫn là 2% một năm, penalty 3,5%. Đây là plan demo bổ sung, không thay kỳ hạn mặc định hoặc grace 2 ngày. Admin chỉ quản trị plan, không được đổi điều khoản của sổ đã mở.”

**Output:** plan P_LIVE hiển thị 5 giây, APR 2%, enabled; tx confirmed. **Cắt dựng:** giữ cảnh bấm, ký, và kết quả; khoảng pending chèn chữ `Chờ xác nhận giao dịch` rồi cắt đến receipt.

### Cảnh 3 — 00:55–01:40: Hai bước mở sổ và rút đáo hạn

**Màn hình:** đổi MetaMask sang user, `Saving Plans & Open` → P_LIVE → `My Portfolio`.

**Thao tác và dữ liệu:**

1. Chọn `Select Plan` trên P_LIVE, nhập amount `1000`. Quay dự toán lãi/payout sáu chữ số thập phân.
2. Bấm nút `Step 1/2: Approve … MockUSDC`, ký MetaMask, chờ xác nhận. Nếu ví cho sửa spending cap, đặt đúng `1000`.
3. Bấm `Step 2/2: Open Deposit (… USDC)`, ký lần hai. Giữ khung `Deposit Confirmed on Blockchain`, `Certificate Token ID`, owner và hash. Ghi ID **W**.
4. Bấm hash để mở explorer; quay network Sepolia và trạng thái giao dịch thành công. Trở lại UI, bấm `View Certificate in Portfolio`.
5. Chờ block thật đã qua maturity, bấm `Refresh Portfolio`, chọn W → `Withdraw at Maturity` → `Confirm Settlement`, ký và chờ kết quả.
6. Giữ màn `Maturity Settlement Successful` và `Total Payout Received`; sau đóng dialog, mở `Certificate History (…)` để thấy `Withdrawn`.

**Lời thoại:**

> “Em gửi 1.000 MockUSDC. Bước đầu cấp quyền chuyển token ERC-20; bước hai mới chuyển tiền và tạo sổ NFT. Sau đáo hạn, em nhận lại gốc và lãi. Với 5 giây, APR 2%, lãi làm tròn xuống còn 0,000003 USDC, nên tổng nhận là 1.000,000003 USDC. Tiền lãi lấy từ Vault, không lấy từ tiền gốc của người gửi khác.”

**Output:** hai receipt riêng nếu allowance ban đầu bằng 0; NFT đúng user; payout `1000.000003` theo định dạng UI. Công thức: `floor(1_000_000_000 × 200 × 5 / (10_000 × 31_536_000)) = 3` token units. ETH gas tính riêng, không trừ vào payout MockUSDC.

**Cắt dựng:** quay đầy đủ các thao tác, rút ngắn thời gian chờ. Có thể sổ đã đáo hạn ngay khi UI hiện receipt; dùng timestamp và trạng thái thực tế, không cần cố ghi một khoảng Active trước maturity.

**Take bổ sung ngoài timeline:** trước khi sửa APR ở cảnh 6, mở thêm sổ **S_SNAPSHOT** trên P_LIVE với `1000`, APR vẫn 2%; không rút/renew. Quay snapshot ID/APR/maturity, dựng một đoạn đối chiếu ngắn vào cảnh 6 với chú thích `Sổ đối chiếu mở trước khi sửa APR`. Không dùng W đã Withdrawn để tuyên bố đang còn Active.

### Cảnh 4 — 01:40–02:10: Rút sớm

**Màn hình:** `My Portfolio` → `Active Deposits (…)` → sổ **E** đã chuẩn bị, tenor 180 ngày.

**Thao tác:** kiểm tra đúng ID E, principal 1000, chưa maturity; bấm `Withdraw Early`; quay preview penalty 3,5%, lãi 0, net 965; bấm `Confirm Early Withdrawal`, ký. Giữ `Early Withdrawal Settled`, `Penalty Deducted`, `Net Payout Received`; xem E trong `Certificate History (…)`.

**Lời thoại:**

> “Với sổ 180 ngày em rút trước hạn: không nhận lãi, phí 3,5% của 1.000 là 35 USDC. Ví nhận 965 USDC, còn 35 chuyển tới feeReceiver. Chứng chỉ được ghi lịch sử Withdrawn và không thể rút lần hai.”

**Output:** payout 965, penalty 35, status Withdrawn. Nếu muốn chứng minh bên nhận phí, mở token transfers của receipt và đối chiếu feeReceiver thực tế; không chỉ dựa vào số dư ví admin vì admin có thể có giao dịch khác.

**Cắt dựng:** bỏ khoảng pending, giữ preview và receipt. Không dùng plan 5 giây cho cảnh này.

### Cảnh 5 — 02:10–02:40: Manual renew

**Màn hình:** user → `My Portfolio`, sổ **M** đã đáo hạn, mở trên P_PREP trước buổi quay.

**Thao tác:** bấm `Refresh Portfolio`, M → `Manual Renew`; tại `Select Target Saving Plan:` chọn plan **360 ngày, APR 5%** đang enabled; kiểm tra principal mới; bấm `Confirm Renewal`, ký. Quay successor ID, compounded principal và liên kết `Renewed from #…`; sổ M nằm trong history với `Manual Renewed`.

**Lời thoại:**

> “Thay vì nhận tiền về ví, em tái tục sổ đã đáo hạn sang plan 360 ngày, APR 5%. Gốc mới bằng gốc cũ cộng lãi, là 1.000,000003 USDC. Hệ thống tạo NFT kế tiếp và lưu liên kết với sổ trước; thao tác này không cần approve USDC vì không nạp thêm tiền từ ví.”

**Output:** một giao dịch renewal, successor thuộc user, principal mới đúng; số dư USDC ví không tăng do tái tục. **Cắt dựng:** caption `Sổ 5 giây đã chuẩn bị trước: M = #…`; không để người xem hiểu nhầm đang renew W đã rút.

### Cảnh 6 — 02:40–03:20: Quản trị và snapshot bất biến

**Màn hình:** ảnh/footage S_SNAPSHOT trước sửa → admin `Admin Portal` → user portfolio để đối chiếu.

**Thao tác:**

1. P_LIVE → `Edit APR`, nhập `3` (3%, không phải 300), bấm `Save`, ký. Quay APR plan thành 3%.
2. Quay footage user `View Details` của S_SNAPSHOT sau refresh: APR vẫn 2%, maturity khớp ảnh trước, sổ vẫn Active dù đã maturity. Không có form sửa deposit.
3. Admin bấm `Disable`, ký, quay trạng thái Disabled; sang màn plan user nếu cần thấy `Plan Disabled`. Quay lại admin `Enable`, ký. Không tạo thêm sổ để thử một giao dịch chắc chắn thất bại.
4. Trong `Vault liquidity reserves`, ghi balance **B**; ô `Fund vault liquidity` nhập `100`, bấm `Fund vault`. Ký approve nếu ví yêu cầu, rồi ký fund; chờ mỗi giao dịch thành công.
5. Ô `Withdraw surplus liquidity` nhập `50`, bấm `Withdraw liquidity`, ký. Tiền về admin, không có trường recipient tùy ý.

**Lời thoại:**

> “Em đổi APR plan từ 2% lên 3%, nhưng sổ đã mở vẫn giữ APR 2% và ngày đáo hạn cũ. Disable chỉ chặn gửi mới vào plan. Admin nạp 100 rồi rút 50 từ quỹ lãi, nên quỹ tăng ròng 50 nếu không có giao dịch khác xen vào. Các thao tác này không sửa tiền gốc của sổ đã mở.”

**Output:** P_LIVE enabled trở lại, APR 3%; S_SNAPSHOT giữ snapshot; Vault B → B+100 → B+50, admin nhận 50 khi withdraw. Nếu có giao dịch khác xen vào thì dùng event/receipt đối chiếu thay vì khẳng định balance delta toàn cục.

**Cắt dựng:** đây là nhiều giao dịch, bắt buộc cắt chờ và dùng montage có nhãn thao tác. Chèn snapshot trước/sau 3–4 giây; không tua nhanh đến mức không đọc được số. Giữ tổng cảnh 40 giây nhờ voice-over.

### Cảnh 7 — 03:20–04:15: Auto-renew sau grace trên local

**Màn hình:** bảng chữ 2 giây `CHUYỂN SANG LOCAL — Hardhat 31337 — RPC 18545`; cửa sổ B port 5174, Alice.

**Thao tác:**

1. `My Portfolio` → L_AUTO, quay `View Details`: principal, APR 2%, tenor 180 ngày và maturity. Dùng dữ liệu thực tế nếu fixture đã thay đổi.
2. Terminal C tại repo, chạy lệnh đã thay ID (ví dụ ID là 1 thì gõ số 1; không gõ dấu `< >`):

```powershell
Set-Location 'D:\AppsCycloneIntern\OnlineBankingSystem'
# Thay 1 bằng ID L_AUTO đang Active của phiên local hiện tại
npm.cmd run demo:time -- --grace 1
```

3. Quay dòng terminal báo certificate/chain time/target; trở lại UI → `Refresh Portfolio` → đúng L_AUTO → `Auto Renew`.
4. Quay preview locked APR/tenor và compounded principal; bấm `Trigger Auto Renewal`, ký MetaMask local. Giữ kết quả successor ID và owner; mở history thấy `Auto Renewed`.

**Lời thoại:**

> “Để không chờ 180 ngày cộng grace 2 ngày, em chuyển sang Hardhat local. Helper chỉ đưa thời gian blockchain local tới cuối grace; không sửa điều khoản của sổ và không chạy được trên Sepolia. Sau mốc này, một caller kích hoạt auto-renew. Gốc mới cộng lãi, kỳ hạn và APR giữ snapshot cũ. Đây là giao dịch kích hoạt thủ công, không phải một bot production đang chạy liên tục.”

**Output nếu L_AUTO là sổ 180 ngày, 1.000 USDC, APR 2%:** lãi `9.863013`, gốc mới `1009.863013` USDC; tenor 180 ngày, APR 2%, penalty 3,5%, owner Alice, predecessor Auto Renewed. Lãi chỉ tính tenor hợp đồng, không cộng thêm 2 ngày grace.

**Cắt dựng:** giữ terminal và network badge; bỏ thời gian chuyển cửa sổ thừa. Local không có Etherscan: dùng tx hash, receipt UI và evidence local; không mở hash local trên explorer Sepolia.

### Cảnh 8 — 04:15–04:50: Pause/unpause và kết thúc

**Màn hình:** local admin → `Admin Portal`; local Alice → sổ L_PAUSE; kết thúc README/evidence.

**Thao tác:**

1. MetaMask local đổi Admin #1; bấm `Emergency pause`, ký, thấy `Vault paused`.
2. Đổi Alice; refresh, chọn L_PAUSE → nút rút phù hợp thời gian hiện tại. Bấm xác nhận settlement để thấy thông báo pause. Nếu giao dịch bị chặn từ bước estimate gas thì quay lỗi UI, không cố gửi và không khẳng định có receipt reverted.
3. Admin bấm `Unpause system`, ký; Alice refresh và thực hiện rút lại thành công. Quay receipt hoặc trạng thái phục hồi.
4. Chuyển tab README phần kiểm thử và `Design Answers`; hiện bảng kết quả từ báo cáo đã lưu, không giả lập terminal đang chạy test mới.

**Lời thoại:**

> “Khi có sự cố, admin pause sẽ chặn rút và tái tục. Sau unpause, người dùng tiếp tục settlement bình thường. Admin không có quyền sửa sổ đã mở. Báo cáo kiểm thử đã lưu ghi nhận 535 contract tests, 76 frontend tests và 10 E2E. README có đủ Personal Variant cùng bảy Design Answers khớp mã nguồn.”

**Output:** paused chặn settlement, unpaused phục hồi; kết quả kiểm thử có nguồn [D5-03](D5-03.md), [E2E evidence](evidence/D5-03-e2e.json). Đây là số liệu của lần chạy đã ghi nhận, không phải khẳng định vừa chạy lại trong buổi quay.

**Cắt dựng:** montage ký local và kết quả; dành 8–10 giây cuối cho bảng kết quả. Nếu thiếu thời lượng, chuyển phần giải thích dài sang phụ lục, không cắt bỏ thông tin đổi mạng.

## 4. Bằng chứng, reset cảnh và checklist quay

### 4.1. Lưu bằng chứng thực tế

- Mỗi receipt: lưu hash đầy đủ vào phiếu, network, loại thao tác, ID trước/sau, ảnh preview và ảnh confirmed. Trên Sepolia mở `https://sepolia.etherscan.io/tx/` cộng hash thực tế; tại màn mở sổ có thể bấm trực tiếp hash.
- Cảnh payout nhỏ: dùng ô kết quả đủ 6 decimals; không dùng số dư tổng làm tròn 2 chữ số làm bằng chứng duy nhất.
- Snapshot trước/sau phải cùng một deposit ID, cùng Core, cùng mạng. So APR/maturity và principal, không so hai sổ khác nhau.
- Footage chuẩn bị hoặc quay bù phải có nhãn khi thứ tự dựng khác thứ tự thực hiện. Không dùng tx cũ để minh họa một giao dịch mới mà không chú thích.

### 4.2. Reset màn hình trước mỗi take

1. Kiểm tra cửa sổ, URL, network badge, tài khoản và contract. Đóng dialog cũ; chờ mọi tx trước đó kết thúc.
2. Refresh portfolio/plan, xác nhận ID trong phiếu; cuộn đến đúng card/form và đóng notification không liên quan.
3. Bắt đầu ghi, giữ 2 giây trước thao tác và 2 giây sau kết quả để dễ dựng.
4. Một giao dịch thành công không thể hoàn tác bằng reload: W/E đã rút và M đã renew không dùng lại. Nếu quay lại, mở sổ mới, ghi ID mới và chụp lại snapshot; plan đã đổi APR phải được chuẩn bị lại đúng 2% trước khi mở sổ demo mới.
5. Muốn reset toàn bộ local: Ctrl+C terminal B, chạy lại `demo:local`, reset activity/nonce cache local trong ví nếu cần, rồi chuẩn bị lại ID. Không restart local giữa cảnh 7 và 8 vì sẽ mất toàn bộ state đang quay.

### 4.3. Checklist trước và sau ghi hình

- [ ] Hai profile ví tách riêng; không để lộ thông tin khôi phục.
- [ ] Sepolia registry đúng Core/Vault mới; user đủ ETH và MockUSDC.
- [ ] P_PREP, E, M đã chuẩn bị; allowance cho cảnh hai bước đúng dự kiến.
- [ ] Local stack chạy ổn, L_AUTO/L_PAUSE còn Active, ID đã ghi.
- [ ] Cảnh 1: variant và kiến trúc đúng.
- [ ] Cảnh 2: plan P_LIVE 5 giây, APR 2%, tx thành công.
- [ ] Cảnh 3: approve/open riêng, W nhận 1000.000003; có footage S_SNAPSHOT.
- [ ] Cảnh 4: E nhận 965, phí 35, status Withdrawn.
- [ ] Cảnh 5: M successor có 1000.000003, tenor 360 ngày, APR 5%.
- [ ] Cảnh 6: snapshot không đổi, disable/enable, fund 100/withdraw 50.
- [ ] Cảnh 7: thấy nhãn LOCAL, helper chỉ local, auto successor và lineage đúng.
- [ ] Cảnh 8: pause chặn, unpause phục hồi; chỉ rõ kết quả test lịch sử.
- [ ] Xuất MP4 1080p, tổng 4:50 và không quá 5:00; nghe lại tiếng và đọc thử các số.

## 5. Xử lý sự cố khi quay

| Hiện tượng | Cách xử lý |
| --- | --- |
| Không hiện user mới sau đổi tài khoản | Trong MetaMask cấp quyền account cho đúng site; kiểm tra địa chỉ ở header, refresh trang sau khi tx đang chạy kết thúc. Hai origin 5173/5174 có quyền kết nối riêng. |
| Nút mở sổ ở Step 2 ngay từ đầu | Allowance đủ; có thể quay và giải thích được bỏ qua approve. Muốn đúng kịch bản hai bước, chuẩn bị user allowance 0 trước take, không bấm approve giả. |
| Tx pending lâu | Dừng take, xem activity/receipt trên explorer, chờ hoặc dùng chức năng speed up của ví nếu phù hợp; không gửi lại cùng thao tác khi chưa rõ tx cũ. Tiếp tục từ receipt thật. |
| Hết ETH gas | Nạp ETH Sepolia từ nguồn testnet của người quay; local dùng account fixture. Không dùng MockUSDC để trả gas. |
| Không đủ MockUSDC | User dùng `+ Mint 1,000 USDC`; admin dùng `+ Mint 5,000 test USDC`, ký rồi kiểm tra balance. |
| Sổ 5 giây đã mature khi vừa xuất hiện | Bình thường do thời gian mined/UI; dùng timestamp và rút đáo hạn. Không sửa maturity hoặc dùng sổ này để rút sớm. |
| Chưa hiện nút rút đáo hạn | Chờ block thật trên Sepolia rồi `Refresh Portfolio`; không chỉ đổi đồng hồ máy. Local dùng helper cho đúng ID. |
| Vault không đủ lãi | Admin fund thêm bằng UI, chờ confirmed rồi user thử lại. Settlement thiếu lãi phải revert theo thiết kế hiện tại; không có principal-only fallback. |
| Sai mạng/địa chỉ hoặc sổ biến mất | Kiểm tra profile, origin, chain, registry và Core chứa sổ. Sổ cũ không nằm trên Core mới; không redeploy để tìm lại sổ. |
| Kết quả UI cũ | Dùng `Refresh Portfolio`, chuyển lại tab hoặc reload sau khi receipt thành công; xác nhận cùng account và ID. |
| Local cổng 18545/5174 bận | Dừng đúng stack demo cũ rồi khởi động lại; harness không dùng lại service đang chiếm cổng. Không tùy ý tắt process chưa xác định. |
| Nonce local sai sau restart | Reset activity/nonce cache cho mạng local theo phiên bản MetaMask, kết nối lại; không xóa activity Sepolia để xử lý lỗi local. |
| Không kịp đủ cảnh trong 5 phút | Thu hình dài rồi dựng montage ký/pending, giữ hành động và kết quả thật. Không tăng tốc lời thoại; đưa phần mở rộng dưới đây ra video phụ. |

## 6. Nội dung tùy chọn ngoài video chính

### NFT transfer và quyền owner mới

UI hiện không có nút chuyển NFT; không viết hoặc nói rằng đã chuyển bằng UI của ứng dụng. Nếu quay thêm, chuẩn bị một sổ riêng và dùng ví/công cụ ERC721 hỗ trợ `transferFrom`/`safeTransferFrom` trên đúng Core. Owner hiện tại ký, chuyển certificate sang ví Bob riêng; refresh để Alice không còn thấy sổ và Bob thấy/rút được. Ghi receipt transfer, token ID và owner mới. Tài khoản Hardhat Bob #3 chỉ dùng local. Không dùng lại sổ W/E/M đã terminal để chứng minh quyền rút.

### Bảy Design Answers

Mở [README](../README.md), phần `Design Answers`, quay thêm 20–30 giây cho mỗi câu nếu cần video giải trình riêng:

1. NFT chuyển nhượng: ai đang là owner thì có quyền settlement theo kiểm tra trong Core.
2. Vault rỗng: thiết kế hiện tại revert toàn settlement; giải thích hạn chế và phương án khác chỉ là đề xuất.
3. Bot ngừng hoạt động: không tự có giao dịch; cần caller khi đủ điều kiện, không giả định có scheduler production.
4. Rounding: integer division làm tròn xuống; phần lãi dưới đơn vị token không được chi ra khỏi Vault.
5. Boundary: đối chiếu toán tử trong source với maturity/grace, không suy luận chỉ từ nhãn UI.
6. Disabled plan: sổ đang mở giữ terms; không chọn disabled plan làm target cho mở mới/manual renew.
7. Tấn công: chỉ vào cơ chế kiểm soát owner/status/reentrancy và test tương ứng trong README.

## 7. Nguồn đối chiếu và phạm vi tài liệu

- Yêu cầu: `Final_Assignment.docx`, đặc biệt frontend demo, Personal Variant, quy tắc snapshot, và video 3–5 phút.
- Source UI: các component AdminPlansManager/AdminVaultCard/AdminSystemCard, DepositForm, WithdrawDialog, ManualRenewDialog, AutoRenewDialog và portfolio.
- Lệnh local: `scripts/e2e/local-stack.mjs`, `scripts/e2e/advance-time.mjs`; helper grace chỉ chấp nhận RPC 18545, chain 31337, deposit Active.
- Deployment: [manifest Sepolia](../deployments/sepolia.json), [bằng chứng redeploy](evidence/sepolia-redeploy-2026-10-29.json).
- Kiểm thử/thiết kế: [D5-03](D5-03.md), [bằng chứng 10 E2E](evidence/D5-03-e2e.json), [README](../README.md). D5-02 là báo cáo lịch sử trước cập nhật source, không lấy số test cũ làm số hiện tại.

File này chỉ hướng dẫn ghi hình. Việc viết tài liệu không tạo thêm plan, gửi giao dịch, thay đổi deployment hoặc quay video thay người thực hiện.
