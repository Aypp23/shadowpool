import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ConfettiProps {
  trigger: boolean;
  onComplete?: () => void;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  rotation: number;
  color: string;
  size: number;
  delay: number;
}

const COLORS = [
  'hsl(43, 100%, 50%)', // Primary amber
  'hsl(43, 100%, 60%)', // Lighter amber
  'hsl(43, 100%, 70%)', // Even lighter
  'hsl(0, 0%, 95%)',    // Off-white
  'hsl(0, 0%, 80%)',    // Light gray
];

export function Confetti({ trigger, onComplete }: ConfettiProps) {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    if (trigger) {
      const newParticles: Particle[] = Array.from({ length: 50 }, (_, i) => ({
        id: i,
        x: 50 + (Math.random() - 0.5) * 40,
        y: 50,
        rotation: Math.random() * 360,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: 4 + Math.random() * 8,
        delay: Math.random() * 0.3,
      }));
      setParticles(newParticles);

      const timer = setTimeout(() => {
        setParticles([]);
        onComplete?.();
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [trigger, onComplete]);

  return (
    <AnimatePresence>
      {particles.length > 0 && (
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          {particles.map((particle) => (
            <motion.div
              key={particle.id}
              initial={{
                x: `${particle.x}vw`,
                y: `${particle.y}vh`,
                rotate: 0,
                scale: 0,
                opacity: 1,
              }}
              animate={{
                x: `${particle.x + (Math.random() - 0.5) * 30}vw`,
                y: `${particle.y - 30 - Math.random() * 40}vh`,
                rotate: particle.rotation + Math.random() * 720,
                scale: 1,
                opacity: [1, 1, 0],
              }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 1.5,
                delay: particle.delay,
                ease: [0.16, 1, 0.3, 1],
              }}
              style={{
                position: 'absolute',
                width: particle.size,
                height: particle.size,
                backgroundColor: particle.color,
                borderRadius: Math.random() > 0.5 ? '50%' : '2px',
              }}
            />
          ))}
        </div>
      )}
    </AnimatePresence>
  );
}
