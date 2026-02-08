import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Zap, 
  CheckCircle2, 
  XCircle,
  Loader2,
  AlertCircle,
  Clock,
  ArrowRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useStore } from '@/stores/useStore';
import { Match, HookData, ExecutionResult } from '@/lib/types';
// import { HookDataInspector } from '@/components/common/HookDataInspector';
import { Confetti } from '@/components/common/Confetti';
import { fetchRelayerMatches, generateHookData, executeTradeWithProof } from '@/services/shadowPool';
import { truncateAddress } from '@/lib/utils';
import { isPublicViewer } from '@/lib/privacy';
import { toast } from 'sonner';

export default function ExecuteTrade() {
  const [searchParams] = useSearchParams();
  const { wallet, rounds, matches, updateMatch, updateRound, connectWallet, upsertMatches } = useStore();
  const isPublicView = isPublicViewer(wallet);
  const viewerAddress = wallet.address?.toLowerCase() ?? null;
  const [executableMatches, setExecutableMatches] = useState<Match[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [hookData, setHookData] = useState<HookData | null>(null);
  const [isLoadingHookData, setIsLoadingHookData] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const activeHookMatchId = useRef<string | null>(null);
  const isExecutionFailure = (
    r: ExecutionResult
  ): r is Extract<ExecutionResult, { success: false }> => r.success === false;
  const normalizeAmount = (value?: string | number | bigint | null) => {
    if (value === undefined || value === null) return null;
    try {
      const raw = typeof value === 'string' ? value.replace(/,/g, '') : String(value);
      return BigInt(raw);
    } catch {
      return null;
    }
  };
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
    if (isPublicView) return;
    const now = Date.now();
    setExecutableMatches(
      matches.filter(
        (m) =>
          m.proofAvailable &&
          m.expiry.getTime() > now &&
          (viewerAddress ? m.trader?.toLowerCase() === viewerAddress : false)
      )
    );
  }, [matches, isPublicView, viewerAddress]);

  useEffect(() => {
    if (isPublicView) return;
    if (rounds.length === 0) return;
    const candidateRounds = rounds.filter(
      (round) => round.phase === 'executable' || round.phase === 'posted'
    );
    if (candidateRounds.length === 0) return;
    let active = true;
    void (async () => {
      for (const round of candidateRounds) {
        if (!active) return;
        const relayed = await fetchRelayerMatches(round.id, { mode: 'private' });
        if (!active || !relayed) continue;
        if (relayed.matches.length > 0) {
          upsertMatches(relayed.matches);
        }
        if (relayed.merkleRoot || typeof relayed.matchCount === 'number') {
          updateRound(round.id, {
            merkleRoot: relayed.merkleRoot ?? round.merkleRoot,
            matchedCount: typeof relayed.matchCount === 'number' ? relayed.matchCount : round.matchedCount,
            phase:
              typeof relayed.roundExpiry === 'number'
                ? Math.floor(Date.now() / 1000) <= relayed.roundExpiry
                  ? 'executable'
                  : 'completed'
                : round.phase,
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [rounds, upsertMatches, updateRound, isPublicView]);

  useEffect(() => {
    if (isPublicView) return;
    const matchId = searchParams.get('match');
    if (matchId && executableMatches.length > 0) {
      const match = executableMatches.find(m => m.id === matchId);
      if (match && !match.executed) {
        handleSelectMatch(match);
      }
    }
  }, [searchParams, executableMatches]);

  const handleSelectMatch = async (match: Match) => {
    if (activeHookMatchId.current === match.id) return;
    const sameMatch = selectedMatch?.id === match.id;
    const signatureChanged =
      !!hookData &&
      !!match.signature &&
      hookData.signature.toLowerCase() !== match.signature.toLowerCase();
    if (sameMatch && (hookData || isLoadingHookData) && !signatureChanged) return;
    setSelectedMatch(match);
    setHookData(null);
    setExecutionResult(null);
    setIsLoadingHookData(true);
    activeHookMatchId.current = match.id;

    try {
      const data = await generateHookData(match.id);
      setHookData(data);
      updateMatch(match.id, { signature: data.signature });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to generate hook data';
      toast.error(msg);
    } finally {
      setIsLoadingHookData(false);
      if (activeHookMatchId.current === match.id) {
        activeHookMatchId.current = null;
      }
    }
  };

  const handleExecute = async () => {
    if (!hookData) return;
    if (hookDataMismatchReason && selectedMatch) {
      setHookData(null);
      setExecutionResult(null);
      void handleSelectMatch(selectedMatch);
      toast.error('Hook data does not match the selected trade. Please try again.');
      return;
    }

    setIsExecuting(true);
    setExecutionResult(null);
    try {
      const result = await executeTradeWithProof(hookData);
      setExecutionResult(result);
      if (result.success) {
        setShowConfetti(true);
        toast.success('Trade executed successfully!');
        if (selectedMatch) {
          updateMatch(selectedMatch.id, {
            executed: true,
            executedAt: new Date(),
            executionTxHash: result.txHash,
          });
        }
      } else if (isExecutionFailure(result)) {
        toast.error(result.message);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Execution failed';
      setExecutionResult({ success: false, error: 'execution_failed', message: msg });
      toast.error(msg);
    } finally {
      setIsExecuting(false);
    }
  };

  if (!wallet.connected) {
    return (
      <div className="container py-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md mx-auto text-center"
        >
          <h1 className="font-serif text-3xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-muted-foreground mb-8">
            Connect your wallet to execute matched trades.
          </p>
          <Button onClick={connectWallet} size="lg" className="press-scale amber-glow">
            Connect Wallet
          </Button>
        </motion.div>
      </div>
    );
  }

  const connectedAddress = wallet.address?.toLowerCase() ?? null;
  const traderAddress = hookData?.trader?.toLowerCase() ?? null;
  const canExecuteAsTrader = hookData ? connectedAddress === traderAddress : true;
  const hookDataMismatchReason = (() => {
    if (!hookData || !selectedMatch) return null;
    if (hookData.matchId !== selectedMatch.id) return 'match';
    if (hookData.tokenIn.toLowerCase() !== selectedMatch.tokenIn.address.toLowerCase()) return 'tokenIn';
    if (hookData.tokenOut.toLowerCase() !== selectedMatch.tokenOut.address.toLowerCase()) return 'tokenOut';
    const hookAmountIn = normalizeAmount(hookData.amountIn);
    const matchAmountIn = normalizeAmount(selectedMatch.amountIn);
    if (hookAmountIn === null || matchAmountIn === null || hookAmountIn !== matchAmountIn) return 'amountIn';
    const hookMinOut = normalizeAmount(hookData.minAmountOut);
    const matchMinOut = normalizeAmount(selectedMatch.minAmountOut);
    if (hookMinOut === null || matchMinOut === null || hookMinOut !== matchMinOut) return 'minAmountOut';
    return null;
  })();
  const isHookDataAligned = !hookDataMismatchReason;

  return (
    <div className="container py-8 md:py-12">
      <Confetti trigger={showConfetti} onComplete={() => setShowConfetti(false)} />
      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-3xl mx-auto space-y-8"
      >
        <div>
          <h1 className="font-serif text-3xl md:text-4xl font-bold">Execute Trade</h1>
          <p className="text-muted-foreground mt-1">
            Execute matched trades via Uniswap v4 hooks
          </p>
        </div>

        {/* Match Selector */}
        <Card className="bg-transparent border-0 shadow-none">
          <CardHeader>
            <CardTitle className="font-serif">Select Match</CardTitle>
          </CardHeader>
          <CardContent>
            {executableMatches.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No executable matches available
              </div>
            ) : (
              <div className="grid gap-3">
                {executableMatches.map((match) => {
                  const side = getMatchSide(match.id);
                  const isMatchDisabled = match.executed;
                  return (
                  <button
                    key={match.id}
                    disabled={isMatchDisabled}
                    onClick={() => handleSelectMatch(match)}
                    className={`w-full p-4 rounded-xl text-left transition-all border border-transparent ${
                      selectedMatch?.id === match.id
                        ? 'bg-primary/5 border-primary/20'
                        : isMatchDisabled
                          ? 'opacity-50 cursor-not-allowed'
                          : 'hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                          {side && (
                            <span className={`px-2 py-0.5 rounded-full border ${
                              side === 'Buy' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'
                            }`}>
                              {side}
                            </span>
                          )}
                          {match.executed && (
                            <span className="px-2 py-0.5 rounded-full border border-border/60 text-[10px] uppercase tracking-wider">
                              Executed
                            </span>
                          )}
                          <span className="font-mono">Match {formatMatchId(match)}</span>
                        </div>
                        <div className="flex items-center gap-2 text-base font-semibold">
                          <span>{match.tokenIn.symbol}</span>
                          <ArrowRight className="w-4 h-4 text-muted-foreground" />
                          <span>{match.tokenOut.symbol}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Round {truncateAddress(match.roundId, 6)}
                        </div>
                      </div>
                      <div className="text-right space-y-1">
                        <div className="text-xs text-muted-foreground">You Pay</div>
                        <div className="font-mono font-semibold">
                          {formatTokenAmount(match.amountIn, match.tokenIn.decimals)} {match.tokenIn.symbol}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Min receive {formatTokenAmount(match.minAmountOut, match.tokenOut.decimals)} {match.tokenOut.symbol}
                        </div>
                      </div>
                    </div>
                  </button>
                );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Hook Data Inspector */}
        {/* {(selectedMatch || hookData || isLoadingHookData) && (
          <>
            <div className="h-px bg-white/[0.06]" />
            
            <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {isLoadingHookData ? (
              <Card className="bg-transparent border-0 shadow-none">
                <CardContent className="py-12 text-center">
                  <Loader2 className="w-8 h-8 mx-auto animate-spin text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">Generating hook data...</p>
                </CardContent>
              </Card>
            ) : hookData ? (
              <HookDataInspector hookData={hookData} />
            ) : null}
          </motion.div>
          </>
        )} */}

        {/* Execution Panel */}
        {hookData && (
          <>
            {/* Divider */}
            <div className="h-px bg-white/[0.06]" />
            
            <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="bg-transparent border-0 shadow-none">
              <CardHeader>
                <CardTitle className="font-serif">Execution</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!canExecuteAsTrader && (
                  <div className="p-4 rounded-lg border border-destructive/20 bg-destructive/10 text-sm">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-destructive mt-0.5" />
                      <div className="space-y-1">
                        <div className="font-medium text-destructive">Wrong wallet connected</div>
                        <div className="text-muted-foreground">
                          Connect as {truncateAddress(hookData.trader, 6)} to execute this match.
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {hookDataMismatchReason && (
                  <div className="p-4 rounded-lg border border-amber-400/20 bg-amber-500/10 text-sm">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-300 mt-0.5" />
                      <div className="space-y-1">
                        <div className="font-medium text-amber-200">Hook data mismatch</div>
                        <div className="text-muted-foreground">
                          The hook payload doesn’t match the selected trade. Reselect the match to regenerate.
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {/* Match Summary */}
                <div className="p-4 rounded-lg bg-secondary/50">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground">You Pay</div>
                      <div className="font-mono font-semibold text-lg">
                        {selectedMatch ? (
                          <>
                            {formatTokenAmount(selectedMatch.amountIn, selectedMatch.tokenIn.decimals)} {selectedMatch.tokenIn.symbol}
                          </>
                        ) : (
                          <>{hookData.amountIn}</>
                        )}
                      </div>
                      {!selectedMatch && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Token: {truncateAddress(hookData.tokenIn, 6)}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-muted-foreground">You Receive (min)</div>
                      <div className="font-mono font-semibold text-lg text-primary">
                        {selectedMatch ? (
                          <>
                            {formatTokenAmount(selectedMatch.minAmountOut, selectedMatch.tokenOut.decimals)} {selectedMatch.tokenOut.symbol}
                          </>
                        ) : (
                          <>{hookData.minAmountOut}</>
                        )}
                      </div>
                      {!selectedMatch && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Token: {truncateAddress(hookData.tokenOut, 6)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    Expires: {(selectedMatch?.expiry ?? new Date(hookData.expiry * 1000)).toLocaleString()}
                  </div>
                </div>

                {/* Execute Button */}
                <Button
                  onClick={handleExecute}
                  disabled={
                    isExecuting ||
                    selectedMatch?.executed === true ||
                    executionResult?.success === true ||
                    !canExecuteAsTrader ||
                    !isHookDataAligned
                  }
                  size="lg"
                  className="w-full press-scale amber-glow"
                >
                  {isExecuting ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Executing...
                    </>
                  ) : executionResult?.success || selectedMatch?.executed ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 mr-2" />
                      Executed
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5 mr-2" />
                      Execute via Uniswap v4 Hook
                    </>
                  )}
                </Button>

                {/* Execution Result */}
                {executionResult && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={`p-4 rounded-lg border ${
                      executionResult.success
                        ? 'bg-green-500/10 border-green-500/20'
                        : 'bg-destructive/10 border-destructive/20'
                    }`}
                  >
                    {executionResult.success ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-green-500 font-medium">
                          <CheckCircle2 className="w-5 h-5" />
                          Trade Executed Successfully!
                        </div>
                        <div className="text-sm space-y-1">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Amount Received:</span>
                            <span className="font-mono font-medium">
                              {executionResult.amountOut} {selectedMatch?.tokenOut.symbol ?? ''}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Transaction:</span>
                            <span className="font-mono text-xs">
                              {truncateAddress(executionResult.txHash, 8)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-destructive font-medium">
                          <XCircle className="w-5 h-5" />
                          Execution Failed
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {'message' in executionResult ? executionResult.message : 'An error occurred'}
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
