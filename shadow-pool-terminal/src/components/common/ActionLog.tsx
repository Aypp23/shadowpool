import { motion } from 'framer-motion';
import { Database, Cpu, Upload, Zap, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AdminAction } from '@/lib/types';

interface ActionLogProps {
  actions: AdminAction[];
  className?: string;
}

const actionIcons: Record<AdminAction['type'], React.ReactNode> = {
  ingest: <Database className="w-4 h-4" />,
  run_tee: <Cpu className="w-4 h-4" />,
  post_root: <Upload className="w-4 h-4" />,
  execute: <Zap className="w-4 h-4" />,
};

const actionLabels: Record<AdminAction['type'], string> = {
  ingest: 'Batch Ingest',
  run_tee: 'TEE Matching',
  post_root: 'Post Root',
  execute: 'Execute Trade',
};

const resultConfig: Record<AdminAction['result'], { icon: React.ReactNode; className: string }> = {
  success: {
    icon: <CheckCircle2 className="w-4 h-4" />,
    className: 'text-status-matched bg-status-matched/10',
  },
  pending: {
    icon: <Clock className="w-4 h-4 animate-spin" />,
    className: 'text-status-submitted bg-status-submitted/10',
  },
  failed: {
    icon: <XCircle className="w-4 h-4" />,
    className: 'text-destructive bg-destructive/10',
  },
};

export function ActionLog({ actions, className }: ActionLogProps) {
  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className={cn("space-y-1", className)}>
      {actions.map((action, index) => (
        <motion.div
          key={action.id}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
          className="relative pl-6 pb-4 border-l border-border last:pb-0"
        >
          {/* Timeline dot */}
          <div className={cn(
            "absolute -left-2 w-4 h-4 rounded-full flex items-center justify-center",
            resultConfig[action.result].className
          )}>
            <div className="w-2 h-2 rounded-full bg-current" />
          </div>

          <div className="bg-transparent rounded-lg p-3 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-secondary text-muted-foreground">
                  {actionIcons[action.type]}
                </div>
                <div>
                  <div className="font-medium text-sm">{actionLabels[action.type]}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatTime(action.timestamp)}
                  </div>
                </div>
              </div>
              <div className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-xs",
                resultConfig[action.result].className
              )}>
                {resultConfig[action.result].icon}
                <span className="capitalize">{action.result}</span>
              </div>
            </div>
            
            {action.details && (
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                {action.details}
              </p>
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
