import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { IntentStatus } from '@/lib/types';

interface IntentStatusPillProps {
  status: IntentStatus;
  size?: 'sm' | 'md' | 'lg';
  animate?: boolean;
}

const statusConfig: Record<IntentStatus, { label: string; className: string }> = {
  draft: {
    label: 'Draft',
    className: 'bg-status-draft/20 text-status-draft border-status-draft/30',
  },
  protected: {
    label: 'Protected',
    className: 'bg-status-protected/20 text-status-protected border-status-protected/30',
  },
  granted: {
    label: 'Access Granted',
    className: 'bg-status-granted/20 text-status-granted border-status-granted/30',
  },
  submitted: {
    label: 'Submitted',
    className: 'bg-status-submitted/20 text-status-submitted border-status-submitted/30',
  },
  matched: {
    label: 'Matched',
    className: 'bg-status-matched/20 text-status-matched border-status-matched/30',
  },
  executed: {
    label: 'Executed',
    className: 'bg-status-executed/20 text-status-executed border-status-executed/30',
  },
  expired: {
    label: 'Expired',
    className: 'bg-status-expired/20 text-status-expired border-status-expired/30',
  },
};

const sizeClasses = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
  lg: 'px-4 py-1.5 text-base',
};

export function IntentStatusPill({ status, size = 'md', animate = true }: IntentStatusPillProps) {
  const config = statusConfig[status];
  
  const Component = animate ? motion.span : 'span';
  const animationProps = animate ? {
    initial: { scale: 0.9, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    transition: { type: 'spring' as const, stiffness: 500, damping: 30 }
  } : {};

  return (
    <Component
      {...animationProps}
      className={cn(
        'inline-flex items-center font-medium rounded-full border transition-colors duration-300',
        sizeClasses[size],
        config.className
      )}
    >
      <span className="relative flex h-2 w-2 mr-2">
        <span className={cn(
          "absolute inline-flex h-full w-full rounded-full opacity-75",
          status === 'matched' || status === 'submitted' ? "animate-ping" : ""
        )} style={{ backgroundColor: 'currentColor' }} />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: 'currentColor' }} />
      </span>
      {config.label}
    </Component>
  );
}
