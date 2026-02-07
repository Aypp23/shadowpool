import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface CountdownTimerProps {
  endTime?: Date | null;
  variant?: 'ring' | 'bar' | 'text';
  size?: 'sm' | 'md' | 'lg';
  showWarning?: boolean;
  warningThreshold?: number; // minutes
  className?: string;
}

function getTimeRemaining(endTime: Date) {
  const total = endTime.getTime() - Date.now();
  const seconds = Math.floor((total / 1000) % 60);
  const minutes = Math.floor((total / 1000 / 60) % 60);
  const hours = Math.floor((total / (1000 * 60 * 60)) % 24);
  const days = Math.floor(total / (1000 * 60 * 60 * 24));
  
  return {
    total,
    days,
    hours,
    minutes,
    seconds,
    isExpired: total <= 0,
  };
}

function formatTime(time: ReturnType<typeof getTimeRemaining>) {
  if (time.isExpired) return 'Expired';
  if (time.days > 0) return `${time.days}d ${time.hours}h`;
  if (time.hours > 0) return `${time.hours}h ${time.minutes}m`;
  if (time.minutes > 0) return `${time.minutes}m ${time.seconds}s`;
  return `${time.seconds}s`;
}

export function CountdownTimer({
  endTime,
  variant = 'text',
  size = 'md',
  showWarning = true,
  warningThreshold = 10,
  className,
}: CountdownTimerProps) {
  const [time, setTime] = useState(() => (endTime ? getTimeRemaining(endTime) : null));

  useEffect(() => {
    if (!endTime) {
      setTime(null);
      return;
    }
    setTime(getTimeRemaining(endTime));
    const interval = setInterval(() => {
      setTime(getTimeRemaining(endTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [endTime]);

  const sizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };

  if (!endTime || !time) {
    return (
      <span className={cn("font-mono font-medium tabular-nums text-muted-foreground", sizeClasses[size], className)}>
        —
      </span>
    );
  }

  const isWarning = showWarning && time.total > 0 && time.total <= warningThreshold * 60 * 1000;

  const ringSizes = {
    sm: { size: 40, stroke: 3 },
    md: { size: 56, stroke: 4 },
    lg: { size: 72, stroke: 5 },
  };

  if (variant === 'ring') {
    const { size: ringSize, stroke } = ringSizes[size];
    const radius = (ringSize - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const startTime = endTime.getTime() - 60 * 60 * 1000; // Assume 1 hour rounds
    const totalDuration = endTime.getTime() - startTime;
    const progress = Math.max(0, Math.min(1, time.total / totalDuration));
    const strokeDashoffset = circumference * (1 - progress);

    return (
      <div className={cn("relative inline-flex items-center justify-center", className)}>
        <svg width={ringSize} height={ringSize} className="transform -rotate-90">
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={stroke}
          />
          <motion.circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke={isWarning ? "hsl(var(--destructive))" : time.isExpired ? "hsl(var(--muted))" : "hsl(var(--primary))"}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </svg>
        <span className={cn(
          "absolute inset-0 flex items-center justify-center text-center font-mono font-medium leading-tight whitespace-nowrap",
          sizeClasses[size],
          time.isExpired ? "text-muted-foreground" : isWarning ? "text-destructive" : "text-foreground"
        )}>
          {formatTime(time)}
        </span>
      </div>
    );
  }

  if (variant === 'bar') {
    const startTime = endTime.getTime() - 60 * 60 * 1000;
    const totalDuration = endTime.getTime() - startTime;
    const progress = Math.max(0, Math.min(100, (time.total / totalDuration) * 100));

    return (
      <div className={cn("space-y-1", className)}>
        <div className="flex justify-between items-center">
          <span className={cn(
            "font-mono",
            sizeClasses[size],
            time.isExpired ? "text-muted-foreground" : isWarning ? "text-destructive" : "text-foreground"
          )}>
            {formatTime(time)}
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <motion.div
            className={cn(
              "h-full rounded-full",
              time.isExpired ? "bg-muted-foreground" : isWarning ? "bg-destructive" : "bg-primary"
            )}
            initial={{ width: '100%' }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
      </div>
    );
  }

  // Default: text variant
  return (
    <span className={cn(
      "font-mono font-medium tabular-nums",
      sizeClasses[size],
      time.isExpired ? "text-muted-foreground" : isWarning ? "text-destructive" : "text-foreground",
      className
    )}>
      {formatTime(time)}
    </span>
  );
}
