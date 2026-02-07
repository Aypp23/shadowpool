import { describe, it, expect, vi } from "vitest";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { encodeHookPayload, getRoundIntentsWithOptions, startNagle } from "@/services/shadowPool";
import { useStore } from "@/stores/useStore";

describe("example", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});

describe("ShadowPool hook payload encoding", () => {
  it("round-trips hook payload ABI encoding", () => {
    const roundId = `0x${"11".repeat(32)}` as const;
    const matchIdHash = `0x${"22".repeat(32)}` as const;
    const trader = `0x${"33".repeat(20)}` as const;
    const counterparty = `0x${"44".repeat(20)}` as const;
    const tokenIn = `0x${"55".repeat(20)}` as const;
    const tokenOut = `0x${"66".repeat(20)}` as const;
    const merkleProof = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`] as const;
    const signature = `0x${"99".repeat(65)}` as const;

    const payload = {
      roundId,
      matchIdHash,
      trader,
      counterparty,
      tokenIn,
      tokenOut,
      amountIn: 123n,
      minAmountOut: 456n,
      expiry: 789n,
      merkleProof: [...merkleProof],
      signature,
    } as const;

    const encodedViaService = encodeHookPayload({
      ...payload,
      merkleProof: [...payload.merkleProof],
    });
    const encodedViaAbi = encodeAbiParameters(
      [
        {
          name: "payload",
          type: "tuple",
          components: [
            { name: "roundId", type: "bytes32" },
            { name: "matchIdHash", type: "bytes32" },
            { name: "trader", type: "address" },
            { name: "counterparty", type: "address" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "minAmountOut", type: "uint256" },
            { name: "expiry", type: "uint256" },
            { name: "proof", type: "bytes32[]" },
            { name: "signature", type: "bytes" },
          ],
        },
      ],
      [
        {
          ...payload,
          proof: payload.merkleProof,
        } as unknown as {
          roundId: `0x${string}`;
          matchIdHash: `0x${string}`;
          trader: `0x${string}`;
          counterparty: `0x${string}`;
          tokenIn: `0x${string}`;
          tokenOut: `0x${string}`;
          amountIn: bigint;
          minAmountOut: bigint;
          expiry: bigint;
          proof: readonly `0x${string}`[];
          signature: `0x${string}`;
        },
      ]
    );

    expect(encodedViaService).toBe(encodedViaAbi);

    const decoded = decodeAbiParameters(
      [
        {
          name: "payload",
          type: "tuple",
          components: [
            { name: "roundId", type: "bytes32" },
            { name: "matchIdHash", type: "bytes32" },
            { name: "trader", type: "address" },
            { name: "counterparty", type: "address" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "minAmountOut", type: "uint256" },
            { name: "expiry", type: "uint256" },
            { name: "proof", type: "bytes32[]" },
            { name: "signature", type: "bytes" },
          ],
        },
      ],
      encodedViaService
    )[0] as unknown as {
      roundId: `0x${string}`;
      matchIdHash: `0x${string}`;
      trader: `0x${string}`;
      counterparty: `0x${string}`;
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      amountIn: bigint;
      minAmountOut: bigint;
      expiry: bigint;
      proof: readonly `0x${string}`[];
      signature: `0x${string}`;
    };

    expect(decoded.roundId.toLowerCase()).toBe(payload.roundId.toLowerCase());
    expect(decoded.matchIdHash.toLowerCase()).toBe(payload.matchIdHash.toLowerCase());
    expect(decoded.trader.toLowerCase()).toBe(payload.trader.toLowerCase());
    expect(decoded.counterparty.toLowerCase()).toBe(payload.counterparty.toLowerCase());
    expect(decoded.tokenIn.toLowerCase()).toBe(payload.tokenIn.toLowerCase());
    expect(decoded.tokenOut.toLowerCase()).toBe(payload.tokenOut.toLowerCase());
    expect(decoded.amountIn).toBe(payload.amountIn);
    expect(decoded.minAmountOut).toBe(payload.minAmountOut);
    expect(decoded.expiry).toBe(payload.expiry);
    expect(decoded.proof.map((x) => x.toLowerCase())).toEqual(payload.merkleProof.map((x) => x.toLowerCase()));
    expect(decoded.signature.toLowerCase()).toBe(payload.signature.toLowerCase());
  });
});

describe("shadowpool store", () => {
  it("hydrates missing intent trader when wallet connects", () => {
    const address = `0x${"11".repeat(20)}` as const;

    useStore.setState({
      intents: [
        {
          id: "intent-1",
          side: "buy",
          tokenPair: {
            base: { symbol: "AAA", name: "Token A", address: `0x${"22".repeat(20)}`, decimals: 18 },
            quote: { symbol: "BBB", name: "Token B", address: `0x${"33".repeat(20)}`, decimals: 18 },
          },
          amount: "1",
          limitPrice: "1",
          expiry: new Date(),
          status: "submitted",
          createdAt: new Date(),
        },
      ],
      wallet: {
        connected: false,
        address: null,
        network: "Arbitrum Sepolia",
        balance: "0.00",
        voucherBalance: "0.00",
        isAdmin: false,
        sessionPaused: false,
      },
    });

    useStore.getState().setWallet({
      connected: true,
      address,
      network: "Arbitrum Sepolia",
      balance: "0.00",
      voucherBalance: "0.00",
      isAdmin: false,
      sessionPaused: false,
    });

    expect(useStore.getState().intents[0]?.trader).toBe(address);
  });
});

describe("nagle sync loop", () => {
  it("does not publish empty intents when round indicates nonzero count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const onRounds = vi.fn();
    const onRoundIntents = vi.fn();
    const onMetrics = vi.fn();

    const stop = startNagle({
      config: { tickMs: 50, roundsPollMs: 50, intentsPollMs: 50, intentsStaleMs: 50, retries: 0, lookbackRounds: 1, maxActiveRounds: 1 },
      fetchRounds: async () => [
        {
          id: "round-1",
          phase: "intake",
          intentsCount: 2,
          matchedCount: 0,
          startTime: new Date(),
          endTime: new Date(Date.now() + 60_000),
        },
      ],
      fetchRoundIntents: async () => [],
      onRounds,
      onRoundIntents,
      onMetrics,
    });

    await vi.advanceTimersByTimeAsync(200);
    stop();
    vi.useRealTimers();

    expect(onRounds).toHaveBeenCalled();
    expect(onRoundIntents).not.toHaveBeenCalled();
    expect(onMetrics).toHaveBeenCalled();
  });
});

describe("getRoundIntents event-log indexing", () => {
  it("returns intent registry events ordered by position", async () => {
    type PublicClient = NonNullable<NonNullable<Parameters<typeof getRoundIntentsWithOptions>[1]>["publicClient"]>;
    const publicClient = {
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        {
          args: {
            trader: `0x${"11".repeat(20)}`,
            protectedData: `0x${"22".repeat(20)}`,
            commitment: `0x${"aa".repeat(32)}`,
            position: 2n,
            intentId: `0x${"bb".repeat(32)}`,
            timestamp: 1_700_000_100n,
          },
        },
        {
          args: {
            trader: `0x${"33".repeat(20)}`,
            protectedData: `0x${"44".repeat(20)}`,
            commitment: `0x${"cc".repeat(32)}`,
            position: 1n,
            intentId: `0x${"dd".repeat(32)}`,
            timestamp: 1_700_000_000n,
          },
        },
      ]),
      readContract: vi.fn(async () => {
        throw new Error("readContract should not be called");
      }),
      multicall: vi.fn(async () => {
        throw new Error("multicall should not be called");
      }),
      getBlock: vi.fn(async () => {
        throw new Error("getBlock should not be called");
      }),
    } as unknown as PublicClient;

    const intents = await getRoundIntentsWithOptions("round-1", {
      intentRegistryAddress: `0x${"55".repeat(20)}`,
      rootRegistryAddress: null,
      publicClient,
      fromBlock: 0n,
      chunkSize: 10n,
    });

    expect(publicClient.getLogs).toHaveBeenCalled();
    const call = publicClient.getLogs.mock.calls[0]?.[0];
    expect(call?.args?.roundId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(intents.map((x) => x.position)).toEqual([1, 2]);
    expect(intents[0]?.timestamp).toBeInstanceOf(Date);
  });

  it("falls back to read-based fetching when logs are empty", async () => {
    type PublicClient = NonNullable<NonNullable<Parameters<typeof getRoundIntentsWithOptions>[1]>["publicClient"]>;
    const publicClient = {
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => []),
      readContract: vi.fn(async () => 2n),
      multicall: vi.fn(async () => [
        {
          status: "success",
          result: {
            trader: `0x${"11".repeat(20)}`,
            protectedData: `0x${"22".repeat(20)}`,
            commitment: `0x${"aa".repeat(32)}`,
            intentId: `0x${"bb".repeat(32)}`,
            timestamp: 1_700_000_000n,
          },
        },
        {
          status: "success",
          result: {
            trader: `0x${"33".repeat(20)}`,
            protectedData: `0x${"44".repeat(20)}`,
            commitment: `0x${"cc".repeat(32)}`,
            intentId: `0x${"dd".repeat(32)}`,
            timestamp: 1_700_000_100n,
          },
        },
      ]),
    } as unknown as PublicClient;

    const intents = await getRoundIntentsWithOptions("round-1", {
      intentRegistryAddress: `0x${"55".repeat(20)}`,
      rootRegistryAddress: null,
      publicClient,
      fromBlock: 0n,
      chunkSize: 10n,
    });

    expect(publicClient.getLogs).toHaveBeenCalled();
    expect(publicClient.readContract).toHaveBeenCalled();
    expect(publicClient.multicall).toHaveBeenCalled();
    expect(intents.map((x) => x.position)).toEqual([1, 2]);
  });

  it("returns root registry events ordered by position", async () => {
    type PublicClient = NonNullable<NonNullable<Parameters<typeof getRoundIntentsWithOptions>[1]>["publicClient"]>;
    const publicClient = {
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { args: { protectedData: `0x${"11".repeat(20)}`, position: 2n }, blockNumber: 120n },
        { args: { protectedData: `0x${"22".repeat(20)}`, position: 1n }, blockNumber: 100n },
      ]),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: blockNumber === 100n ? 1_700_000_000n : 1_700_000_100n,
      })),
      readContract: vi.fn(async () => {
        throw new Error("readContract should not be called");
      }),
      multicall: vi.fn(async () => {
        throw new Error("multicall should not be called");
      }),
    } as unknown as PublicClient;

    const intents = await getRoundIntentsWithOptions("round-1", {
      intentRegistryAddress: null,
      rootRegistryAddress: `0x${"33".repeat(20)}`,
      publicClient,
      fromBlock: 0n,
      chunkSize: 10n,
    });

    expect(publicClient.getLogs).toHaveBeenCalled();
    expect(publicClient.getBlock).toHaveBeenCalled();
    expect(intents.map((x) => x.position)).toEqual([1, 2]);
    expect(intents[0]?.timestamp).toBeInstanceOf(Date);
  });
});
