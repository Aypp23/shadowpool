import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Clock, ChevronRight, Users, GitMerge } from 'lucide-react';
import { useStore } from '@/stores/useStore';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { RoundTimeline } from '@/components/common/RoundTimeline';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

export default function Rounds() {
  const { rounds } = useStore();

  const now = Date.now();
  const isPostEndMatching = (round: (typeof rounds)[number]) =>
    round.phase === 'matching' && round.endTime.getTime() <= now;
  const postEndMatchingRounds = rounds.filter(isPostEndMatching);
  const isExecutableExpired = (round: (typeof rounds)[number]) =>
    (round.phase === 'executable' || round.phase === 'posted') &&
    !!round.rootValidUntil &&
    round.rootValidUntil.getTime() <= now;
  const activeRounds = rounds.filter(
    r => r.phase !== 'completed' && !isPostEndMatching(r) && !isExecutableExpired(r)
  );
  const completedRounds = rounds.filter(r => r.phase === 'completed' || isExecutableExpired(r));

  return (
    <div className="min-h-screen pb-20">
      {/* Hero gradient */}
      <div className="absolute top-0 left-0 right-0 h-[40vh] bg-radial-top pointer-events-none" />
      
      <div className="container px-6 py-12 relative">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-10"
        >
          <motion.div variants={itemVariants}>
            <h1 className="font-serif text-4xl md:text-5xl font-bold">Rounds</h1>
            <p className="text-muted-foreground mt-2 text-lg">
              View and participate in batch auction rounds
            </p>
          </motion.div>

          {/* Active Rounds */}
          <motion.div variants={itemVariants}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center">
                <Clock className="w-5 h-5 text-primary" />
              </div>
              <h2 className="font-serif text-2xl font-semibold">Active Rounds</h2>
            </div>
            
            {activeRounds.length === 0 ? (
              <div className="rounded-2xl p-12 text-center text-muted-foreground bg-transparent">
                No active rounds at the moment
              </div>
            ) : (
              <div className="space-y-4">
                {activeRounds.map((round, index) => (
                  <motion.div
                    key={round.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                  >
                    <Link to={`/round/${round.id}`}>
                      <div className="rounded-2xl p-6 hover:border-primary/30 border border-transparent transition-all group bg-transparent">
                        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                          {/* Round info */}
                          <div className="flex items-center gap-5">
                            <div className="w-14 h-14 rounded-xl flex items-center justify-center">
                              <span className="font-serif font-bold text-xl text-primary">
                                {round.id.slice(-2)}
                              </span>
                            </div>
                            <div>
                              <div className="font-mono text-xl font-semibold">{round.id}</div>
                              <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  <Users className="w-4 h-4" />
                                  {round.intentsCount} intents
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <GitMerge className="w-4 h-4" />
                                  {round.matchedCount} matched
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Timeline (desktop) */}
                          <div className="flex-1 max-w-lg hidden xl:block">
                            <RoundTimeline currentPhase={round.phase} />
                          </div>

                          {/* Timer & arrow */}
                          <div className="flex items-center gap-6">
                            <CountdownTimer 
                              endTime={
                                round.phase === 'executable' || round.phase === 'posted'
                                  ? round.rootValidUntil ?? null
                                  : round.endTime
                              } 
                              variant="ring" 
                              size="md"
                            />
                            <ChevronRight className="w-6 h-6 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
                          </div>
                        </div>

                        {/* Timeline (mobile) */}
                        <div className="xl:hidden mt-6 pt-6 border-t border-border/50">
                          <RoundTimeline currentPhase={round.phase} />
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Completed Rounds */}
          {postEndMatchingRounds.length > 0 && (
            <>
              {/* Divider */}
              <motion.div variants={itemVariants} className="h-px bg-white/[0.06]" />

              <motion.div variants={itemVariants}>
                <h2 className="font-serif text-xl font-semibold mb-4 text-muted-foreground">
                  Post-End Matching
                </h2>
                <div className="space-y-3">
                  {postEndMatchingRounds.map((round, index) => (
                    <motion.div
                      key={round.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: index * 0.05 }}
                    >
                      <Link to={`/round/${round.id}`}>
                        <div className="rounded-xl p-4 opacity-80 hover:opacity-100 transition-opacity group bg-transparent">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <span className="font-mono font-semibold">{round.id}</span>
                              <span className="text-sm text-muted-foreground">
                                {round.matchedCount} matched
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                              <span>Post-end matching</span>
                              <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </div>
                          </div>
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            </>
          )}

          {completedRounds.length > 0 && (
            <>
              {/* Divider */}
              <motion.div variants={itemVariants} className="h-px bg-white/[0.06]" />
              
              <motion.div variants={itemVariants}>
                <h2 className="font-serif text-xl font-semibold mb-4 text-muted-foreground">
                  Completed Rounds
                </h2>
              <div className="space-y-3">
                {completedRounds.map((round, index) => (
                  <motion.div
                    key={round.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <Link to={`/round/${round.id}`}>
                      <div className="rounded-xl p-4 opacity-60 hover:opacity-100 transition-opacity group bg-transparent">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <span className="font-mono font-semibold">{round.id}</span>
                            <span className="text-sm text-muted-foreground">
                              {round.matchedCount} matched
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span>{round.endTime.toLocaleDateString()}</span>
                            <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </div>
              </motion.div>
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}
