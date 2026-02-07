import { useEffect, useState, useRef } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { Link } from 'react-router-dom';
import { 
  Copy, 
  Check, 
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Wallet,
  TrendingUp,
  Clock,
  Zap,
  Sparkles,
  Activity
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/stores/useStore';
import { truncateAddress } from '@/lib/utils';
import { IntentStatusPill } from '@/components/common/IntentStatusPill';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { fetchConfiguredTokenBalancesFor } from '@/services/shadowPool';

function formatFixedDp(value: string, dp: number): string {
  const trimmed = value.trim();
  if (trimmed === '') return value;
  const sign = trimmed.startsWith('-') ? '-' : '';
  const raw = sign ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(raw)) return value;

  const [intRaw, fracRaw = ''] = raw.split('.');
  const intPart = (intRaw ?? '0').replace(/^0+(?=\d)/, '') || '0';
  const fracPad = fracRaw.padEnd(dp + 1, '0');
  const fracMain = fracPad.slice(0, dp);
  const nextDigit = fracPad[dp] ?? '0';

  const scale = 10n ** BigInt(dp);
  const digits = (intPart + fracMain).replace(/^0+(?=\d)/, '') || '0';
  let scaled = BigInt(digits);
  if (nextDigit >= '5') scaled += 1n;

  const intOut = scaled / scale;
  if (dp === 0) return sign + intOut.toString();
  const fracOut = scaled % scale;
  return sign + intOut.toString() + '.' + fracOut.toString().padStart(dp, '0');
}

function formatTokenBalance(value: string | null): string {
  if (!value) return '-';
  return formatFixedDp(value, 3);
}

// 3D Tilt Card Component
function TiltCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [8, -8]), { stiffness: 300, damping: 30 });
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-8, 8]), { stiffness: 300, damping: 30 });
  
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    x.set((e.clientX - centerX) / rect.width);
    y.set((e.clientY - centerY) / rect.height);
  };
  
  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };
  
  return (
    <motion.div
      ref={ref}
      style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0 },
};

export default function Dashboard() {
  const { wallet, intents, rounds, connectWallet } = useStore();
  const [copied, setCopied] = useState(false);
  const [tokenBalances, setTokenBalances] = useState<
    Array<{ address: `0x${string}`; symbol: string | null; name: string | null; balance: string | null }>
  >([]);
  const [tokenBalancesStatus, setTokenBalancesStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const copyAddress = async () => {
    if (wallet.address) {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const now = Date.now();
  const isPostEndMatching = (round: (typeof rounds)[number]) =>
    round.phase === 'matching' && round.endTime.getTime() <= now;
  const isExecutableExpired = (round: (typeof rounds)[number]) =>
    (round.phase === 'executable' || round.phase === 'posted') &&
    !!round.rootValidUntil &&
    round.rootValidUntil.getTime() <= now;
  const activeRounds = rounds.filter(
    r => r.phase !== 'completed' && !isPostEndMatching(r) && !isExecutableExpired(r)
  );
  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const scopedIntents = walletAddress
    ? intents.filter((i) => (i.trader ?? '').toLowerCase() === walletAddress)
    : [];
  const userIntents = scopedIntents.slice(0, 5);

  useEffect(() => {
    if (!wallet.connected) return;
    let cancelled = false;
    const run = async () => {
      try {
        setTokenBalancesStatus('loading');
        if (!wallet.address) {
          setTokenBalances([]);
          setTokenBalancesStatus('ready');
          return;
        }
        const rows = await fetchConfiguredTokenBalancesFor(wallet.address);
        const normalized = rows.map((r) => ({
          address: r.address as `0x${string}`,
          symbol: r.symbol,
          name: r.name,
          balance: r.balance,
        }));
        if (cancelled) return;
        setTokenBalances(normalized);
        setTokenBalancesStatus('ready');
      } catch {
        if (cancelled) return;
        setTokenBalancesStatus('error');
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.address]);

  if (!wallet.connected) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center relative">
        {/* Background effects */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,hsla(220,10%,75%,0.06),transparent)]" />
        
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-center max-w-lg px-6 relative z-10"
        >
          <motion.div 
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 15 }}
            className="w-24 h-24 rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mx-auto mb-8 shadow-[0_0_60px_hsla(220,10%,75%,0.15)]"
          >
            <Wallet className="w-12 h-12 text-primary" />
          </motion.div>
          <h1 className="font-serif text-5xl md:text-6xl font-bold mb-6">
            Connect Your
            <br />
            <span className="bg-gradient-to-r from-zinc-200 via-slate-300 to-zinc-400 bg-clip-text text-transparent">
              Wallet
            </span>
          </h1>
          <p className="text-muted-foreground text-xl mb-10 leading-relaxed">
            Connect your wallet to view your intents and trading activity.
          </p>
          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Button 
              onClick={connectWallet} 
              size="lg" 
              className="relative overflow-hidden text-lg px-12 py-8 rounded-2xl font-bold bg-gradient-to-r from-zinc-300 via-slate-200 to-zinc-400 text-zinc-900 shadow-[0_0_40px_hsla(220,10%,75%,0.25)] hover:shadow-[0_0_60px_hsla(220,10%,85%,0.4)] transition-shadow duration-500"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full hover:translate-x-full transition-transform duration-700" />
              <span className="relative">Connect Wallet</span>
            </Button>
          </motion.div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 relative">
      {/* Background gradients */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-[70vh] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsla(220,10%,75%,0.08),transparent)]" />
        <div className="absolute bottom-0 left-0 right-0 h-[50vh] bg-[radial-gradient(ellipse_60%_40%_at_70%_100%,hsla(220,15%,60%,0.04),transparent)]" />
      </div>
      
      <div className="container px-6 py-12 relative z-10">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-8"
        >
          {/* Header */}
          <motion.div variants={itemVariants} className="flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
                className="flex items-center gap-2 mb-3"
              >
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-xs tracking-[0.2em] text-primary/70 uppercase font-semibold">Command Center</span>
              </motion.div>
              <h1 className="font-serif text-5xl md:text-6xl font-bold">Dashboard</h1>
            </div>
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Link to="/create">
                <Button className="relative overflow-hidden px-8 py-6 rounded-xl font-bold bg-gradient-to-r from-zinc-400/90 via-slate-300 to-zinc-400/90 text-zinc-900 shadow-[0_0_30px_hsla(220,10%,75%,0.2)] hover:shadow-[0_0_40px_hsla(220,10%,85%,0.35)] transition-all duration-300">
                  <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full hover:translate-x-full transition-transform duration-500" />
                  <Plus className="w-5 h-5 mr-2" />
                  <span className="relative">New Intent</span>
                </Button>
              </Link>
            </motion.div>
          </motion.div>

          {/* Wallet Card - Premium 3D */}
          <motion.div variants={itemVariants}>
            <TiltCard className="perspective-1000">
              <div className="relative overflow-hidden rounded-3xl p-1 bg-transparent">
                <div className="relative overflow-hidden rounded-[22px] bg-transparent p-8 lg:p-10">
                  {/* Ambient glow */}
                  <div className="absolute top-0 right-0 w-96 h-96 bg-[radial-gradient(circle,hsla(220,10%,75%,0.12),transparent_50%)] blur-3xl" />
                  <div className="absolute bottom-0 left-0 w-64 h-64 bg-[radial-gradient(circle,hsla(220,15%,60%,0.06),transparent_50%)] blur-3xl" />
                  
                  {/* Grid pattern */}
                  <div className="absolute inset-0 bg-grid opacity-20" />
                  
                  <div className="relative grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                    <div>
                      <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                        Balance
                      </div>
                      <div className="font-mono text-3xl md:text-4xl font-bold">
                        {wallet.balance}
                        <span className="text-muted-foreground text-lg md:text-xl ml-2">ETH</span>
                      </div>
                    </div>
                    <div className="border-t md:border-t-0 md:border-l border-white/[0.06] pt-6 md:pt-0 md:pl-8">
                      <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
                        <Sparkles className="w-3 h-3" />
                        Vouchers
                      </div>
                      <div className="font-mono text-3xl md:text-4xl font-bold text-primary">
                        {wallet.voucherBalance}
                        <span className="text-muted-foreground text-lg md:text-xl ml-2">RLC</span>
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-8 pt-8 border-t border-white/[0.06] space-y-4">
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                      Tokens
                    </div>
                    {tokenBalancesStatus === 'loading' ? (
                      <div className="text-sm text-muted-foreground">Loading...</div>
                    ) : tokenBalancesStatus === 'error' ? (
                      <div className="text-sm text-muted-foreground">Failed to load</div>
                    ) : tokenBalances.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No tokens</div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {tokenBalances.map((t, index) => (
                          <div
                            key={t.address}
                            className={[
                              'flex items-center justify-between gap-4 px-2 py-2',
                              index > 0 ? 'border-t border-white/[0.06] pt-4' : '',
                              index > 0 ? 'sm:border-t-0 sm:pt-2' : '',
                              index >= 2 ? 'sm:border-t sm:border-white/[0.06] sm:pt-4' : '',
                              index % 2 === 1 ? 'sm:border-l sm:border-white/[0.06] sm:pl-6' : '',
                            ].filter(Boolean).join(' ')}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-semibold truncate">
                                {t.symbol ?? 'Unknown'}
                                {t.name ? <span className="text-muted-foreground"> — {t.name}</span> : null}
                              </div>
                            </div>
                            <div className="font-mono text-lg font-bold">
                              {formatTokenBalance(t.balance)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </TiltCard>
          </motion.div>

          {/* Stats Grid - Glowing cards */}
          <motion.div variants={itemVariants} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Intents', value: scopedIntents.length, icon: TrendingUp, iconColor: 'text-slate-300' },
              { label: 'Active', value: scopedIntents.filter(i => ['protected', 'granted', 'submitted'].includes(i.status)).length, icon: Zap, iconColor: 'text-primary' },
              { label: 'Executed', value: scopedIntents.filter(i => i.status === 'executed').length, icon: Check, iconColor: 'text-slate-200' },
              { label: 'In Rounds', value: activeRounds.length, icon: Clock, iconColor: 'text-zinc-300' },
            ].map((stat, index) => (
              <motion.div
                key={stat.label}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
                className="relative overflow-hidden rounded-2xl bg-transparent border-0 p-6 group"
              >
                {/* Hover glow */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(200px_circle_at_50%_50%,hsla(220,10%,75%,0.08),transparent)]" />
                
                <div className="relative z-10">
                  <div className="flex items-center justify-between mb-4">
                    <stat.icon className={`w-5 h-5 ${stat.iconColor}`} />
                  </div>
                  <div className="font-mono text-4xl font-bold mb-1">{stat.value}</div>
                  <div className="text-sm text-muted-foreground">{stat.label}</div>
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* Divider */}
          <motion.div variants={itemVariants} className="h-px bg-white/[0.06]" />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            {/* My Intents */}
            <motion.div variants={itemVariants} className="xl:col-span-2">
              <div className="relative overflow-hidden rounded-3xl border-0 bg-transparent">
                <div className="absolute inset-0 bg-grid opacity-10" />
                
                <div className="relative flex items-center justify-between p-6 lg:p-8 border-b border-white/[0.05]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center">
                      <TrendingUp className="w-5 h-5 text-primary" />
                    </div>
                    <h2 className="font-serif text-2xl font-bold">My Intents</h2>
                  </div>
                  <Link 
                    to="/create" 
                    className="text-sm text-primary hover:text-primary/80 flex items-center gap-1 font-semibold transition-colors"
                  >
                    View all <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
                
                <div className="relative divide-y divide-white/[0.03]">
                  {userIntents.length === 0 ? (
                    <div className="p-16 text-center">
                      <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                        <Plus className="w-8 h-8 text-muted-foreground" />
                      </div>
                      <p className="text-muted-foreground text-lg mb-6">No intents yet</p>
                      <Button asChild className="rounded-xl">
                        <Link to="/create">Create your first intent</Link>
                      </Button>
                    </div>
                  ) : (
                    userIntents.map((intent, index) => (
                      <motion.div
                        key={intent.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.4 + index * 0.05 }}
                        whileHover={{ backgroundColor: "rgba(255,255,255,0.02)" }}
                        className="flex items-center gap-4 p-4 md:p-5 lg:p-6 group cursor-pointer transition-colors"
                      >
                        <div className={`p-2.5 md:p-3 rounded-xl shrink-0 ${intent.side === 'buy' ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                          {intent.side === 'buy' ? (
                            <ArrowDownRight className="w-4 h-4 md:w-5 md:h-5 text-emerald-400" />
                          ) : (
                            <ArrowUpRight className="w-4 h-4 md:w-5 md:h-5 text-red-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <span className={`font-semibold text-base md:text-lg ${intent.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {intent.side.toUpperCase()}
                            </span>
                            <span className="font-semibold text-base md:text-lg">
                              {intent.tokenPair.base.symbol}/{intent.tokenPair.quote.symbol}
                            </span>
                          </div>
                          <span className="text-xs md:text-sm text-muted-foreground font-mono">
                            {intent.amount} @ {intent.limitPrice}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <IntentStatusPill status={intent.status} size="sm" />
                          <ChevronRight className="w-5 h-5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all hidden md:block" />
                        </div>
                      </motion.div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>

            {/* Vertical divider on desktop, horizontal on mobile */}
            <div className="hidden xl:block w-px bg-white/[0.06] mx-4" />
            <div className="xl:hidden h-px bg-white/[0.06] my-4" />

            {/* Active Rounds */}
            <motion.div variants={itemVariants}>
              <div className="relative overflow-hidden rounded-3xl border-0 bg-transparent">
                <div className="absolute inset-0 bg-grid opacity-10" />
                
                <div className="relative flex items-center justify-between p-6 border-b border-white/[0.05]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center">
                      <Clock className="w-5 h-5 text-primary" />
                    </div>
                    <h2 className="font-serif text-xl font-bold">Active Rounds</h2>
                  </div>
                  <Link 
                    to="/rounds" 
                    className="text-sm text-primary hover:text-primary/80 flex items-center gap-1 font-semibold transition-colors"
                  >
                    All <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
                
                <div className="relative p-4 space-y-3">
                  {activeRounds.map((round, index) => (
                    <motion.div
                      key={round.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5 + index * 0.1 }}
                    >
                      <Link
                        to={`/round/${round.id}`}
                        className="block p-5 rounded-2xl bg-transparent border-0 transition-all duration-300 group"
                      >
                        <div className="flex items-center justify-between mb-4">
                          <span className="font-mono font-bold text-lg">{round.id}</span>
                          <span className="text-xs px-3 py-1.5 rounded-full bg-primary/10 text-primary capitalize font-semibold border border-primary/20">
                            {round.phase}
                          </span>
                        </div>
                        <CountdownTimer
                          endTime={
                            round.phase === 'executable' || round.phase === 'posted'
                              ? round.rootValidUntil ?? null
                              : round.endTime
                          }
                          variant="bar"
                          size="sm"
                        />
                        <div className="flex justify-between mt-4 text-sm text-muted-foreground">
                          <span>{round.intentsCount} intents</span>
                          <span className="text-primary">{round.matchedCount} matched</span>
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
