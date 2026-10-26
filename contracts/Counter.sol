// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

contract Counter {
    uint256 public x;

    function inc() external {
        x += 1;
    }
}
