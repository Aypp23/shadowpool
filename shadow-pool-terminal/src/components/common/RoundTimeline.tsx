import { motion } from 'framer-motion';
import { Clock, Cpu, FileCheck, Zap, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RoundPhase } from '@/lib/types';

interface RoundTimelineProps {
  currentPhase: RoundPhase;
  className?: string;
}

const phases: { id: RoundPhase; label: string; shortLabel: string; icon: React.ReactNode }[] = [
  { id: 'intake', label: 'Intake', shortLabel: 'Intake', icon: <Clock className="w-4 h-4" /> },
  { id: 'matching', label: 'Matching (TEE)', shortLabel: 'Match', icon: <Cpu className="w-4 h-4" /> },
  { id: 'posted', label: 'Root Posted', shortLabel: 'Posted', icon: <FileCheck className="w-4 h-4" /> },
  { id: 'executable', label: 'Executable', shortLabel: 'Exec', icon: <Zap className="w-4 h-4" /> },
  { id: 'completed', label: 'Completed', shortLabel: 'Done', icon: <CheckCircle2 className="w-4 h-4" /> },
];

const phaseOrder: Record<RoundPhase, number> = {
  intake: 0,
  matching: 1,
  posted: 2,
  executable: 3,
  completed: 4,
};

export function RoundTimeline({ currentPhase, className }: RoundTimelineProps) {
  const currentIndex = phaseOrder[currentPhase];

  return (
    <div className={cn("relative", className)}>
      {/* Background line */}
      <div className="absolute top-4 md:top-5 left-0 right-0 h-0.5 bg-border" />
      
      {/* Progress line */}
      <motion.div
        className="absolute top-4 md:top-5 left-0 h-0.5 bg-primary"
        initial={{ width: '0%' }}
        animate={{ width: `${(currentIndex / (phases.length - 1)) * 100}%` }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* Phase nodes */}
      <div className="relative flex justify-between">
        {phases.map((phase, index) => {
          const isPast = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isFuture = index > currentIndex;

          return (
            <motion.div
              key={phase.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="flex flex-col items-center"
            >
              <motion.div
                className={cn(
                  "w-8 h-8 md:w-10 md:h-10 rounded-full flex items-center justify-center border-2 transition-colors duration-300",
                  isPast && "bg-primary border-primary text-primary-foreground",
                  isCurrent && "bg-card border-primary text-primary animate-pulse-glow",
                  isFuture && "bg-card border-border text-muted-foreground"
                )}
                whileHover={{ scale: 1.1 }}
                transition={{ type: "spring", stiffness: 400, damping: 17 }}
              >
                {phase.icon}
              </motion.div>
              <span className={cn(
                "mt-2 text-[10px] md:text-xs font-medium text-center w-12 md:w-16",
                isCurrent ? "text-primary" : isPast ? "text-foreground" : "text-muted-foreground"
              )}>
                <span className="md:hidden">{phase.shortLabel}</span>
                <span className="hidden md:inline">{phase.label}</span>
              </span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
