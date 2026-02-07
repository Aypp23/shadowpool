import { useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { truncateAddress } from '@/lib/utils';

interface MerkleRootCardProps {
  root: string;
  txHash?: string;
  postedAt?: Date;
  className?: string;
}

export function MerkleRootCard({ root, txHash, postedAt, className }: MerkleRootCardProps) {
  const [copied, setCopied] = useState<'root' | 'tx' | null>(null);

  const copyToClipboard = async (text: string, type: 'root' | 'tx') => {
    await navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-lg border border-border bg-card p-4 space-y-3",
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Hash className="w-4 h-4 text-primary" />
        <span>Merkle Root</span>
        {postedAt && (
          <span className="text-xs">
            · Posted {postedAt.toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-sm bg-secondary/50 rounded px-3 py-2 truncate">
          {truncateAddress(root, 12)}
        </code>
        <button
          onClick={() => copyToClipboard(root, 'root')}
          className="p-2 rounded-md hover:bg-secondary transition-colors"
          aria-label="Copy merkle root"
        >
          {copied === 'root' ? (
            <Check className="w-4 h-4 text-primary" />
          ) : (
            <Copy className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
      </div>

      {txHash && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Tx:</span>
          <code className="font-mono">{truncateAddress(txHash, 8)}</code>
          <button
            onClick={() => copyToClipboard(txHash, 'tx')}
            className="p-1 rounded hover:bg-secondary transition-colors"
            aria-label="Copy transaction hash"
          >
            {copied === 'tx' ? (
              <Check className="w-3 h-3 text-primary" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}
    </motion.div>
  );
}
