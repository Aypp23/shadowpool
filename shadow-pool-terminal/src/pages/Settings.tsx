import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Shield, 
  Sliders, 
  Info
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { useStore } from '@/stores/useStore';
import { ActionLog } from '@/components/common/ActionLog';
import { faucetMintTestTokens, fetchErc20TokenMetadata, getConfiguredTokenAddresses } from '@/services/shadowPool';
import { toast } from 'sonner';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

export default function Settings() {
  const { wallet, settings, adminActions, updateSettings } = useStore();
  const tokenAddresses = useMemo(() => getConfiguredTokenAddresses(), []);
  const [faucetAmount, setFaucetAmount] = useState(1000);
  const [isFauceting, setIsFauceting] = useState(false);
  const [faucetResults, setFaucetResults] = useState<Array<{ token: string; txHash: string }>>([]);
  const [tokenInfos, setTokenInfos] = useState<
    Array<{ address: `0x${string}`; symbol: string | null; name: string | null; status: 'ok' | 'no_contract' | 'read_failed'; error: string | null }>
  >([]);
  const [tokenInfoStatus, setTokenInfoStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    if (!wallet.connected || tokenAddresses.length === 0) {
      setTokenInfos([]);
      setTokenInfoStatus('idle');
      return;
    }

    let cancelled = false;

    const run = async () => {
      setTokenInfoStatus('loading');
      const infos = await fetchErc20TokenMetadata(tokenAddresses);
      const normalized = infos.map((x) => ({
        address: x.address as `0x${string}`,
        symbol: x.symbol,
        name: x.name,
        status: x.status,
        error: x.error,
      }));
      if (!cancelled) setTokenInfos(normalized);
      if (!cancelled) setTokenInfoStatus('ready');
    };

    run().catch(() => {
      if (!cancelled) {
        setTokenInfos([]);
        setTokenInfoStatus('error');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [tokenAddresses, wallet.connected]);

  const handleFaucet = async () => {
    setIsFauceting(true);
    try {
      const res = await faucetMintTestTokens({ amount: String(faucetAmount) });
      setFaucetResults(res.minted.map((m) => ({ token: m.token, txHash: m.txHash })));
      toast.success('Minted test tokens');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Faucet failed';
      toast.error(msg);
    } finally {
      setIsFauceting(false);
    }
  };

  return (
    <div className="container py-8 md:py-12">
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="max-w-3xl mx-auto space-y-8"
      >
        <motion.div variants={itemVariants}>
          <h1 className="font-serif text-3xl md:text-4xl font-bold">Faucet</h1>
          <p className="text-muted-foreground mt-1">
            Mint test tokens to your connected wallet
          </p>
        </motion.div>

        {/* Faucet */}
        <motion.div variants={itemVariants}>
          <Card className="bg-transparent border-0 shadow-none">
            <CardHeader>
              <CardTitle className="font-serif flex items-center gap-2">
                <Sliders className="w-5 h-5" />
                Faucet
              </CardTitle>
              <CardDescription>
                Mint test tokens to your connected wallet
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!wallet.connected ? (
                <p className="text-sm text-muted-foreground">
                  Connect your wallet to use the faucet.
                </p>
              ) : tokenAddresses.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tokens configured. Set VITE_TOKEN_A_ADDRESS and VITE_TOKEN_B_ADDRESS.
                </p>
              ) : (
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="font-medium">
                        Amount per token
                      </Label>
                      <span className="font-mono text-sm text-muted-foreground">
                        {faucetAmount}
                      </span>
                    </div>
                    <Slider
                      value={[faucetAmount]}
                      min={10}
                      max={1000}
                      step={10}
                      onValueChange={(v) => setFaucetAmount(v[0] ?? 1000)}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">
                      Tokens
                    </div>
                    {tokenInfoStatus === 'loading' && (
                      <div className="text-xs text-muted-foreground">
                        Loading token metadata...
                      </div>
                    )}
                    {tokenInfoStatus === 'error' && (
                      <div className="text-xs text-muted-foreground">
                        Could not fetch token metadata (wrong network or RPC).
                      </div>
                    )}
                    <div className="space-y-1">
                      {tokenAddresses.map((a) => {
                        const info = tokenInfos.find((t) => t.address.toLowerCase() === a.toLowerCase());
                        const label = info?.symbol && info?.name ? `${info.symbol} — ${info.name}` : null;
                        const statusLine =
                          info?.status === 'no_contract'
                            ? `No contract on ${wallet.network}`
                            : info?.status === 'read_failed'
                              ? `Failed to read metadata on ${wallet.network}`
                              : null;
                        return (
                          <div key={a} className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {label ?? (tokenInfoStatus === 'loading' ? 'Loading...' : 'Unknown token')}
                              </div>
                              {statusLine && (
                                <div className="text-xs text-muted-foreground truncate">
                                  {statusLine}
                                </div>
                              )}
                              <div className="font-mono text-xs text-muted-foreground truncate">
                                {a}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={handleFaucet}
                      disabled={isFauceting}
                      className="press-scale amber-glow"
                    >
                      {isFauceting ? 'Minting...' : 'Mint Test Tokens'}
                    </Button>
                  </div>

                  {faucetResults.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">
                        Latest mints
                      </div>
                      <div className="space-y-1">
                        {faucetResults.map((r) => (
                          <div key={`${r.token}-${r.txHash}`} className="flex items-center justify-between gap-4 text-xs">
                            <span className="font-mono text-muted-foreground">
                              {tokenInfos.find((t) => t.address.toLowerCase() === r.token.toLowerCase())?.symbol ??
                                `${r.token.slice(0, 10)}...${r.token.slice(-8)}`}
                            </span>
                            <span className="font-mono text-primary">
                              {r.txHash.slice(0, 10)}...{r.txHash.slice(-8)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Divider */}
        <motion.div variants={itemVariants} className="h-px bg-white/[0.06]" />

        {/* Admin Mode */}
        {wallet.connected && wallet.isAdmin && (
          <motion.div variants={itemVariants}>
          <Card className="bg-transparent border-0 shadow-none">
            <CardHeader>
              <CardTitle className="font-serif flex items-center gap-2 text-primary">
                <Shield className="w-5 h-5" />
                Admin Mode
                </CardTitle>
                <CardDescription>
                  Enable keeper and admin console features
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="admin-mode" className="font-medium">
                      Enable Admin Console
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Access TEE operations, batch ingest, and root posting
                    </p>
                  </div>
                  <Switch
                    id="admin-mode"
                    checked={settings.adminModeEnabled}
                    onCheckedChange={(checked) => 
                      updateSettings({ adminModeEnabled: checked })
                    }
                  />
                </div>

                {settings.adminModeEnabled && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="space-y-4"
                  >
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="auto-run-matching" className="font-medium">
                          Auto-run TEE Matching
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Automatically run matching when a round enters the matching phase
                        </p>
                      </div>
                      <Switch
                        id="auto-run-matching"
                        checked={settings.autoRunMatching}
                        onCheckedChange={(checked) =>
                          updateSettings({ autoRunMatching: checked })
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="auto-post-root" className="font-medium">
                          Auto-post Merkle Root
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Post the merkle root automatically after matching completes
                        </p>
                      </div>
                      <Switch
                        id="auto-post-root"
                        checked={settings.autoPostRoot}
                        onCheckedChange={(checked) =>
                          updateSettings({ autoPostRoot: checked })
                        }
                      />
                    </div>

                    <div className="p-4 rounded-lg">
                      <div className="flex items-start gap-2">
                        <Info className="w-4 h-4 text-primary mt-0.5" />
                        <div className="text-sm">
                          <p className="font-medium text-primary">Admin actions enabled</p>
                          <p className="text-muted-foreground mt-1">
                            You can now run TEE matching, post merkle roots, and manage rounds 
                            from the round detail pages.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Recent Admin Actions */}
                    <div>
                      <h4 className="font-medium mb-3">Recent Actions</h4>
                      <ActionLog actions={adminActions.slice(0, 5)} />
                    </div>
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Divider */}
        <motion.div variants={itemVariants} className="h-px bg-white/[0.06]" />

        {/* About */}
        <motion.div variants={itemVariants}>
          <Card className="bg-transparent border-0 shadow-none">
            <CardContent className="py-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/20 flex items-center justify-center mx-auto mb-4">
                  <span className="font-serif font-bold text-3xl text-primary">S</span>
                </div>
                <h3 className="font-serif text-xl font-bold">ShadowPool</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Confidential Batch Dark Pool Trading
                </p>
                <div className="flex items-center justify-center gap-4 mt-4 text-xs text-muted-foreground">
                  <span>Powered by iExec TEE</span>
                  <span>·</span>
                  <span>Uniswap v4 Hooks</span>
                  <span>·</span>
                  <span>Arbitrum Sepolia</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}
