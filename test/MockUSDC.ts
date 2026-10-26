import { expect } from "chai";
import { network } from "hardhat";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;
const units = (amount: string): bigint => ethers.parseUnits(amount, 6);

async function deployTokenFixture() {
  const [deployer, alice, bob, stranger] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  return { token, deployer, alice, bob, stranger };
}

async function fundedTokenFixture() {
  const f = await deployTokenFixture();
  await (await f.token.mint(f.alice.address, units("1000"))).wait();
  return f;
}

describe("MockUSDC", function () {
  after(async function () { await connection.close(); });

  describe("Deployment and metadata", function () {
    it("MUSDC-001: has the configured name", async function () {
      const { token } = await networkHelpers.loadFixture(deployTokenFixture);
      expect(await token.name()).to.equal("MockUSDC");
    });

    it("MUSDC-002: has the configured symbol", async function () {
      const { token } = await networkHelpers.loadFixture(deployTokenFixture);
      expect(await token.symbol()).to.equal("mUSDC");
    });

    it("MUSDC-003: uses six decimals", async function () {
      const { token } = await networkHelpers.loadFixture(deployTokenFixture);
      expect(await token.decimals()).to.equal(6n);
    });

    it("MUSDC-004: starts without supply or user balances", async function () {
      const { token, deployer, alice } = await networkHelpers.loadFixture(deployTokenFixture);
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.balanceOf(deployer.address)).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("Minting", function () {
    it("MUSDC-005: mints exactly 1000000000 units for 1000 tokens", async function () {
      const { token, alice } = await networkHelpers.loadFixture(deployTokenFixture);
      const amount = units("1000");
      expect(amount).to.equal(1_000_000_000n);
      await expect(token.mint(alice.address, amount)).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, amount);
      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await token.totalSupply()).to.equal(amount);
    });

    it("MUSDC-006: accumulates repeated mints across recipients", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      await expect(token.mint(alice.address, units("75"))).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, units("75"));
      await expect(token.mint(bob.address, units("25"))).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, bob.address, units("25"));
      expect(await token.balanceOf(alice.address)).to.equal(units("1075"));
      expect(await token.balanceOf(bob.address)).to.equal(units("25"));
      expect(await token.totalSupply()).to.equal(units("1100"));
    });

    it("MUSDC-007: permits a non-deployer to mint to another address", async function () {
      const { token, deployer, stranger, alice } = await networkHelpers.loadFixture(deployTokenFixture);
      expect(stranger.address).not.to.equal(deployer.address);
      await expect(token.connect(stranger).mint(alice.address, units("1"))).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, units("1"));
      expect(await token.balanceOf(alice.address)).to.equal(units("1"));
      expect(await token.balanceOf(stranger.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(units("1"));
    });

    it("MUSDC-008: rejects a zero recipient without changing supply", async function () {
      const { token, alice } = await networkHelpers.loadFixture(fundedTokenFixture);
      await expect(token.mint(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(token, "ERC20InvalidReceiver").withArgs(ethers.ZeroAddress);
      expect(await token.totalSupply()).to.equal(units("1000"));
      expect(await token.balanceOf(alice.address)).to.equal(units("1000"));
      expect(await token.balanceOf(ethers.ZeroAddress)).to.equal(0n);
    });

    it("MUSDC-009: allows zero mint and emits the standard zero Transfer", async function () {
      const { token, alice } = await networkHelpers.loadFixture(deployTokenFixture);
      await expect(token.mint(alice.address, 0n)).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, 0n);
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it("MUSDC-015: treats 1n as one smallest unit without scaling", async function () {
      const { token, alice } = await networkHelpers.loadFixture(deployTokenFixture);
      await expect(token.mint(alice.address, 1n)).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, 1n);
      expect(await token.balanceOf(alice.address)).to.equal(1n);
      expect(await token.totalSupply()).to.equal(1n);
    });
  });

  describe("ERC20 transfers and allowances", function () {
    it("MUSDC-010: transfers the exact amount without changing supply", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      await expect(token.connect(alice).transfer(bob.address, units("25"))).to.emit(token, "Transfer").withArgs(alice.address, bob.address, units("25"));
      expect(await token.balanceOf(alice.address)).to.equal(units("975"));
      expect(await token.balanceOf(bob.address)).to.equal(units("25"));
      expect(await token.totalSupply()).to.equal(units("1000"));
    });

    it("MUSDC-011: approves a spender without transferring funds", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      await expect(token.connect(alice).approve(bob.address, units("100"))).to.emit(token, "Approval").withArgs(alice.address, bob.address, units("100"));
      expect(await token.allowance(alice.address, bob.address)).to.equal(units("100"));
      expect(await token.balanceOf(alice.address)).to.equal(units("1000"));
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });

    it("MUSDC-012: transferFrom updates both balances and remaining allowance", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      await (await token.connect(alice).approve(bob.address, units("100"))).wait();
      await expect(token.connect(bob).transferFrom(alice.address, bob.address, units("25"))).to.emit(token, "Transfer").withArgs(alice.address, bob.address, units("25"));
      expect(await token.balanceOf(alice.address)).to.equal(units("975"));
      expect(await token.balanceOf(bob.address)).to.equal(units("25"));
      expect(await token.allowance(alice.address, bob.address)).to.equal(units("75"));
      expect(await token.totalSupply()).to.equal(units("1000"));
    });

    it("MUSDC-013: rejects a transfer exceeding balance by one unit", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      const balance = units("1000");
      await expect(token.connect(alice).transfer(bob.address, balance + 1n)).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance").withArgs(alice.address, balance, balance + 1n);
      expect(await token.balanceOf(alice.address)).to.equal(balance);
      expect(await token.balanceOf(bob.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(balance);
    });

    it("MUSDC-014: rejects insufficient allowance and preserves the ledger", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedTokenFixture);
      const amount = units("25");
      await (await token.connect(alice).approve(bob.address, amount - 1n)).wait();
      await expect(token.connect(bob).transferFrom(alice.address, bob.address, amount)).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance").withArgs(bob.address, amount - 1n, amount);
      expect(await token.balanceOf(alice.address)).to.equal(units("1000"));
      expect(await token.balanceOf(bob.address)).to.equal(0n);
      expect(await token.allowance(alice.address, bob.address)).to.equal(amount - 1n);
      expect(await token.totalSupply()).to.equal(units("1000"));
    });
  });
});
