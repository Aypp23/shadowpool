import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TokenPair } from '@/lib/types';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TokenPairPickerProps {
  value?: TokenPair;
  onChange: (pair: TokenPair) => void;
  className?: string;
}

export function TokenPairPicker({ value, onChange, className }: TokenPairPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pairs, setPairs] = useState<TokenPair[]>([]);

  useEffect(() => {
    const tokenAddresses = [
      import.meta.env.VITE_TOKEN_A_ADDRESS,
      import.meta.env.VITE_TOKEN_B_ADDRESS,
      import.meta.env.VITE_TOKEN_C_ADDRESS,
      import.meta.env.VITE_TOKEN_D_ADDRESS,
    ].filter((x): x is string => typeof x === 'string' && x.startsWith('0x') && x.length === 42);

    if (tokenAddresses.length < 2) {
      setPairs([]);
      return;
    }

    const symbolAbi = parseAbi(['function symbol() view returns (string)']);
    const nameAbi = parseAbi(['function name() view returns (string)']);
    const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);

    const client = createPublicClient({ chain: arbitrumSepolia, transport: http() });

    let cancelled = false;

    const run = async () => {
      const settled = await Promise.allSettled(
        tokenAddresses.map(async (address) => {
          const addr = address as `0x${string}`;
          const code = await client.getCode({ address: addr });
          if (!code || code === '0x') return null;
          try {
            const [symbolHex, nameHex, decimalsHex] = await Promise.all([
              client.request({
                method: 'eth_call',
                params: [{ to: addr, data: encodeFunctionData({ abi: symbolAbi, functionName: 'symbol' }) }, 'latest'],
              }),
              client.request({
                method: 'eth_call',
                params: [{ to: addr, data: encodeFunctionData({ abi: nameAbi, functionName: 'name' }) }, 'latest'],
              }),
              client.request({
                method: 'eth_call',
                params: [{ to: addr, data: encodeFunctionData({ abi: decimalsAbi, functionName: 'decimals' }) }, 'latest'],
              }),
            ]);

            const symbol = decodeFunctionResult({ abi: symbolAbi, functionName: 'symbol', data: symbolHex as Hex });
            const name = decodeFunctionResult({ abi: nameAbi, functionName: 'name', data: nameHex as Hex });
            const decimals = decodeFunctionResult({ abi: decimalsAbi, functionName: 'decimals', data: decimalsHex as Hex });

            return {
              symbol: String(symbol),
              name: String(name),
              address: addr,
              decimals: Number(decimals),
            };
          } catch {
            return null;
          }
        })
      );

      const tokens: Array<{ symbol: string; name: string; address: `0x${string}`; decimals: number }> = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) tokens.push(r.value);
      }

      if (tokens.length < 2) {
        if (!cancelled) setPairs([]);
        return;
      }

      const builtPairs: TokenPair[] = [];
      for (let i = 0; i < tokens.length; i += 1) {
        for (let j = 0; j < tokens.length; j += 1) {
          if (i === j) continue;
          builtPairs.push({ base: tokens[i], quote: tokens[j] });
        }
      }

      if (!cancelled) {
        setPairs(builtPairs);
      }
    };

    run().catch(() => {
      if (!cancelled) setPairs([]);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredPairs = useMemo(() => {
    const searchLower = search.toLowerCase();
    return pairs.filter((pair) => {
      if (!searchLower) return true;
      return (
        pair.base.symbol.toLowerCase().includes(searchLower) ||
        pair.quote.symbol.toLowerCase().includes(searchLower) ||
        pair.base.name.toLowerCase().includes(searchLower) ||
        pair.quote.name.toLowerCase().includes(searchLower)
      );
    });
  }, [pairs, search]);

  const formatPair = (pair: TokenPair) => `${pair.base.symbol}/${pair.quote.symbol}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Select token pair"
          className={cn(
            "w-full justify-between bg-input border-border hover:bg-secondary font-mono",
            className
          )}
        >
          {value ? formatPair(value) : "Select pair..."}
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0 bg-card border-border" align="start">
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search pairs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 bg-input border-border"
            />
          </div>
        </div>
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filteredPairs.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              No pairs available.
            </div>
          ) : (
            filteredPairs.map((pair) => (
              <button
                key={`${pair.base.address}-${pair.quote.address}`}
                onClick={() => {
                  onChange(pair);
                  setOpen(false);
                  setSearch('');
                }}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm",
                  "hover:bg-secondary transition-colors",
                  value && formatPair(value) === formatPair(pair) && "bg-secondary"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-1">
                    {pair.base.icon ? (
                      <img src={pair.base.icon} alt={pair.base.symbol} className="w-6 h-6 rounded-full bg-background" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary">
                        {pair.base.symbol.slice(0, 2)}
                      </div>
                    )}
                    {pair.quote.icon ? (
                      <img src={pair.quote.icon} alt={pair.quote.symbol} className="w-6 h-6 rounded-full bg-background" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                        {pair.quote.symbol.slice(0, 2)}
                      </div>
                    )}
                  </div>
                  <span className="font-mono">{formatPair(pair)}</span>
                </div>
                {value && formatPair(value) === formatPair(pair) && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
