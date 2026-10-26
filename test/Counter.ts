import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Counter", function () {
  it("starts at zero", async function () {
    const counter = await ethers.deployContract("Counter");
    await counter.waitForDeployment();

    expect(await counter.x()).to.equal(0n);
  });

  it("increments after a successful transaction", async function () {
    const counter = await ethers.deployContract("Counter");
    await counter.waitForDeployment();

    const transaction = await counter.inc();
    const receipt = await transaction.wait();

    expect(receipt?.status).to.equal(1);
    expect(await counter.x()).to.equal(1n);
  });
});
