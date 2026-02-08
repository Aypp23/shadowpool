import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Intent, Round, Match, WalletState, AppSettings, AdminAction, RoundIntentRef } from '@/lib/types';

interface ShadowPoolStore {
  // Wallet State
  wallet: WalletState;
  setWallet: (wallet: WalletState) => void;
  connectWallet: () => void;
  disconnectWallet: () => void;
  setSessionPaused: (paused: boolean) => void;
  setWalletConnectionActions: (actions: {
    connectWallet: () => void;
    disconnectWallet: () => void;
  }) => void;
  
  // Intents
  intents: Intent[];
  addIntent: (intent: Intent) => void;
  updateIntent: (id: string, updates: Partial<Intent>) => void;
  deleteIntent: (id: string) => void;
  
  // Rounds
  rounds: Round[];
  setRounds: (rounds: Round[]) => void;
  updateRound: (id: string, updates: Partial<Round>) => void;

  // Round intents
  roundIntentsByRoundId: Record<string, RoundIntentRef[]>;
  setRoundIntentsForRound: (roundId: string, intents: RoundIntentRef[]) => void;
  clearRoundIntents: () => void;

  // Nagle
  nagle: {
    running: boolean;
    lastSyncAt: Date | null;
    lastRoundsAt: Date | null;
    lastIntentsAt: Date | null;
    consecutiveErrors: number;
    lastError: string | null;
  };
  setNagle: (updates: Partial<ShadowPoolStore['nagle']>) => void;
  
  // Matches
  matches: Match[];
  updateMatch: (id: string, updates: Partial<Match>) => void;
  upsertMatches: (matches: Match[]) => void;
  
  // Admin Actions
  adminActions: AdminAction[];
  addAdminAction: (action: AdminAction) => void;
  
  // Settings
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function normalizeLower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function syncExecutedIntentsFromMatches(intents: Intent[], matches: Match[]): Intent[] {
  const executedProtectedData = new Set<string>();
  const executedMatchIds = new Set<string>();
  for (const m of matches) {
    if (!m.executed) continue;
    const matchId = normalizeLower(m.id);
    if (matchId) executedMatchIds.add(matchId);
    const pd = normalizeLower(m.traderProtectedDataAddress);
    if (pd) executedProtectedData.add(pd);
  }
  if (executedProtectedData.size === 0 && executedMatchIds.size === 0) return intents;

  let changed = false;
  const next = intents.map((intent) => {
    if (intent.status !== 'submitted' && intent.status !== 'matched') return intent;
    const pd = normalizeLower(intent.protectedDataAddress);
    const matchId = normalizeLower(intent.matchId);
    const executed =
      (pd && executedProtectedData.has(pd)) || (matchId && executedMatchIds.has(matchId));
    if (!executed) return intent;
    changed = true;
    return { ...intent, status: 'executed' as const };
  });
  return changed ? next : intents;
}

function reviveIntent(raw: unknown, defaultTrader: string | null): Intent | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  const createdAt = toDate(i.createdAt) ?? new Date();
  const expiry = toDate(i.expiry) ?? new Date();
  const trader =
    typeof i.trader === 'string' ? i.trader : typeof defaultTrader === 'string' ? defaultTrader : undefined;
  return { ...(i as unknown as Intent), createdAt, expiry, trader };
}

function reviveRound(raw: unknown): Round | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const startTime = toDate(r.startTime) ?? new Date();
  const endTime = toDate(r.endTime) ?? new Date(startTime.getTime());
  const postedAt = r.postedAt == null ? undefined : toDate(r.postedAt) ?? undefined;
  const rootValidUntil = r.rootValidUntil == null ? undefined : toDate(r.rootValidUntil) ?? undefined;
  return { ...(r as unknown as Round), startTime, endTime, postedAt, rootValidUntil };
}

function reviveRoundIntentRef(raw: unknown): RoundIntentRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const roundId = typeof r.roundId === 'string' ? r.roundId : null;
  const position = typeof r.position === 'number' ? r.position : Number(r.position);
  const protectedData = typeof r.protectedData === 'string' ? r.protectedData : null;
  if (!roundId || !Number.isFinite(position) || !protectedData) return null;
  const timestamp = r.timestamp == null ? undefined : toDate(r.timestamp) ?? undefined;
  return { ...(r as unknown as RoundIntentRef), roundId, position, protectedData, timestamp };
}

export const useStore = create<ShadowPoolStore>()(
  persist(
    (set) => ({
      wallet: {
        connected: false,
        address: null,
        network: 'Arbitrum Sepolia',
        balance: '0.00',
        voucherBalance: '0.00',
        isAdmin: false,
        sessionPaused: false,
      },
      
      setWallet: (wallet) =>
        set((state) => {
          if (!wallet.connected || !wallet.address) return { wallet };
          const nextIntents = state.intents.map((i) => (i.trader ? i : { ...i, trader: wallet.address }));
          return { wallet, intents: nextIntents };
        }),
      connectWallet: () => {},
      disconnectWallet: () => {},
      setSessionPaused: (paused) =>
        set((state) => ({
          wallet: { ...state.wallet, sessionPaused: paused },
        })),
      setWalletConnectionActions: (actions) => set(actions),
      
      intents: [],
      
      addIntent: (intent) => set((state) => ({
        intents: [...state.intents, intent],
        rounds: typeof intent.roundId === 'string'
          ? state.rounds.map((round) =>
              round.id === intent.roundId
                ? { ...round, intentsCount: Math.max(0, (round.intentsCount ?? 0) + 1) }
                : round
            )
          : state.rounds,
      })),
      
      updateIntent: (id, updates) => set((state) => ({
        intents: state.intents.map(intent => 
          intent.id === id ? { ...intent, ...updates } : intent
        )
      })),
      
      deleteIntent: (id) => set((state) => ({
        intents: state.intents.filter(intent => intent.id !== id)
      })),
      
      rounds: [],

      setRounds: (rounds) =>
        set((state) => {
          const localByRound = new Map<string, number>();
          for (const intent of state.intents) {
            if (!intent.roundId) continue;
            if (!['submitted', 'matched', 'executed'].includes(intent.status)) continue;
            localByRound.set(intent.roundId, (localByRound.get(intent.roundId) ?? 0) + 1);
          }

          const prevById = new Map(state.rounds.map((r) => [r.id, r]));
          const nextRounds = rounds.map((round) => {
            const localCount = localByRound.get(round.id) ?? 0;
            const prevCount = prevById.get(round.id)?.intentsCount ?? 0;
            const safeCount = Math.max(round.intentsCount, prevCount, localCount);
            return safeCount === round.intentsCount ? round : { ...round, intentsCount: safeCount };
          });

          return { rounds: nextRounds };
        }),
      
      updateRound: (id, updates) => set((state) => ({
        rounds: state.rounds.map(round => 
          round.id === id ? { ...round, ...updates } : round
        )
      })),

      roundIntentsByRoundId: {},
      setRoundIntentsForRound: (roundId, intents) =>
        set((state) => {
          const existing = state.roundIntentsByRoundId[roundId] ?? [];
          const round = state.rounds.find((r) => r.id === roundId);
          const keepExisting =
            intents.length === 0 && existing.length > 0 && typeof round?.intentsCount === 'number' && round.intentsCount > 0;
          const nextIntents = keepExisting ? existing : intents;
          return { roundIntentsByRoundId: { ...state.roundIntentsByRoundId, [roundId]: nextIntents } };
        }),
      clearRoundIntents: () => set({ roundIntentsByRoundId: {} }),

      nagle: {
        running: false,
        lastSyncAt: null,
        lastRoundsAt: null,
        lastIntentsAt: null,
        consecutiveErrors: 0,
        lastError: null,
      },
      setNagle: (updates) =>
        set((state) => ({
          nagle: { ...state.nagle, ...updates },
        })),
      
      matches: [],
      
      updateMatch: (id, updates) =>
        set((state) => {
          const nextMatches = state.matches.map((match) =>
            match.uid === id ? { ...match, ...updates } : match
          );
          const nextIntents = syncExecutedIntentsFromMatches(state.intents, nextMatches);
          return nextIntents === state.intents ? { matches: nextMatches } : { matches: nextMatches, intents: nextIntents };
        }),

      upsertMatches: (matches) =>
        set((state) => {
          const byId = new Map(state.matches.map((m) => [m.uid, m]));
          for (const match of matches) byId.set(match.uid, match);
          const nextMatches = Array.from(byId.values());
          const nextIntents = syncExecutedIntentsFromMatches(state.intents, nextMatches);
          return nextIntents === state.intents ? { matches: nextMatches } : { matches: nextMatches, intents: nextIntents };
        }),
      
      adminActions: [],
      
      addAdminAction: (action) => set((state) => ({
        adminActions: [action, ...state.adminActions]
      })),
      
      // Settings
      settings: {
        showTechnicalDetails: false,
        adminModeEnabled: false,
        autoRunMatching: false,
        autoPostRoot: false,
        accentIntensity: 70,
      },
      
      updateSettings: (updates) => set((state) => ({
        settings: { ...state.settings, ...updates }
      })),
    }),
    {
      name: 'shadowpool-storage',
      partialize: (state) => ({ 
        settings: state.settings,
        wallet: state.wallet,
        intents: state.intents,
        rounds: state.rounds,
        roundIntentsByRoundId: Object.fromEntries(
          Object.entries(state.roundIntentsByRoundId).slice(0, 5).map(([roundId, intents]) => [
            roundId,
            intents.slice(0, 200),
          ])
        ),
      }),
      merge: (persistedState, currentState) => {
        const p = (persistedState ?? {}) as Partial<ShadowPoolStore> & {
          intents?: unknown[];
          rounds?: unknown[];
          roundIntentsByRoundId?: Record<string, unknown[]>;
        };
        const wallet =
          p.wallet && typeof p.wallet === 'object'
            ? (p.wallet as WalletState)
            : currentState.wallet;
        const defaultTrader = wallet?.address ?? null;
        const nextIntents = Array.isArray(p.intents)
          ? p.intents
              .map((x) => reviveIntent(x, defaultTrader))
              .filter((x): x is Intent => x !== null)
          : currentState.intents;
        const nextRounds = Array.isArray(p.rounds)
          ? p.rounds
              .map((x) => reviveRound(x))
              .filter((x): x is Round => x !== null)
          : currentState.rounds;
        const nextRoundIntentsByRoundId =
          p.roundIntentsByRoundId && typeof p.roundIntentsByRoundId === 'object'
            ? Object.fromEntries(
                Object.entries(p.roundIntentsByRoundId)
                  .slice(0, 5)
                  .map(([roundId, rawIntents]) => [
                    roundId,
                    Array.isArray(rawIntents)
                      ? rawIntents
                          .map((x) => reviveRoundIntentRef(x))
                          .filter((x): x is RoundIntentRef => x !== null)
                          .slice(0, 200)
                      : [],
                  ])
              )
            : currentState.roundIntentsByRoundId;
        return { ...currentState, ...p, wallet, intents: nextIntents, rounds: nextRounds, roundIntentsByRoundId: nextRoundIntentsByRoundId };
      },
    }
  )
);
