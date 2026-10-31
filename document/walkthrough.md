# Báo cáo Nghiệm thu & Kiểm chứng — Soulbound Terminal Certificate

## 1. Yêu cầu Mới & Động lực Thực hiện

Người dùng yêu cầu bổ sung quy tắc nghiệp vụ đối với chứng chỉ NFT lịch sử:
- **Ngữ cảnh**: Sau khi khoản gửi đã được tất toán (`Withdrawn`) hoặc đã tái tục (`ManualRenewed`, `AutoRenewed`), chứng chỉ NFT cũ vẫn được giữ lại trong ví người dùng làm minh chứng lịch sử (historical proof / Certificate History).
- **Vấn đề trước đây**: Do kế thừa OpenZeppelin ERC721 tiêu chuẩn, người dùng vẫn có thể bấm gửi (transfer) NFT đã tất toán này sang ví khác trên MetaMask. Dù người nhận mới không thể rút tiền lần hai, việc chuyển nhượng này gây rủi ro nhầm lẫn hoặc lừa đảo chuyển sổ tiết kiệm đã rút.
- **Yêu cầu cập nhật**: Biến NFT đã tất toán thành **Soulbound Token (chứng chỉ dính chặt với chủ sở hữu)**:
  - Khi khoản gửi đang `Active`: Cho phép chuyển nhượng tự do (chuyển quyền rút tiền sang chủ mới).
  - Khi khoản gửi chuyển sang trạng thái terminal (`Withdrawn`, `ManualRenewed`, `AutoRenewed`): **Khóa cứng vĩnh viễn, cấm mọi hành vi chuyển nhượng (`transferFrom`, `safeTransferFrom`) sang ví khác**. NFT bắt buộc phải ở lại ví của người đã tất toán/tái tục làm minh chứng.

---

## 2. Chi tiết Thay đổi Mã nguồn (Changes Made)

### 2.1. Hợp đồng Thông minh ([SavingCore.sol](file:///d:/AppsCycloneIntern/OnlineBankingSystem/contracts/SavingCore.sol))

1. **Thêm Custom Error**:
   ```solidity
   error TerminalCertificateNonTransferable(uint256 depositId, DepositStatus currentStatus);
   ```

2. **Override hàm `_update` của ERC721**:
   ```solidity
   /// @dev Overrides ERC721 _update to enforce that certificates with terminal statuses
   /// (Withdrawn, ManualRenewed, AutoRenewed) are non-transferable (soulbound historical certificates).
   function _update(address to, uint256 tokenId, address auth)
       internal
       virtual
       override
       returns (address)
   {
       address from = super._update(to, tokenId, auth);
       if (from != address(0) && to != address(0)) {
           DepositStatus status = _deposits[tokenId].status;
           if (status != DepositStatus.Active) {
               revert TerminalCertificateNonTransferable(tokenId, status);
           }
       }
       return from;
   }
   ```
   - Khi đúc (`_safeMint`): `from == address(0)` $\to$ Hợp lệ.
   - Khi chuyển nhượng khoản gửi `Active`: `status == DepositStatus.Active` $\to$ Hợp lệ.
   - Khi chuyển nhượng khoản gửi đã tất toán/tái tục: `status != DepositStatus.Active` $\to$ **REVERT ngay lập tức với `TerminalCertificateNonTransferable(tokenId, status)`**.

### 2.2. Frontend Error Decoder ([frontend/src/lib/errors.ts](file:///d:/AppsCycloneIntern/OnlineBankingSystem/frontend/src/lib/errors.ts))

Bổ sung thông điệp lỗi rõ ràng cho người dùng Web3 khi cố chuyển NFT đã tất toán:
```typescript
if (lowerMsg.includes("terminalcertificatenontransferable")) {
  return "This deposit certificate has already been settled (withdrawn or renewed) and cannot be transferred.";
}
```

### 2.3. Cập nhật & Bổ sung Test Cases ([test/SavingCoreHardening.ts](file:///d:/AppsCycloneIntern/OnlineBankingSystem/test/SavingCoreHardening.ts))

Cập nhật `OWN-010` và bổ sung `OWN-010b`:
- **`OWN-010`**: Sau khi rút đáo hạn (`Withdrawn`), Alice cố gọi `transferFrom` hoặc `safeTransferFrom` để gửi NFT #1 sang Bob $\to$ **REVERT `TerminalCertificateNonTransferable(1n, 1)`**. Token #1 vẫn thuộc về Alice (`ownerOf(1) == alice`).
- **`OWN-010b`**: Sau khi tái tục thủ công (`ManualRenewed`), Alice cố chuyển NFT cũ #1 $\to$ **REVERT `TerminalCertificateNonTransferable(1n, 2)`**. Ngược lại, NFT kế thừa mới #2 đang `Active` thì **chuyển nhượng sang Bob thành công**.

### 2.4. Xuất bản Artifacts & ABIs

Chạy script `npm run export-contracts` để cập nhật ABI mới vào:
- `exports/contracts/SavingCore.json`
- `frontend/src/contracts/SavingCore.json`

---

## 3. Kết quả Kiểm chứng Thực tế (Validation Results)

| Hạng mục kiểm thử | Lệnh thực thi | Kết quả | Trạng thái |
|---|---|:---:|:---:|
| **Solidity Compilation** | `npm.cmd run compile` | 2 Solidity files compiled cleanly (evm target: osaka) | **PASS** |
| **TypeScript Typecheck (Root)** | `npm.cmd run typecheck` | 0 errors | **PASS** |
| **TypeScript Typecheck (Frontend)** | `npm.cmd --prefix frontend run typecheck` | 0 errors | **PASS** |
| **Smart Contract Regression Suite** | `npm.cmd test` | **536 / 536 tests passing** (18s) | **PASS (100%)** |
| **Frontend Unit & Component Tests** | `npm.cmd --prefix frontend test` | **76 / 76 tests passing** (29s) | **PASS (100%)** |
| **Test chuyên biệt OWN-010 & OWN-010b** | `npx hardhat test test/SavingCoreHardening.ts --grep OWN-010` | 2 passing | **PASS** |

---

## 4. Hành vi Trải nghiệm Người dùng trên MetaMask Sau Khi Cập Nhật

1. **Khoản gửi đang Active**:
   - Người dùng vẫn có thể dùng MetaMask gửi NFT sang địa chỉ ví khác. Người nhận mới có toàn quyền rút tiền hoặc tái tục.
2. **Khoản gửi đã Rút tiền hoặc Tái tục (Withdrawn / Renewed)**:
   - NFT vẫn hiển thị trong tab NFT của ví MetaMask và tab **Certificate History** trên web UI làm minh chứng lịch sử.
   - Nếu người dùng bấm **Send** trên MetaMask sang một địa chỉ khác:
     - Giao dịch mô phỏng / thực thi sẽ **revert ngay lập tức**.
     - MetaMask báo lỗi giao dịch thất bại và **không thể chuyển đi**.
     - Sổ tiết kiệm lịch sử vĩnh viễn dính chặt (Soulbound) với tài khoản của người đã tất toán/tái tục.
