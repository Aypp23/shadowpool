import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Copy, Check, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HookData } from '@/lib/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface HookDataInspectorProps {
  hookData: HookData;
  className?: string;
}

const fieldDescriptions: Record<keyof HookData, string> = {
  roundId: 'Round identifier (bytes32) used to fetch the posted merkle root',
  matchId: 'Unique identifier for this matched trade',
  matchIdHash: 'Match identifier hash (bytes32) used for replay protection',
  trader: 'Ethereum address of the trader executing',
  counterparty: 'Ethereum address of the matched counterparty',
  tokenIn: 'Contract address of the input token',
  tokenOut: 'Contract address of the output token',
  amountIn: 'Exact amount of input tokens (in wei)',
  minAmountOut: 'Minimum acceptable output (slippage protection)',
  expiry: 'Unix timestamp when this proof expires',
  merkleProof: 'Cryptographic proof path in the merkle tree',
  signature: 'TEE-signed authorization for this trade',
  encodedHookData: 'ABI-encoded payload passed as hookData to the swap call',
};

export function HookDataInspector({ hookData, className }: HookDataInspectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hoveredField, setHoveredField] = useState<string | null>(null);

  const copyAll = async () => {
    await navigator.clipboard.writeText(JSON.stringify(hookData, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderValue = (key: string, value: unknown): React.ReactNode => {
    if (Array.isArray(value)) {
      return (
        <span className="text-primary">
          [{value.length} items]
        </span>
      );
    }
    if (typeof value === 'string' && value.startsWith('0x')) {
      return (
        <span className="text-green-400">
          "{value.slice(0, 10)}...{value.slice(-8)}"
        </span>
      );
    }
    if (typeof value === 'number') {
      return <span className="text-blue-400">{value}</span>;
    }
    if (typeof value === 'string') {
      return <span className="text-green-400">"{value}"</span>;
    }
    return <span>{String(value)}</span>;
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="w-full flex items-center justify-between p-4 hover:bg-secondary/50 transition-colors">
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono text-primary">hookData</code>
              <span className="text-xs text-muted-foreground">
                Uniswap v4 Hook Payload
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  copyAll();
                }}
                className="p-1.5 rounded-md hover:bg-secondary transition-colors"
                aria-label="Copy hook data"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-primary" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              <motion.div
                animate={{ rotate: isOpen ? 180 : 0 }}
                transition={{ duration: 0.2 }}
              >
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              </motion.div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <AnimatePresence>
            {isOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="border-t border-border bg-secondary/30 p-4 font-mono text-sm">
                  <pre className="overflow-x-auto">
                    <code>
                      <span className="text-muted-foreground">{'{'}</span>
                      {Object.entries(hookData).map(([key, value], index, arr) => (
                        <div
                          key={key}
                          className="relative pl-4 py-0.5 hover:bg-primary/5 rounded group"
                          onMouseEnter={() => setHoveredField(key)}
                          onMouseLeave={() => setHoveredField(null)}
                        >
                          <span className="text-purple-400">"{key}"</span>
                          <span className="text-muted-foreground">: </span>
                          {renderValue(key, value)}
                          {index < arr.length - 1 && (
                            <span className="text-muted-foreground">,</span>
                          )}
                          
                          {/* Tooltip */}
                          <AnimatePresence>
                            {hoveredField === key && (
                              <motion.div
                                initial={{ opacity: 0, x: -5 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -5 }}
                                className="absolute left-full top-0 ml-4 px-3 py-1.5 bg-popover border border-border rounded-md shadow-lg z-10 whitespace-nowrap"
                              >
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-sans">
                                  <Info className="w-3 h-3" />
                                  {fieldDescriptions[key as keyof HookData]}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      ))}
                      <span className="text-muted-foreground">{'}'}</span>
                    </code>
                  </pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
