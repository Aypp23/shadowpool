import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { useActiveWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, formatEther, http } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { useStore } from "@/stores/useStore";
import {
  getReadRpcUrl,
  postRoundRoot,
  runBatchRound,
  setShadowPoolEthereumProvider,
  startNagle,
} from "@/services/shadowPool";
import { generateHexString } from "@/lib/utils";
import { toast } from "sonner";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import CreateIntent from "./pages/CreateIntent";
import Rounds from "./pages/Rounds";
import RoundDetail from "./pages/RoundDetail";
import ExecuteTrade from "./pages/ExecuteTrade";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();
const DEFAULT_WALLET_STATE = {
  connected: false,
  address: null,
  network: "Arbitrum Sepolia",
  balance: "0.00",
  voucherBalance: "0.00",
  isAdmin: false,
  sessionPaused: false,
};

class WalletSyncErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("WalletSync crashed", error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function normalizeChainId(chainId?: number | string) {
  if (!chainId) return undefined;
  if (typeof chainId === "number") return chainId;
  let value = chainId.trim();
  if (value.includes(":")) {
    const parts = value.split(":");
    value = parts[parts.length - 1] ?? value;
  }
  if (value.startsWith("0x")) return Number.parseInt(value, 16);
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type EthereumWalletLike = {
  type: "ethereum";
  address?: string;
  chainId?: number | string;
  walletClientType?: string;
  getEthereumProvider?: () => Promise<unknown>;
  disconnect?: () => void;
};

function isEthereumWallet(wallet: unknown): wallet is EthereumWalletLike {
  return (
    !!wallet &&
    typeof wallet === "object" &&
    "type" in wallet &&
    (wallet as { type?: unknown }).type === "ethereum"
  );
}

function WalletSync() {
  const privy = usePrivy();
  const authenticated = privy?.authenticated ?? false;
  const login = privy?.login ?? (() => {});
  const logout = privy?.logout ?? (() => {});
  const ready = privy?.ready ?? false;
  const activeWalletState = useActiveWallet();
  const activeWallet = activeWalletState?.wallet ?? null;
  const walletsState = useWallets();
  const wallets = Array.isArray(walletsState?.wallets) ? walletsState.wallets : [];
  const setWallet = useStore((s) => s.setWallet);
  const setSessionPaused = useStore((s) => s.setSessionPaused);
  const setWalletConnectionActions = useStore((s) => s.setWalletConnectionActions);
  const setRounds = useStore((s) => s.setRounds);
  const setRoundIntentsForRound = useStore((s) => s.setRoundIntentsForRound);
  const clearRoundIntents = useStore((s) => s.clearRoundIntents);
  const setNagle = useStore((s) => s.setNagle);
  const rounds = useStore((s) => s.rounds);
  const intents = useStore((s) => s.intents);
  const roundIntentsByRoundId = useStore((s) => s.roundIntentsByRoundId);
  const settings = useStore((s) => s.settings);
  const updateRound = useStore((s) => s.updateRound);
  const addAdminAction = useStore((s) => s.addAdminAction);
  const upsertMatches = useStore((s) => s.upsertMatches);
  const storeWallet = useStore((s) => s.wallet ?? DEFAULT_WALLET_STATE);
  const sessionPaused = useStore((s) => s.wallet?.sessionPaused ?? DEFAULT_WALLET_STATE.sessionPaused);

  const autoRunState = useRef<{ matching: Set<string>; posting: Set<string> }>({
    matching: new Set(),
    posting: new Set(),
  });

  const isPrivyWallet = (w: EthereumWalletLike | null) =>
    w?.walletClientType === "privy" || w?.walletClientType === "privy-v2";
  const ethereumWallets = wallets.filter(isEthereumWallet);
  const externalWallets = ethereumWallets.filter((w) => !isPrivyWallet(w));
  const preferredWallet =
    isEthereumWallet(activeWallet) && !isPrivyWallet(activeWallet)
      ? activeWallet
      : externalWallets[0] ?? (isEthereumWallet(activeWallet) ? activeWallet : null) ?? ethereumWallets[0] ?? null;
  const selectedWallet = preferredWallet;
  const walletAddress = selectedWallet?.address ?? null;
  const walletChainId = normalizeChainId(selectedWallet?.chainId);
  const [providerAddress, setProviderAddress] = useState<string | null>(null);
  const [providerChainId, setProviderChainId] = useState<number | undefined>(undefined);
  const [providerReady, setProviderReady] = useState(false);
  const resolvedAddress = providerReady ? providerAddress : walletAddress;
  const resolvedChainId = providerReady ? providerChainId : walletChainId;

  useEffect(() => {
    if (sessionPaused) {
      setProviderAddress(null);
      setProviderChainId(undefined);
      setProviderReady(false);
      return;
    }
    if (!selectedWallet || typeof selectedWallet.getEthereumProvider !== "function") {
      setProviderAddress(null);
      setProviderChainId(undefined);
      setProviderReady(false);
      return;
    }

    let active = true;
    let provider: {
      request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    } | null = null;
    let cleanup = () => {};
    let pollId: ReturnType<typeof setInterval> | null = null;

    const readAccounts = async () => {
      if (!provider?.request) return;
      try {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (!active) return;
        const next = Array.isArray(accounts) ? accounts[0] ?? null : null;
        setProviderAddress(typeof next === "string" ? next : null);
      } catch {
        if (!active) return;
        setProviderAddress(null);
      }
    };

    const readChainId = async () => {
      if (!provider?.request) return;
      try {
        const chainIdValue = await provider.request({ method: "eth_chainId" });
        if (!active) return;
        const normalized = normalizeChainId(
          typeof chainIdValue === "string" || typeof chainIdValue === "number" ? chainIdValue : undefined
        );
        setProviderChainId(normalized);
      } catch {
        if (!active) return;
        setProviderChainId(undefined);
      }
    };

    const setup = async () => {
      provider = await selectedWallet.getEthereumProvider();
      if (!active || !provider) return;
      await Promise.all([readAccounts(), readChainId()]);
      if (!active) return;
      setProviderReady(true);

      const handleAccountsChanged = (accounts: unknown) => {
        const next = Array.isArray(accounts) ? accounts[0] ?? null : null;
        setProviderAddress(typeof next === "string" ? next : null);
      };
      const handleChainChanged = (nextChainId: unknown) => {
        setProviderChainId(
          normalizeChainId(
            typeof nextChainId === "string" || typeof nextChainId === "number" ? nextChainId : undefined
          )
        );
      };
      const handleDisconnect = () => {
        setProviderAddress(null);
        setProviderChainId(undefined);
      };

      if (typeof provider.on === "function") {
        provider.on("accountsChanged", handleAccountsChanged);
        provider.on("chainChanged", handleChainChanged);
        provider.on("disconnect", handleDisconnect);
        cleanup = () => {
          if (typeof provider.removeListener === "function") {
            provider.removeListener("accountsChanged", handleAccountsChanged);
            provider.removeListener("chainChanged", handleChainChanged);
            provider.removeListener("disconnect", handleDisconnect);
          }
        };
      }

      pollId = setInterval(() => {
        void readAccounts();
        void readChainId();
      }, 2000);
    };

    void setup();

    return () => {
      active = false;
      if (pollId) clearInterval(pollId);
      setProviderReady(false);
      cleanup();
    };
  }, [selectedWallet, sessionPaused]);

  // Skip injected provider handling to avoid external wallet popups.

  useEffect(() => {
    const disconnect = async () => {
      setSessionPaused(true);
      try {
        try {
          if (selectedWallet && typeof selectedWallet.disconnect === "function") {
            selectedWallet.disconnect();
          }
        } catch (err) {
          console.error("Wallet disconnect failed", err);
        }
        await logout();
      } catch (err) {
        console.error("Logout failed", err);
      } finally {
        setShadowPoolEthereumProvider(null);
        setProviderAddress(null);
        setProviderChainId(undefined);
        setProviderReady(false);
        setRounds([]);
        clearRoundIntents();
        setNagle({
          running: false,
          lastSyncAt: null,
          lastRoundsAt: null,
          lastIntentsAt: null,
          consecutiveErrors: 0,
          lastError: null,
        });
        setWallet({
          connected: false,
          address: null,
          network: "Arbitrum Sepolia",
          balance: "0.00",
          voucherBalance: "0.00",
          isAdmin: false,
          sessionPaused: true,
        });
      }
    };

    setWalletConnectionActions({
      connectWallet: () => {
        setSessionPaused(false);
        void login();
      },
      disconnectWallet: () => {
        void disconnect();
      },
    });
  }, [login, logout, setWalletConnectionActions, setRounds, clearRoundIntents, setNagle, setWallet, setSessionPaused, selectedWallet]);

  useEffect(() => {
    let isActive = true;
    let stopNagle: (() => void) | null = null;

    const run = async () => {
      try {
        if (sessionPaused) {
          if (stopNagle) stopNagle();
          setShadowPoolEthereumProvider(null);
          setRounds([]);
          clearRoundIntents();
          setNagle({
            running: false,
            lastSyncAt: null,
            lastRoundsAt: null,
            lastIntentsAt: null,
            consecutiveErrors: 0,
            lastError: null,
          });
          if (storeWallet.connected || storeWallet.address) {
            setWallet({
              connected: false,
              address: null,
              network: "Arbitrum Sepolia",
              balance: "0.00",
              voucherBalance: "0.00",
              isAdmin: false,
              sessionPaused: true,
            });
          }
          return;
        }
        if (!ready) return;
        if (!authenticated || !selectedWallet || !resolvedAddress) {
          if (stopNagle) stopNagle();
          setShadowPoolEthereumProvider(null);
          setRounds([]);
          clearRoundIntents();
          setNagle({
            running: false,
            lastSyncAt: null,
            lastRoundsAt: null,
            lastIntentsAt: null,
            consecutiveErrors: 0,
            lastError: null,
          });
          setWallet({
            connected: false,
            address: null,
            network: "Arbitrum Sepolia",
            balance: "0.00",
            voucherBalance: "0.00",
            isAdmin: false,
            sessionPaused: false,
          });
          return;
        }

        if (!resolvedAddress) return;

        const provider =
          selectedWallet && typeof selectedWallet.getEthereumProvider === "function"
            ? await selectedWallet.getEthereumProvider()
            : null;
        if (!provider) {
          throw new Error("Wallet provider unavailable");
        }
        if (!isActive) return;
        setShadowPoolEthereumProvider(provider);

      const chain =
        resolvedChainId === arbitrumSepolia.id
          ? arbitrumSepolia
          : resolvedChainId === arbitrum.id
            ? arbitrum
            : undefined;
      const network = chain?.name ?? (resolvedChainId ? `Chain ${resolvedChainId}` : "Unknown");

      let balance = "0.00";
      {
        const rpcUrl = getReadRpcUrl();
        const balanceChain = chain ?? arbitrumSepolia;
        const client = createPublicClient({
          chain: balanceChain,
          transport: rpcUrl ? http(rpcUrl) : http(),
        });
        const wei = await client.getBalance({ address: resolvedAddress as `0x${string}` });
        balance = Number.parseFloat(formatEther(wei)).toFixed(4);
      }

      if (!isActive) return;
      setWallet({
        connected: true,
        address: resolvedAddress,
        network,
        balance,
        voucherBalance: "0.00",
        isAdmin: (() => {
          const admin = import.meta.env.VITE_ADMIN_ADDRESS;
          if (!admin) return true;
          return admin.toLowerCase() === resolvedAddress.toLowerCase();
        })(),
        sessionPaused: false,
      });

        if (stopNagle) stopNagle();
        stopNagle = startNagle({
          config: { lookbackRounds: 12, maxActiveRounds: 2 },
          onRounds: (rounds) => {
            if (!isActive) return;
            setRounds(rounds);
          },
          onRoundIntents: (roundId, intents) => {
            if (!isActive) return;
            setRoundIntentsForRound(roundId, intents);
          },
          onMetrics: (metrics) => {
            if (!isActive) return;
            const lastErrorAt =
              metrics.rounds.lastErrorAt && metrics.intents.lastErrorAt
                ? Math.max(metrics.rounds.lastErrorAt, metrics.intents.lastErrorAt)
                : metrics.rounds.lastErrorAt ?? metrics.intents.lastErrorAt ?? null;
            const lastError =
              lastErrorAt === metrics.rounds.lastErrorAt
                ? metrics.rounds.lastErrorMessage
                : lastErrorAt === metrics.intents.lastErrorAt
                  ? metrics.intents.lastErrorMessage
                  : metrics.rounds.lastErrorMessage ?? metrics.intents.lastErrorMessage ?? null;

            setNagle({
              running: metrics.status === "running",
              lastSyncAt: metrics.lastTickAt ? new Date(metrics.lastTickAt) : null,
              lastRoundsAt: metrics.rounds.lastSuccessAt ? new Date(metrics.rounds.lastSuccessAt) : null,
              lastIntentsAt: metrics.intents.lastSuccessAt ? new Date(metrics.intents.lastSuccessAt) : null,
              consecutiveErrors: Math.max(metrics.rounds.consecutiveErrors, metrics.intents.consecutiveErrors),
              lastError: lastError ?? null,
            });
          },
        });
      } catch (err) {
        if (!isActive) return;
        console.error("WalletSync error", err);
        setShadowPoolEthereumProvider(null);
        setNagle({
          running: false,
          lastSyncAt: null,
          lastRoundsAt: null,
          lastIntentsAt: null,
          consecutiveErrors: 0,
          lastError: err instanceof Error ? err.message : String(err),
        });
        setWallet({
          connected: false,
          address: null,
          network: "Arbitrum Sepolia",
          balance: "0.00",
          voucherBalance: "0.00",
          isAdmin: false,
          sessionPaused: false,
        });
      }
    };

    run();

    return () => {
      isActive = false;
      if (stopNagle) stopNagle();
    };
  }, [
    authenticated,
    ready,
    selectedWallet,
    resolvedAddress,
    resolvedChainId,
    sessionPaused,
    setRounds,
    setWallet,
    setRoundIntentsForRound,
    clearRoundIntents,
    setNagle,
  ]);

  useEffect(() => {
    if (!storeWallet.connected || !storeWallet.isAdmin || !settings.adminModeEnabled) return;
    if (!settings.autoRunMatching && !settings.autoPostRoot) return;

    let cancelled = false;

    const run = async () => {
      if (settings.autoRunMatching) {
        const matchingRounds = rounds.filter((r) => r.phase === "matching");
        for (const round of matchingRounds) {
          if (cancelled) return;
          if (autoRunState.current.matching.has(round.id)) continue;

          const protectedDataSet = new Set<string>();
          const refs = roundIntentsByRoundId[round.id] ?? [];
          for (const ref of refs) {
            if (typeof ref.protectedData === "string" && ref.protectedData.length > 0) {
              protectedDataSet.add(ref.protectedData.toLowerCase());
            }
          }
          for (const intent of intents) {
            if (intent.roundId !== round.id) continue;
            if (typeof intent.protectedDataAddress !== "string" || intent.protectedDataAddress.length === 0) continue;
            protectedDataSet.add(intent.protectedDataAddress.toLowerCase());
          }
          const protectedDataAddresses = Array.from(protectedDataSet);
          if (protectedDataAddresses.length === 0) continue;

          autoRunState.current.matching.add(round.id);
          try {
            const result = await runBatchRound(round.id, protectedDataAddresses);
            if (cancelled) return;
            if (result.matches?.length) upsertMatches(result.matches);
            updateRound(round.id, {
              phase: "posted",
              matchedCount: result.matchCount,
              merkleRoot: result.merkleRoot ?? round.merkleRoot,
            });
            addAdminAction({
              id: generateHexString(16),
              timestamp: new Date(),
              type: "run_tee",
              params: { roundId: round.id },
              result: "success",
              details: `Auto-run TEE matching completed. ${result.matchCount || 0} matches found.`,
            });

            if (settings.autoPostRoot && result.merkleRoot) {
              autoRunState.current.posting.add(round.id);
              try {
                const expirySeconds = Math.floor(round.endTime.getTime() / 1000);
                const postResult = await postRoundRoot(round.id, result.merkleRoot, expirySeconds);
                if (cancelled) return;
                updateRound(round.id, {
                  phase: "executable",
                  postedAt: new Date(),
                  txHash: postResult.txHash,
                });
                addAdminAction({
                  id: generateHexString(16),
                  timestamp: new Date(),
                  type: "post_root",
                  params: { roundId: round.id, merkleRoot: result.merkleRoot.slice(0, 18) + "..." },
                  result: "success",
                  details: `Auto-posted merkle root. Tx: ${postResult.txHash.slice(0, 18)}...`,
                });
              } catch (err) {
                autoRunState.current.posting.delete(round.id);
                addAdminAction({
                  id: generateHexString(16),
                  timestamp: new Date(),
                  type: "post_root",
                  params: { roundId: round.id },
                  result: "failed",
                  details: err instanceof Error ? err.message : "Auto-post root failed.",
                });
                toast.error("Auto-post merkle root failed");
              }
            }
          } catch (err) {
            autoRunState.current.matching.delete(round.id);
            addAdminAction({
              id: generateHexString(16),
              timestamp: new Date(),
              type: "run_tee",
              params: { roundId: round.id },
              result: "failed",
              details: err instanceof Error ? err.message : "Auto-run TEE matching failed.",
            });
            toast.error("Auto-run TEE matching failed");
          }
        }
      }

      if (settings.autoPostRoot) {
        const postedRounds = rounds.filter((r) => r.phase === "posted" && r.merkleRoot);
        for (const round of postedRounds) {
          if (cancelled) return;
          if (!round.merkleRoot) continue;
          if (autoRunState.current.posting.has(round.id)) continue;
          autoRunState.current.posting.add(round.id);
          try {
            const expirySeconds = Math.floor(round.endTime.getTime() / 1000);
            const postResult = await postRoundRoot(round.id, round.merkleRoot, expirySeconds);
            if (cancelled) return;
            updateRound(round.id, {
              phase: "executable",
              postedAt: new Date(),
              txHash: postResult.txHash,
            });
            addAdminAction({
              id: generateHexString(16),
              timestamp: new Date(),
              type: "post_root",
              params: { roundId: round.id, merkleRoot: round.merkleRoot.slice(0, 18) + "..." },
              result: "success",
              details: `Auto-posted merkle root. Tx: ${postResult.txHash.slice(0, 18)}...`,
            });
          } catch (err) {
            autoRunState.current.posting.delete(round.id);
            addAdminAction({
              id: generateHexString(16),
              timestamp: new Date(),
              type: "post_root",
              params: { roundId: round.id },
              result: "failed",
              details: err instanceof Error ? err.message : "Auto-post root failed.",
            });
            toast.error("Auto-post merkle root failed");
          }
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    storeWallet.connected,
    storeWallet.isAdmin,
    settings.adminModeEnabled,
    settings.autoRunMatching,
    settings.autoPostRoot,
    rounds,
    intents,
    roundIntentsByRoundId,
    updateRound,
    addAdminAction,
    upsertMatches,
  ]);

  return null;
}

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WalletSyncErrorBoundary>
          <WalletSync />
        </WalletSyncErrorBoundary>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Landing />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/create" element={<CreateIntent />} />
              <Route path="/rounds" element={<Rounds />} />
              <Route path="/round/:id" element={<RoundDetail />} />
              <Route path="/execute" element={<ExecuteTrade />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
