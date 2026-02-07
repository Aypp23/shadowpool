import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ArrowLeft, 
  Users, 
  GitMerge, 
  Clock,
  Play,
  Upload
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useStore } from '@/stores/useStore';
import { Match, RoundIntentRef } from '@/lib/types';
import { RoundTimeline } from '@/components/common/RoundTimeline';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { MerkleRootCard } from '@/components/common/MerkleRootCard';
import { fetchRelayerMatches, getRoundIntents, postRoundRoot, runBatchRound } from '@/services/shadowPool';
import { generateHexString, truncateAddress } from '@/lib/utils';
import { toast } from 'sonner';
import { isPublicViewer } from '@/lib/privacy';

export default function RoundDetail() {
  const { id } = useParams<{ id: string }>();
  const { rounds, intents, matches, settings, updateRound, addAdminAction, upsertMatches, roundIntentsByRoundId, setRoundIntentsForRound } = useStore();
  const wallet = useStore((s) => s.wallet);
  const [roundMatches, setRoundMatches] = useState<Match[]>([]);
  const [isRunningTee, setIsRunningTee] = useState(false);
  const [isPostingRoot, setIsPostingRoot] = useState(false);
  const lastRelayerFetchAt = useRef(0);

  const round = rounds.find(r => r.id === id);
  const roundIntents: RoundIntentRef[] = id ? (roundIntentsByRoundId[id] ?? []) : [];

  const publicMatches = round ? String(round.matchedCount ?? 0) : '—';
  const isPublicView = isPublicViewer(wallet);
  const viewerAddress = wallet?.address?.toLowerCase() ?? null;
  const viewerMatches = viewerAddress
    ? roundMatches.filter((m) => m.trader?.toLowerCase() === viewerAddress)
    : [];
  const intentsValue =
    round == null
      ? '—'
      : String(round.intentsCount ?? 0);
  const matchRateValue =
    round == null
      ? '—'
      : round.intentsCount > 0
        ? `${Math.round((round.matchedCount / round.intentsCount) * 100)}%`
        : '—';
  const formatTokenAmount = (raw: string, decimals: number, maxDp = 6) => {
    try {
      let value = BigInt(raw);
      const sign = value < 0n ? '-' : '';
      if (value < 0n) value = -value;
      const base = 10n ** BigInt(decimals);
      const intPart = value / base;
      const fracPart = value % base;
      if (decimals === 0) return `${sign}${intPart.toString()}`;
      let frac = fracPart.toString().padStart(decimals, '0');
      frac = frac.slice(0, Math.max(0, maxDp));
      frac = frac.replace(/0+$/, '');
      return frac.length > 0 ? `${sign}${intPart.toString()}.${frac}` : `${sign}${intPart.toString()}`;
    } catch {
      return raw;
    }
  };
  const getMatchSide = (id: string) => {
    if (id.includes(':buy:')) return 'Buy';
    if (id.includes(':sell:')) return 'Sell';
    return null;
  };
  const formatMatchId = (match: Match) => {
    const src = match.matchIdHash ?? match.id;
    return truncateAddress(src, 6);
  };

  useEffect(() => {
    if (!id) return;
    setRoundMatches(matches.filter((m) => m.roundId === id));
  }, [id, matches]);

  useEffect(() => {
    if (!round) return;
    const now = Date.now();
    if (now - lastRelayerFetchAt.current < 15000) return;
    lastRelayerFetchAt.current = now;
    let active = true;
    void (async () => {
      const relayed = await fetchRelayerMatches(round.id, { mode: isPublicView ? 'public' : 'private' });
      if (!active || !relayed) return;
      if (relayed.matches.length > 0) {
        setRoundMatches(relayed.matches);
        upsertMatches(relayed.matches);
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const nextPhase =
        typeof relayed.roundExpiry === 'number'
          ? nowSeconds <= relayed.roundExpiry
            ? 'executable'
            : 'completed'
          : round.phase;
      updateRound(round.id, {
        matchedCount: typeof relayed.matchCount === 'number' ? relayed.matchCount : relayed.matches.length,
        merkleRoot: relayed.merkleRoot ?? round.merkleRoot,
        rootValidUntil:
          typeof relayed.roundExpiry === 'number' ? new Date(relayed.roundExpiry * 1000) : round.rootValidUntil,
        phase: nextPhase,
      });
    })();
    return () => {
      active = false;
    };
  }, [round, roundMatches.length, upsertMatches, updateRound, isPublicView]);

  useEffect(() => {
    if (!id) return;
    if (roundIntentsByRoundId[id]) return;
    let active = true;
    void (async () => {
      try {
        const loaded = await getRoundIntents(id);
        if (!active) return;
        setRoundIntentsForRound(id, loaded);
      } catch {
        return;
      }
    })();
    return () => {
      active = false;
    };
  }, [id, roundIntentsByRoundId, setRoundIntentsForRound]);

  const handleRunTee = async () => {
    if (!round) return;
    setIsRunningTee(true);

    try {
      const protectedDataAddresses =
        roundIntents.length > 0
          ? Array.from(new Set(roundIntents.map((i) => i.protectedData.toLowerCase())))
          : intents
              .filter((i) => i.roundId === round.id)
              .map((i) => i.protectedDataAddress)
              .filter((x): x is string => typeof x === 'string' && x.length > 0);

      const result = await runBatchRound(round.id, protectedDataAddresses);
      if (result.matches?.length) {
        setRoundMatches(result.matches);
        upsertMatches(result.matches);
      }
      updateRound(round.id, { 
        phase: 'posted',
        matchedCount: result.matchCount,
        merkleRoot: result.merkleRoot ?? round.merkleRoot,
      });
      addAdminAction({
        id: generateHexString(16),
        timestamp: new Date(),
        type: 'run_tee',
        params: { roundId: round.id },
        result: 'success',
        details: `TEE matching completed. ${result.matchCount || 0} matches found.`,
      });
      toast.success('TEE matching completed!');
    } catch (error) {
      toast.error('Failed to run TEE matching');
    } finally {
      setIsRunningTee(false);
    }
  };

  const handlePostRoot = async () => {
    if (!round) return;
    setIsPostingRoot(true);

    try {
      if (!round.merkleRoot) {
        throw new Error('Missing merkle root for this round');
      }
      const expirySeconds = Math.floor(round.endTime.getTime() / 1000);
      const result = await postRoundRoot(round.id, round.merkleRoot, expirySeconds);
      updateRound(round.id, { 
        phase: 'executable',
        postedAt: new Date(),
        txHash: result.txHash,
      });
      addAdminAction({
        id: generateHexString(16),
        timestamp: new Date(),
        type: 'post_root',
        params: { roundId: round.id, merkleRoot: round.merkleRoot.slice(0, 18) + '...' },
        result: 'success',
        details: `Merkle root posted. Tx: ${result.txHash.slice(0, 18)}...`,
      });
      toast.success('Merkle root posted on-chain!');
    } catch (error) {
      toast.error('Failed to post merkle root');
    } finally {
      setIsPostingRoot(false);
    }
  };

  if (!round) {
    return (
      <div className="container py-20 text-center">
        <p className="text-muted-foreground">Round not found</p>
        <Button asChild variant="link" className="mt-4">
          <Link to="/rounds">Back to rounds</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="container py-8 md:py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-8"
      >
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="icon">
            <Link to="/rounds">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div>
            <h1 className="font-serif text-3xl font-bold font-mono">{round.id}</h1>
            <p className="text-muted-foreground capitalize">{round.phase} phase</p>
          </div>
        </div>

        {/* Timeline */}
        <Card>
          <CardContent className="p-6">
            <RoundTimeline currentPhase={round.phase} />
          </CardContent>
        </Card>

        {/* Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <Users className="w-5 h-5 mx-auto text-muted-foreground mb-2" />
              <div className="text-2xl font-bold font-mono">{intentsValue}</div>
              <div className="text-sm text-muted-foreground">Intents</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <GitMerge className="w-5 h-5 mx-auto text-muted-foreground mb-2" />
              <div className="text-2xl font-bold font-mono text-primary">
                {isPublicView ? publicMatches : viewerMatches.length}
              </div>
              <div className="text-sm text-muted-foreground">Matches</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Clock className="w-5 h-5 mx-auto text-muted-foreground mb-2" />
              <CountdownTimer
                endTime={
                  round.phase === 'executable' || round.phase === 'posted'
                    ? round.rootValidUntil ?? null
                    : round.endTime
                }
                variant="text"
                size="lg"
              />
              <div className="text-sm text-muted-foreground mt-1">Remaining</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="w-5 h-5 mx-auto text-muted-foreground mb-2">%</div>
              <div className="text-2xl font-bold font-mono">{matchRateValue}</div>
              <div className="text-sm text-muted-foreground">Match Rate</div>
            </CardContent>
          </Card>
        </div>

        {/* Merkle Root + Admin Actions hidden for now */}

        {/* Matches */}
        {!isPublicView && (
          <Card>
            <CardHeader>
              <CardTitle className="font-serif">Matches</CardTitle>
            </CardHeader>
            <CardContent>
              {viewerMatches.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No matches for this wallet yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {viewerMatches.map((match, index) => {
                    const isExecutable =
                      match.proofAvailable && !match.executed && match.expiry.getTime() > Date.now();
                    const side = getMatchSide(match.id);
                    const decimalsIn =
                      typeof match.tokenIn.decimals === 'number' && Number.isFinite(match.tokenIn.decimals)
                        ? match.tokenIn.decimals
                        : 18;
                    const decimalsOut =
                      typeof match.tokenOut.decimals === 'number' && Number.isFinite(match.tokenOut.decimals)
                        ? match.tokenOut.decimals
                        : 18;
                    const amountIn = formatTokenAmount(match.amountIn, decimalsIn, 4);
                    const minOut = formatTokenAmount(match.minAmountOut, decimalsOut, 4);
                    return (
                      <motion.div
                        key={match.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className="rounded-2xl border border-border/40 bg-transparent p-4 sm:p-5"
                      >
                        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {side && (
                                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider">
                                  {side}
                                </span>
                              )}
                              <span className="font-mono">Match {formatMatchId(match)}</span>
                            </div>
                            <div className="mt-2 text-sm font-medium">
                              <span className="inline-flex items-center gap-2">
                                <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                                  {match.tokenIn.symbol}
                                </span>
                                <span className="text-muted-foreground">→</span>
                                <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                                  {match.tokenOut.symbol}
                                </span>
                              </span>
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">
                              Expires {match.expiry.toLocaleString()}
                            </div>
                          </div>

                          <div className="flex flex-col sm:flex-row gap-6">
                            <div>
                              <div className="text-xs uppercase tracking-wide text-muted-foreground">You pay</div>
                              <div className="font-mono text-base text-foreground">
                                {amountIn} <span className="text-xs text-muted-foreground">{match.tokenIn.symbol}</span>
                              </div>
                            </div>
                            <div>
                              <div className="text-xs uppercase tracking-wide text-muted-foreground">Min receive</div>
                              <div className="font-mono text-base text-foreground">
                                {minOut} <span className="text-xs text-muted-foreground">{match.tokenOut.symbol}</span>
                              </div>
                            </div>
                          </div>

                          <div className="shrink-0">
                            {isExecutable ? (
                              <Button asChild size="sm" variant="outline">
                                <Link to={`/execute?match=${match.id}`}>Execute</Link>
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">Not executable</span>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isPublicView && (
          <Card>
            <CardHeader>
              <CardTitle className="font-serif">Matches</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-6 text-muted-foreground">
                <div className="text-sm text-primary font-semibold">
                  Total matches: {publicMatches}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </motion.div>
    </div>
  );
}
