import { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  ChevronDown, 
  ChevronUp, 
  Shield, 
  Key, 
  Send,
  Loader2,
  Check,
  Wallet,
  Lock
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useStore } from '@/stores/useStore';
import { TokenPair, Intent, Round } from '@/lib/types';
import { generateHexString } from '@/lib/utils';
import { TokenPairPicker } from '@/components/common/TokenPairPicker';
import { AmountInput } from '@/components/common/AmountInput';
import { getIExecAppAddress, protectData, grantAccess, submitToRound } from '@/services/shadowPool';
import { toast } from 'sonner';

type Step = 'form' | 'protect' | 'grant' | 'submit';

const DEFAULT_AUTHORIZED_USER = '0x616A40E6eDA4cd19813ed97871417FC5951a0977';
const ROOT_VALIDITY_SECONDS = Math.max(
  0,
  Number(import.meta.env.VITE_ROOT_VALIDITY_SECONDS ?? 6 * 60 * 60)
);
const MIN_MATCHING_BUFFER_SECONDS = ROOT_VALIDITY_SECONDS;
const POST_END_MATCHING_SECONDS = Math.max(
  0,
  Number(import.meta.env.VITE_POST_END_MATCHING_SECONDS ?? 0)
);

function getMinExpiryForRound(round: Round | null): Date | null {
  if (!round) return null;
  const minMs =
    round.endTime.getTime() +
    (POST_END_MATCHING_SECONDS + MIN_MATCHING_BUFFER_SECONDS) * 1000;
  return new Date(minMs);
}

function formatExpiryDate(value: Date) {
  return value.toLocaleString();
}

const expiryOptions = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '24 hours', value: 24 },
];

export default function CreateIntent() {
  const { wallet, rounds, addIntent, connectWallet } = useStore();
  const [step, setStep] = useState<Step>('form');
  const [isLoading, setIsLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Form state
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [tokenPair, setTokenPair] = useState<TokenPair | null>(null);
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [expiryHours, setExpiryHours] = useState(6);
  const [slippageMin, setSlippageMin] = useState('0.1');
  const [slippageMax, setSlippageMax] = useState('0.5');
  const [notes, setNotes] = useState('');

  // Created intent state
  const [protectedAddress, setProtectedAddress] = useState<string | null>(null);
  const [protectedSalt, setProtectedSalt] = useState<string | null>(null);
  const [protectedExpiry, setProtectedExpiry] = useState<Date | null>(null);
  const [selectedRound, setSelectedRound] = useState<string>('');

  const activeRounds = rounds.filter(r => r.phase !== 'completed');
  const submittableRounds = rounds.filter((r) => r.phase === 'intake');

  const authorizedApp = getIExecAppAddress();

  const handleProtect = async () => {
    if (!tokenPair) {
      toast.error('Please select a token pair');
      return;
    }

    if (!amount || !limitPrice) {
      toast.error('Please fill in amount and limit price');
      return;
    }

    if (!wallet.address) {
      toast.error('Wallet address unavailable');
      return;
    }

    setIsLoading(true);
    setStep('protect');

    try {
      const baseExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
      const selectedRoundRef = selectedRound
        ? rounds.find((r) => r.id === selectedRound) ?? null
        : null;
      const currentIntakeRound =
        selectedRoundRef ??
        rounds
          .filter((r) => r.phase === 'intake')
          .sort((a, b) => b.endTime.getTime() - a.endTime.getTime())[0] ??
        null;
      const minExpiry = getMinExpiryForRound(currentIntakeRound);
      const expiry =
        minExpiry && baseExpiry < minExpiry ? minExpiry : baseExpiry;

      if (minExpiry && baseExpiry < minExpiry) {
        toast.info(
          `Expiry extended to ${formatExpiryDate(
            minExpiry
          )} to cover post-end matching and execution window.`
        );
      }

      const result = await protectData({
        side,
        tokenPair: tokenPair,
        amount,
        limitPrice,
        expiry,
        slippageMin: parseFloat(slippageMin),
        slippageMax: parseFloat(slippageMax),
        notes,
      }, wallet.address);
      
      setProtectedAddress(result.protectedDataAddress);
      setProtectedSalt(result.salt);
      setProtectedExpiry(expiry);
      toast.success('Intent protected successfully');
    } catch (error) {
      const anyErr = error as { shortMessage?: string; message?: string; details?: string };
      const msg = anyErr.shortMessage ?? anyErr.message ?? anyErr.details ?? 'Failed to protect intent';
      toast.error(msg);
      console.error('protectData failed', error);
      setStep('form');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGrantAccess = async () => {
    if (!protectedAddress) return;

    if (!wallet.address) {
      toast.error('Wallet address unavailable');
      return;
    }

    setIsLoading(true);

    try {
      await grantAccess(
        protectedAddress,
        authorizedApp,
        DEFAULT_AUTHORIZED_USER
      );
      toast.success('Access granted successfully');
      setStep('grant');
    } catch (error) {
      const anyErr = error as { shortMessage?: string; message?: string };
      toast.error(anyErr.shortMessage ?? anyErr.message ?? 'Failed to grant access');
      setStep('protect');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitToRound = async () => {
    if (!protectedAddress || !selectedRound) {
      toast.error('Please select a round');
      return;
    }
    const selected = rounds.find((r) => r.id === selectedRound) ?? null;
    if (!selected || selected.phase !== 'intake') {
      toast.error('Round intake window is closed');
      return;
    }
    if (!tokenPair) {
      toast.error('Token pair unavailable');
      return;
    }
    if (!protectedSalt) {
      toast.error('Salt unavailable');
      return;
    }
    const minExpiry = getMinExpiryForRound(selected);
    const expiry = protectedExpiry ?? new Date(Date.now() + expiryHours * 60 * 60 * 1000);
    if (minExpiry && expiry < minExpiry) {
      toast.error(
        `Expiry too short for post-end matching and execution window. Please re-protect with expiry >= ${formatExpiryDate(
          minExpiry
        )}.`
      );
      setStep('protect');
      return;
    }

    setIsLoading(true);
    setStep('submit');

    try {
      await submitToRound(protectedAddress, selectedRound, {
        side,
        baseToken: tokenPair.base.address,
        quoteToken: tokenPair.quote.address,
        baseDecimals: tokenPair.base.decimals,
        amountBase: amount,
        limitPrice,
        expirySeconds: Math.floor(expiry.getTime() / 1000),
        saltBytes32: protectedSalt,
      });
      
      const newIntent: Intent = {
        id: generateHexString(16),
        side,
        trader: wallet.address ?? undefined,
        tokenPair: tokenPair,
        amount,
        limitPrice,
        expiry,
        status: 'submitted',
        createdAt: new Date(),
        protectedDataAddress: protectedAddress,
        authorizedApp,
        authorizedUser: DEFAULT_AUTHORIZED_USER,
        roundId: selectedRound,
        slippageMin: parseFloat(slippageMin),
        slippageMax: parseFloat(slippageMax),
        notes,
      };
      
      addIntent(newIntent);
      toast.success('Intent submitted to round!');
      
      setTimeout(() => {
        setStep('form');
        setProtectedAddress(null);
        setProtectedSalt(null);
        setProtectedExpiry(null);
        setAmount('');
        setLimitPrice('');
        setNotes('');
      }, 2000);
    } catch (error) {
      toast.error('Failed to submit to round');
      setStep('grant');
    } finally {
      setIsLoading(false);
    }
  };

  if (!wallet.connected) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center max-w-md px-6"
        >
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Wallet className="w-10 h-10 text-primary" />
          </div>
          <h1 className="font-serif text-4xl font-bold mb-4">Connect Your Wallet</h1>
          <p className="text-muted-foreground text-lg mb-8">
            Connect your wallet to create a new trading intent.
          </p>
          <Button 
            onClick={connectWallet} 
            size="lg" 
            className="btn-premium glow-gold-intense text-lg px-10 py-6 rounded-xl font-semibold"
          >
            Connect Wallet
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20">
      {/* Hero gradient */}
      <div className="absolute top-0 left-0 right-0 h-[40vh] bg-radial-top pointer-events-none" />
      
      <div className="container px-6 py-12 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl mx-auto"
        >
          <div className="text-center mb-10">
            <h1 className="font-serif text-4xl md:text-5xl font-bold">Create Intent</h1>
            <p className="text-muted-foreground mt-3 text-lg">
              Define your confidential trading parameters
            </p>
          </div>

          <div className="space-y-6">
            {/* Main Form */}
            <div className="rounded-2xl p-8 bg-transparent">
              <h2 className="font-serif text-xl font-semibold mb-6">Intent Details</h2>
              
              <div className="space-y-6">
                {/* Side Toggle */}
                <div className="space-y-3">
                  <Label className="text-sm text-muted-foreground">Side</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setSide('buy')}
                      className={`py-4 rounded-xl font-semibold transition-all ${
                        side === 'buy' 
                          ? 'bg-green-500/20 text-green-400 ring-2 ring-green-500/50' 
                          : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      onClick={() => setSide('sell')}
                      className={`py-4 rounded-xl font-semibold transition-all ${
                        side === 'sell' 
                          ? 'bg-red-500/20 text-red-400 ring-2 ring-red-500/50' 
                          : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      Sell
                    </button>
                  </div>
                </div>

                {/* Token Pair */}
                <div className="space-y-3">
                  <Label className="text-sm text-muted-foreground">Token Pair</Label>
                  <TokenPairPicker value={tokenPair} onChange={setTokenPair} />
                </div>

                {/* Amount & Price */}
                <div className="grid grid-cols-2 gap-4">
                  <AmountInput
                    label="Amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    suffix={tokenPair?.base.symbol}
                  />
                  <AmountInput
                    label="Limit Price"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    placeholder="0.00"
                    suffix={tokenPair?.quote.symbol}
                  />
                </div>

                {/* Expiry */}
                <div className="space-y-3">
                  <Label className="text-sm text-muted-foreground">Expiry</Label>
                  <div className="flex gap-2">
                    {expiryOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setExpiryHours(option.value)}
                        className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${
                          expiryHours === option.value
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Advanced */}
                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <button className="w-full flex items-center justify-between py-3 text-muted-foreground hover:text-foreground transition-colors">
                      <span className="text-sm font-medium">Advanced Settings</span>
                      {advancedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="space-y-4 pt-4 border-t border-border/50"
                    >
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-sm text-muted-foreground">Min Slippage (%)</Label>
                          <Input
                            type="number"
                            value={slippageMin}
                            onChange={(e) => setSlippageMin(e.target.value)}
                            step="0.1"
                            min="0"
                            className="rounded-xl bg-secondary/50 border-border/50"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-sm text-muted-foreground">Max Slippage (%)</Label>
                          <Input
                            type="number"
                            value={slippageMax}
                            onChange={(e) => setSlippageMax(e.target.value)}
                            step="0.1"
                            min="0"
                            className="rounded-xl bg-secondary/50 border-border/50"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm text-muted-foreground">Private Notes</Label>
                        <Textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder="Notes for your reference..."
                          rows={3}
                          className="rounded-xl bg-secondary/50 border-border/50"
                        />
                      </div>
                    </motion.div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-white/[0.06]" />

            {/* Privacy Guarantee */}
            <div className="rounded-2xl p-6 bg-transparent">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Privacy Guarantee</h3>
                  <p className="text-sm text-muted-foreground">
                    Your limit price, size, and strategy are encrypted with iExec DataProtector. 
                    Only the TEE can access your parameters during matching.
                  </p>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-white/[0.06]" />

            {/* Submit Flow */}
            <div className="rounded-2xl p-8 bg-transparent">
              <h2 className="font-serif text-xl font-semibold mb-6">Submit Intent</h2>
              
              <div className="space-y-4">
                {/* Step 1: Protect */}
                <div className={`p-5 rounded-xl transition-all ${
                  protectedAddress ? '' : ''
                }`}>
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        protectedAddress ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                      }`}>
                        {protectedAddress ? <Check className="w-5 h-5" /> : <Shield className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="font-semibold">Step 1: Protect Intent</div>
                        {protectedAddress && (
                          <div className="text-xs font-mono text-muted-foreground mt-1">
                            {protectedAddress.slice(0, 10)}...{protectedAddress.slice(-8)}
                          </div>
                        )}
                      </div>
                    </div>
                    {!protectedAddress && (
                      <Button
                        onClick={handleProtect}
                        disabled={isLoading || !amount || !limitPrice}
                        className="btn-premium glow-gold rounded-xl w-full sm:w-auto"
                      >
                        {isLoading && step === 'protect' ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Shield className="w-4 h-4 mr-2" />
                        )}
                        Encrypt
                      </Button>
                    )}
                  </div>
                </div>

                {/* Step 2: Grant */}
                <div className={`p-5 rounded-xl transition-all ${
                  step === 'grant' || step === 'submit' ? '' : ''
                } ${!protectedAddress && 'opacity-50'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        step === 'grant' || step === 'submit' ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                      }`}>
                        {step === 'submit' ? <Check className="w-5 h-5" /> : <Key className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="font-semibold">Step 2: Grant Access</div>
                        <div className="text-xs text-muted-foreground">Authorize TEE app</div>
                      </div>
                    </div>
                    {protectedAddress && step !== 'submit' && step !== 'grant' && (
                      <Button
                        onClick={handleGrantAccess}
                        disabled={isLoading}
                        variant="outline"
                        className="rounded-xl w-full sm:w-auto"
                      >
                        {isLoading ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Key className="w-4 h-4 mr-2" />
                        )}
                        Grant
                      </Button>
                    )}
                  </div>
                </div>

                {/* Step 3: Submit */}
                <div className={`p-5 rounded-xl transition-all ${
                  step === 'submit' ? '' : ''
                } ${step !== 'grant' && step !== 'submit' && 'opacity-50'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div className="flex items-start gap-4 flex-1">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        step === 'submit' && !isLoading ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                      }`}>
                        <Send className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <div className="font-semibold">Step 3: Submit to Round</div>
                        {step === 'grant' && (
                          <select
                            value={selectedRound}
                            onChange={(e) => setSelectedRound(e.target.value)}
                            className="mt-2 w-full bg-secondary/50 border border-border/50 rounded-xl px-4 py-2 text-sm"
                          >
                            <option value="">Select a round...</option>
                            {activeRounds.length === 0 ? (
                              <option value="" disabled>
                                No rounds available
                              </option>
                            ) : null}
                            {submittableRounds.length === 0 ? (
                              <option value="" disabled>
                                No rounds in intake
                              </option>
                            ) : null}
                            {submittableRounds.map((round) => (
                              <option key={round.id} value={round.id}>
                                {round.id} ({round.phase}, {round.intentsCount} intents)
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                    {step === 'grant' && (
                      <Button
                        onClick={handleSubmitToRound}
                        disabled={isLoading || !selectedRound}
                        className="btn-premium glow-gold-intense rounded-xl w-full sm:w-auto"
                      >
                        {isLoading ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4 mr-2" />
                        )}
                        Submit
                      </Button>
                    )}
                  </div>
                </div>

                {step === 'submit' && !isLoading && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-5 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center gap-3"
                  >
                    <Check className="w-5 h-5 text-green-400" />
                    <span className="text-green-400 font-semibold">
                      Intent submitted successfully!
                    </span>
                  </motion.div>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
