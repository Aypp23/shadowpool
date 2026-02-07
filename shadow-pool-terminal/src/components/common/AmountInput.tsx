import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface AmountInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  suffix?: string;
  error?: string;
}

export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(
  ({ label, suffix, error, className, ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && (
          <label className="text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            type="text"
            inputMode="decimal"
            className={cn(
              "flex h-12 w-full rounded-md border border-input bg-input px-4 py-2",
              "font-mono text-right text-lg tabular-nums",
              "ring-offset-background placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "transition-all duration-200",
              error && "border-destructive focus-visible:ring-destructive",
              suffix && "pr-16",
              className
            )}
            {...props}
          />
          {suffix && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">
              {suffix}
            </div>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
      </div>
    );
  }
);

AmountInput.displayName = 'AmountInput';
