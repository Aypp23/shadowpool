import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  LayoutDashboard, 
  PlusCircle, 
  Clock, 
  Zap, 
  Settings,
  Wallet,
  LogOut,
  Menu,
  X,
  ChevronRight,
  Copy,
  Check,
  Sparkles
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useStore } from '@/stores/useStore';
import { truncateAddress } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/create', label: 'Create', icon: PlusCircle },
  { path: '/rounds', label: 'Rounds', icon: Clock },
  { path: '/execute', label: 'Execute', icon: Zap },
  { path: '/settings', label: 'Faucet', icon: Settings },
];

export function Header() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { wallet, connectWallet, disconnectWallet } = useStore();
  const [copied, setCopied] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
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

  const isHome = location.pathname === '/';

  useEffect(() => {
    if (!walletOpen) return;
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
  }, [walletOpen, wallet.connected, wallet.address]);

  return (
    <header className={cn(
      "fixed top-0 left-0 right-0 z-50 transition-all duration-500",
      isHome 
        ? "bg-transparent" 
        : "bg-background/60 backdrop-blur-2xl border-b border-white/[0.04]"
    )}>
      <div className="container flex items-center justify-between h-20 px-6">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 group">
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            className="relative w-11 h-11 rounded-xl overflow-hidden bg-black/20"
          >
            <img
              src="/brand/shadowpool-mark.png"
              alt="ShadowPool"
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
            {/* Ambient glow */}
            <div className="absolute -inset-1 bg-primary/30 blur-lg -z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </motion.div>
          <div className="hidden sm:block">
            <span className="font-serif font-bold text-xl tracking-tight">
              Shadow<span className="bg-gradient-to-r from-amber-300 via-primary to-amber-400 bg-clip-text text-transparent">Pool</span>
            </span>
          </div>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden lg:flex items-center gap-8">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path || 
              (item.path !== '/' && location.pathname.startsWith(item.path));
            
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "text-sm font-medium transition-colors duration-200",
                  isActive 
                    ? "text-foreground" 
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Wallet & Mobile Menu */}
        <div className="flex items-center gap-3">
          {wallet.connected ? (
            <Popover open={walletOpen} onOpenChange={setWalletOpen}>
              <PopoverTrigger asChild>
                <motion.button 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-white/[0.03] border border-white/[0.06] hover:border-white/[0.12] transition-all"
                >
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_hsla(155,70%,50%,0.5)]" />
                  <span className="font-mono text-sm font-medium">{truncateAddress(wallet.address!, 4)}</span>
                </motion.button>
              </PopoverTrigger>
              <PopoverContent 
                className="w-72 p-4 bg-background border border-white/[0.08]" 
                align="end"
                sideOffset={8}
              >
                <div className="space-y-4">
                  {/* Address */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-sm text-muted-foreground">{wallet.network}</span>
                    </div>
                    <button
                      onClick={copyAddress}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                  
                  <div className="font-mono text-xs px-3 py-2 w-full text-center break-all">
                    {wallet.address}
                  </div>

                  {/* Balances */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3">
                      <div className="text-xs text-muted-foreground mb-1">Balance</div>
                      <div className="font-mono font-semibold">{wallet.balance} ETH</div>
                    </div>
                    <div className="p-3">
                      <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        Vouchers
                      </div>
                      <div className="font-mono font-semibold text-primary">{wallet.voucherBalance} RLC</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">Tokens</div>
                    {tokenBalancesStatus === 'loading' ? (
                      <div className="text-xs text-muted-foreground">Loading...</div>
                    ) : tokenBalancesStatus === 'error' ? (
                      <div className="text-xs text-muted-foreground">Failed to load</div>
                    ) : tokenBalances.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No tokens</div>
                    ) : (
                      <div className="space-y-2">
                        {tokenBalances.map((t) => (
                          <div key={t.address} className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {t.symbol ?? 'Unknown'}
                                {t.name ? <span className="text-muted-foreground"> — {t.name}</span> : null}
                              </div>
                            </div>
                            <div className="font-mono text-sm font-semibold">
                              {formatTokenBalance(t.balance)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Disconnect */}
                  <Button 
                    variant="ghost" 
                    onClick={disconnectWallet}
                    className="w-full justify-center gap-2 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <LogOut className="w-4 h-4" />
                    Disconnect
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button 
                onClick={connectWallet}
                className="relative overflow-hidden px-6 py-5 rounded-xl font-semibold bg-gradient-to-r from-zinc-400/90 via-slate-300 to-zinc-400/90 text-zinc-900 shadow-[0_0_25px_hsla(220,10%,75%,0.25)] hover:shadow-[0_0_35px_hsla(220,10%,85%,0.4)] transition-shadow duration-300"
              >
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full hover:translate-x-full transition-transform duration-500" />
                <Wallet className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Connect Wallet</span>
                <span className="sm:hidden">Connect</span>
              </Button>
            </motion.div>
          )}

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden rounded-xl border border-white/[0.06] bg-white/[0.02]"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            <AnimatePresence mode="wait">
              {mobileMenuOpen ? (
                <motion.div
                  key="close"
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <X className="w-5 h-5" />
                </motion.div>
              ) : (
                <motion.div
                  key="menu"
                  initial={{ rotate: 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: -90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Menu className="w-5 h-5" />
                </motion.div>
              )}
            </AnimatePresence>
          </Button>
        </div>
      </div>

      {/* Mobile Navigation */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="lg:hidden overflow-hidden bg-background/95 backdrop-blur-2xl border-t border-white/[0.04]"
          >
            <nav className="container py-6 px-6 space-y-2">
              {navItems.map((item, index) => {
                const isActive = location.pathname === item.path;
                return (
                  <motion.div
                    key={item.path}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <Link
                      to={item.path}
                      onClick={() => setMobileMenuOpen(false)}
                      className={cn(
                        "flex items-center justify-between px-5 py-4 rounded-xl transition-all",
                        isActive 
                          ? "bg-gradient-to-r from-primary/10 to-transparent text-primary border border-primary/20" 
                          : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "p-2.5 rounded-lg",
                          isActive ? "bg-primary/20" : "bg-white/[0.03]"
                        )}>
                          <item.icon className="w-5 h-5" />
                        </div>
                        <span className="font-medium">{item.label}</span>
                      </div>
                      <ChevronRight className={cn(
                        "w-4 h-4 transition-transform",
                        isActive ? "text-primary" : "opacity-40"
                      )} />
                    </Link>
                  </motion.div>
                );
              })}
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
