import { describe, it, expect, vi } from "vitest";
import { DepositStatus } from "../types";
import { fetchUserPortfolio } from "../lib/portfolio";

describe("Portfolio Discovery & Accounting Tests (PF-001 to PF-008)", () => {
  const aliceAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const bobAddress = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  const mockProvider = {
    getBlock: vi.fn().mockResolvedValue({
      timestamp: 1700000000,
      number: 100,
    }),
  } as any;

  it("PF-001: returns clean empty portfolio when wallet is not connected", async () => {
    const result = await fetchUserPortfolio(null, null, mockProvider);
    expect(result.activeDeposits).toHaveLength(0);
    expect(result.historicalDeposits).toHaveLength(0);
    expect(result.summary.activeCount).toBe(0);
    expect(result.summary.totalActivePrincipal).toBe(0n);
    expect(result.summary.totalActivePrincipalFormatted).toBe("0.00");
  });

  it("PF-002: filters deposits strictly by current ownerOf(id) matching connected wallet", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(3n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: {
        Renewed: vi.fn().mockReturnValue({}),
      },
      queryFilter: vi.fn().mockResolvedValue([]),
      ownerOf: vi.fn().mockImplementation((id: number) => {
        if (id === 1) return Promise.resolve(aliceAddress);
        if (id === 2) return Promise.resolve(bobAddress);
        if (id === 3) return Promise.resolve(aliceAddress);
        return Promise.reject(new Error("TokenDoesNotExist"));
      }),
      getDeposit: vi.fn().mockImplementation((_id: number) => {
        return Promise.resolve({
          planId: 1n,
          principal: 500000000n, // 500 USDC
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(DepositStatus.Active),
        });
      }),
    } as any;

    const alicePortfolio = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    expect(alicePortfolio.activeDeposits).toHaveLength(2);
    expect(alicePortfolio.activeDeposits.map((d) => d.depositId)).toEqual([3, 1]); // sorted descending
    expect(alicePortfolio.summary.activeCount).toBe(2);
    expect(alicePortfolio.summary.totalActivePrincipal).toBe(1000000000n); // 1,000 USDC
  });

  it("PF-003: dynamically updates portfolio upon NFT transfer from Alice to Bob", async () => {
    // Before transfer: Deposit #1 owned by Alice
    let deposit1Owner = aliceAddress;

    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(1n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
      ownerOf: vi.fn().mockImplementation(() => Promise.resolve(deposit1Owner)),
      getDeposit: vi.fn().mockResolvedValue({
        planId: 1n,
        principal: 500000000n,
        startAt: 1690000000n,
        maturityAt: 1705000000n,
        aprBpsAtOpen: 200,
        penaltyBpsAtOpen: 350,
        status: BigInt(DepositStatus.Active),
      }),
    } as any;

    const aliceBefore = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    const bobBefore = await fetchUserPortfolio(mockSavingCore, bobAddress, mockProvider);
    expect(aliceBefore.activeDeposits).toHaveLength(1);
    expect(bobBefore.activeDeposits).toHaveLength(0);

    // Simulate ERC721 safeTransferFrom(alice, bob, 1)
    deposit1Owner = bobAddress;

    const aliceAfter = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    const bobAfter = await fetchUserPortfolio(mockSavingCore, bobAddress, mockProvider);
    expect(aliceAfter.activeDeposits).toHaveLength(0);
    expect(bobAfter.activeDeposits).toHaveLength(1);
    expect(bobAfter.activeDeposits[0].depositId).toBe(1);
  });

  it("PF-004: accurately partitions Active and Historical certificates (Withdrawn, ManualRenewed, AutoRenewed)", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(4n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        const statuses = [
          DepositStatus.Active, // #1
          DepositStatus.Withdrawn, // #2
          DepositStatus.ManualRenewed, // #3
          DepositStatus.AutoRenewed, // #4
        ];
        return Promise.resolve({
          planId: 1n,
          principal: 100000000n * BigInt(id),
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(statuses[id - 1]),
        });
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    expect(result.activeDeposits).toHaveLength(1);
    expect(result.activeDeposits[0].depositId).toBe(1);
    expect(result.historicalDeposits).toHaveLength(3);
    expect(result.historicalDeposits.map((d) => d.depositId)).toEqual([4, 3, 2]);
  });

  it("PF-005: total Active Principal strictly sums active deposits, excluding terminal records", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        if (id === 1) {
          return Promise.resolve({
            planId: 1n,
            principal: 1000000000n, // 1,000 USDC Active
            startAt: 1690000000n,
            maturityAt: 1705000000n,
            aprBpsAtOpen: 200,
            penaltyBpsAtOpen: 350,
            status: BigInt(DepositStatus.Active),
          });
        }
        return Promise.resolve({
          planId: 1n,
          principal: 2000000000n, // 2,000 USDC Withdrawn
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(DepositStatus.Withdrawn),
        });
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    expect(result.summary.totalActivePrincipal).toBe(1000000000n);
    expect(result.summary.totalActivePrincipalFormatted).toBe("1,000.00");
  });

  it("PF-006: builds renewal lineage from historical Renewed events", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([
        {
          args: {
            oldDepositId: 1n,
            newDepositId: 2n,
            newPrincipal: 1010000000n,
            newPlanId: 2n,
          },
        },
      ]),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        return Promise.resolve({
          planId: id === 1 ? 1n : 2n,
          principal: id === 1 ? 1000000000n : 1010000000n,
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(id === 1 ? DepositStatus.ManualRenewed : DepositStatus.Active),
        });
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    const oldDeposit = result.historicalDeposits.find((d) => d.depositId === 1);
    const newDeposit = result.activeDeposits.find((d) => d.depositId === 2);

    expect(oldDeposit?.renewedToDepositId).toBe(2);
    expect(oldDeposit?.successorSummary?.depositId).toBe(2);
    expect(oldDeposit?.successorSummary?.status).toBe(DepositStatus.Active);
    expect(newDeposit?.renewedFromDepositId).toBe(1);
    expect(newDeposit?.renewalType).toBe("manual");
    expect(newDeposit?.predecessorSummary?.depositId).toBe(1);
    expect(newDeposit?.predecessorSummary?.status).toBe(DepositStatus.ManualRenewed);
  });

  it("PF-006b: distinguishes auto-renewed successor from manual-renewed successor", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([
        {
          args: {
            oldDepositId: 1n,
            newDepositId: 2n,
            newPrincipal: 1010000000n,
            newPlanId: 1n,
          },
        },
      ]),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        return Promise.resolve({
          planId: 1n,
          principal: id === 1 ? 1000000000n : 1010000000n,
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(id === 1 ? DepositStatus.AutoRenewed : DepositStatus.Active),
        });
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    const oldDeposit = result.historicalDeposits.find((d) => d.depositId === 1);
    const newDeposit = result.activeDeposits.find((d) => d.depositId === 2);

    expect(oldDeposit?.status).toBe(DepositStatus.AutoRenewed);
    expect(newDeposit?.renewedFromDepositId).toBe(1);
    expect(newDeposit?.renewalType).toBe("auto");
    expect(newDeposit?.predecessorSummary?.depositId).toBe(1);
    expect(newDeposit?.predecessorSummary?.status).toBe(DepositStatus.AutoRenewed);
  });

  it("PF-006c: queries logs in bounded chunks when provider supports getNetwork and getBlockNumber", async () => {
    const chunkProvider = {
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000, number: 12042730 }),
      getNetwork: vi.fn().mockResolvedValue({ chainId: 11155111n }),
      getBlockNumber: vi.fn().mockResolvedValue(12042730),
    } as any;

    const queryFilterSpy = vi.fn().mockResolvedValue([
      {
        args: {
          oldDepositId: 3n,
          newDepositId: 4n,
          newPrincipal: 1009860000n,
          newPlanId: 2n,
        },
        blockNumber: 12035000,
      },
    ]);

    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(4n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: queryFilterSpy,
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        return Promise.resolve({
          planId: id === 3 ? 1n : 2n,
          principal: id === 3 ? 1000000000n : 1009860000n,
          startAt: 1690000000n,
          maturityAt: 1705000000n,
          aprBpsAtOpen: 200,
          penaltyBpsAtOpen: 350,
          status: BigInt(id === 3 ? DepositStatus.ManualRenewed : DepositStatus.Active),
        });
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, chunkProvider);
    // Sepolia deployedBlock is 12032730, blockNumber is 12042730 (range 10,000 blocks -> chunked into 3 chunks of 5000)
    expect(queryFilterSpy).toHaveBeenCalled();
    const activeDep = result.activeDeposits.find((d) => d.depositId === 4);
    expect(activeDep?.renewedFromDepositId).toBe(3);
    expect(activeDep?.renewalType).toBe("manual");
  });

  it("PF-007: includes renewal lineage when the cached block number lags the latest block", async () => {
    window.localStorage.clear();
    const provider = {
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000, number: 105 }),
      getBlockNumber: vi.fn().mockResolvedValue(104),
      getNetwork: vi.fn().mockResolvedValue({ chainId: 31337n }),
    } as any;
    const core = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockImplementation((_filter, _from, to) => Promise.resolve(to >= 105 ? [{ args: { oldDepositId: 1n, newDepositId: 2n }, blockNumber: 105 }] : [])),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => Promise.resolve({
        planId: 1n, principal: 1000000000n, startAt: 1690000000n, maturityAt: 1705000000n,
        aprBpsAtOpen: 200, penaltyBpsAtOpen: 350,
        status: BigInt(id === 1 ? DepositStatus.ManualRenewed : DepositStatus.Active),
      })),
    } as any;
    const result = await fetchUserPortfolio(core, aliceAddress, provider);
    expect(result.activeDeposits[0].renewedFromDepositId).toBe(1);
    expect(result.historicalDeposits[0].renewedToDepositId).toBe(2);
    window.localStorage.clear();
  });

  it("PF-008: handles RPC partial query errors gracefully without dropping existing records", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockRejectedValue(new Error("RPC timeout")), // event query fails
      ownerOf: vi.fn().mockImplementation((id: number) => {
        if (id === 1) return Promise.resolve(aliceAddress);
        return Promise.reject(new Error("Token does not exist"));
      }),
      getDeposit: vi.fn().mockResolvedValue({
        planId: 1n,
        principal: 500000000n,
        startAt: 1690000000n,
        maturityAt: 1705000000n,
        aprBpsAtOpen: 200,
        penaltyBpsAtOpen: 350,
        status: BigInt(DepositStatus.Active),
      }),
    } as any;

    // Even if Renewed event log query throws, token discovery still works cleanly
    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    expect(result.activeDeposits).toHaveLength(1);
    expect(result.activeDeposits[0].depositId).toBe(1);
  });

  it("PF-009: handles per-deposit RPC getDeposit errors gracefully without dropping other deposits", async () => {
    const mockSavingCore = {
      depositCount: vi.fn().mockResolvedValue(2n),
      gracePeriodSeconds: vi.fn().mockResolvedValue(172800n),
      filters: { Renewed: vi.fn().mockReturnValue({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
      ownerOf: vi.fn().mockResolvedValue(aliceAddress),
      getDeposit: vi.fn().mockImplementation((id: number) => {
        if (id === 1) {
          return Promise.resolve({
            planId: 1n,
            principal: 500000000n,
            startAt: 1690000000n,
            maturityAt: 1705000000n,
            aprBpsAtOpen: 200,
            penaltyBpsAtOpen: 350,
            status: BigInt(DepositStatus.Active),
          });
        }
        return Promise.reject(new Error("RPC rate limit on deposit #2"));
      }),
    } as any;

    const result = await fetchUserPortfolio(mockSavingCore, aliceAddress, mockProvider);
    expect(result.activeDeposits).toHaveLength(1);
    expect(result.activeDeposits[0].depositId).toBe(1);
  });
});
