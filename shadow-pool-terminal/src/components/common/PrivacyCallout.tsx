import { motion } from 'framer-motion';
import { Lock, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PrivacyCalloutProps {
  variant?: 'default' | 'compact';
  className?: string;
}

export function PrivacyCallout({ variant = 'default', className }: PrivacyCalloutProps) {
  if (variant === 'compact') {
    return (
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20",
        className
      )}>
        <Lock className="w-4 h-4 text-primary" />
        <span className="text-sm text-muted-foreground">
          Your limit price and size never touch the blockchain
        </span>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-6",
        className
      )}
    >
      {/* Animated pulse ring */}
      <div className="absolute top-6 left-6">
        <motion.div
          animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
          className="absolute inset-0 rounded-full bg-primary/30"
        />
        <div className="relative w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
      </div>

      <div className="ml-16">
        <h3 className="font-serif text-lg font-semibold text-foreground mb-2">
          Privacy Guarantee
        </h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Your intent's sensitive data—limit price, exact size, and trading strategy—is encrypted 
          using iExec DataProtector before submission. Only the authorized TEE environment can 
          decrypt and process your intent. The blockchain never sees your private trading parameters.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-xs text-muted-foreground">
            <Lock className="w-3 h-3" />
            End-to-end encrypted
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-xs text-muted-foreground">
            <ShieldCheck className="w-3 h-3" />
            TEE-secured matching
          </span>
        </div>
      </div>
    </motion.div>
  );
}
