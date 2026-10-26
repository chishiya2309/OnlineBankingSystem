// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVaultManager} from "../interfaces/IVaultManager.sol";

/// @notice Test-only Core caller for isolated smoke/unit fixtures; never deploy as production Core.
/// @dev Only the fixture operator can request interest. Received tokens remain in this mock.
contract VaultCallerMock is Ownable {
    IVaultManager public immutable vault;

    constructor(IVaultManager vault_, address operator_) Ownable(operator_) {
        vault = vault_;
    }

    /// @notice Requests interest from the fixed fixture Vault, always paid to this mock.
    function requestInterest(uint256 amount) external onlyOwner {
        vault.payInterest(amount);
    }
}
