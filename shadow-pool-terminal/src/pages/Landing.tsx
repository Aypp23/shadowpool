import { useRef, useEffect, useState } from 'react';
import { motion, useScroll, useTransform, useMotionValue, useSpring, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { 
  Shield, 
  Key, 
  Cpu, 
  Zap, 
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  TrendingUp,
  Sparkles,
  ChevronDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/stores/useStore';

// Magnetic button effect
function MagneticButton({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 300, damping: 20 });
  const springY = useSpring(y, { stiffness: 300, damping: 20 });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    x.set((e.clientX - centerX) * 0.15);
    y.set((e.clientY - centerY) * 0.15);
  };

  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.div
      ref={ref}
      style={{ x: springX, y: springY }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// Animated counter
function AnimatedNumber({ value, duration = 2 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  
  useEffect(() => {
    let start = 0;
    const end = value;
    const incrementTime = (duration * 1000) / end;
    
    const timer = setInterval(() => {
      start += 1;
      setDisplay(start);
      if (start >= end) clearInterval(timer);
    }, incrementTime);
    
    return () => clearInterval(timer);
  }, [value, duration]);
  
  return <span className="tabular-nums">{display.toLocaleString()}</span>;
}

// Glowing orb component
function GlowingOrb({ 
  size, 
  color, 
  blur, 
  position, 
  delay = 0 
}: { 
  size: number; 
  color: string; 
  blur: number; 
  position: { x: string; y: string }; 
  delay?: number 
}) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: size,
        height: size,
        background: color,
        filter: `blur(${blur}px)`,
        left: position.x,
        top: position.y,
      }}
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ 
        opacity: [0.3, 0.6, 0.3],
        scale: [1, 1.2, 1],
        x: [0, 30, -20, 0],
        y: [0, -20, 30, 0],
      }}
      transition={{ 
        duration: 20,
        repeat: Infinity,
        ease: "easeInOut",
        delay,
      }}
    />
  );
}

export default function Landing() {
  const { wallet, connectWallet } = useStore();
  const heroRef = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"]
  });
  
  const heroOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.5], [1, 0.9]);
  const heroY = useTransform(scrollYProgress, [0, 0.5], [0, 150]);
  const heroBlur = useTransform(scrollYProgress, [0, 0.5], [0, 10]);

  // Track mouse for spotlight effect
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const flowSteps = [
    {
      icon: Shield,
      step: '01',
      title: 'Protect',
      subtitle: 'Encrypt Your Intent',
      description: 'Your limit price, size, and strategy are sealed in a cryptographic envelope using iExec DataProtector.',
      gradient: 'from-slate-400/20 to-zinc-500/20',
      iconGradient: 'from-slate-300 to-zinc-400',
    },
    {
      icon: Key,
      step: '02',
      title: 'Grant',
      subtitle: 'Authorize TEE Access',
      description: 'Only the secure enclave can read your parameters. No one else—not even us.',
      gradient: 'from-zinc-400/20 to-stone-500/20',
      iconGradient: 'from-zinc-300 to-stone-400',
    },
    {
      icon: Cpu,
      step: '03',
      title: 'Match',
      subtitle: 'Confidential Batch Processing',
      description: "Orders are matched in a Trusted Execution Environment without exposing any trader's intent.",
      gradient: 'from-neutral-400/20 to-gray-500/20',
      iconGradient: 'from-neutral-300 to-gray-400',
    },
    {
      icon: Zap,
      step: '04',
      title: 'Execute',
      subtitle: 'On-Chain Settlement',
      description: 'Matched trades settle via Uniswap v4 hooks. Merkle proofs ensure only valid matches execute.',
      gradient: 'from-stone-400/20 to-slate-500/20',
      iconGradient: 'from-stone-300 to-slate-400',
    },
  ];

  return (
    <div className="relative overflow-hidden">
      {/* Global ambient light that follows mouse */}
      <div 
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-300"
        style={{
          background: `radial-gradient(800px circle at ${mousePosition.x}px ${mousePosition.y}px, hsla(220, 10%, 75%, 0.04), transparent 40%)`,
        }}
      />

      {/* Hero Section */}
      <section 
        ref={heroRef}
        className="relative min-h-[100vh] flex items-center justify-center overflow-hidden"
      >
        {/* Layered background effects */}
        <div className="absolute inset-0">
          {/* Base grid */}
          <div className="absolute inset-0 bg-grid opacity-40" />
          
          {/* Radial gradient overlays */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsla(220,10%,75%,0.12),transparent)]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_50%_at_80%_80%,hsla(220,15%,60%,0.06),transparent)]" />
          
          {/* Animated gradient orbs */}
          <GlowingOrb 
            size={800} 
            color="hsla(220, 10%, 75%, 0.12)" 
            blur={120} 
            position={{ x: '20%', y: '10%' }} 
          />
          <GlowingOrb 
            size={600} 
            color="hsla(220, 15%, 60%, 0.08)" 
            blur={100} 
            position={{ x: '70%', y: '60%' }} 
            delay={5}
          />
          <GlowingOrb 
            size={400} 
            color="hsla(220, 10%, 70%, 0.08)" 
            blur={80} 
            position={{ x: '50%', y: '80%' }} 
            delay={10}
          />
          
          {/* Noise texture */}
          <div className="absolute inset-0 opacity-[0.015] mix-blend-overlay" 
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            }}
          />
        </div>

        {/* Floating particles */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[...Array(20)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute w-1 h-1 bg-primary/30 rounded-full"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
              }}
              animate={{
                y: [0, -100, 0],
                opacity: [0, 1, 0],
              }}
              transition={{
                duration: 5 + Math.random() * 5,
                repeat: Infinity,
                delay: Math.random() * 5,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        <motion.div 
          style={{ 
            opacity: heroOpacity, 
            scale: heroScale, 
            y: heroY,
            filter: useTransform(heroBlur, (v) => `blur(${v}px)`),
          }}
          className="relative z-10 container px-6"
        >
          <div className="max-w-6xl mx-auto">
            {/* Eyebrow */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center justify-center gap-4 mb-10"
            >
              <motion.div 
                className="h-px w-16 bg-gradient-to-r from-transparent via-primary/50 to-primary"
                initial={{ scaleX: 0, originX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.5, duration: 1 }}
              />
              <div className="flex items-center gap-2 px-4 py-2 rounded-full border border-primary/20 bg-primary/5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs tracking-[0.2em] text-primary/90 uppercase font-semibold">
                  iExec Confidential Computing
                </span>
              </div>
              <motion.div 
                className="h-px w-16 bg-gradient-to-l from-transparent via-primary/50 to-primary"
                initial={{ scaleX: 0, originX: 1 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.5, duration: 1 }}
              />
            </motion.div>

            {/* Main headline with dramatic reveal */}
            <div className="overflow-hidden">
              <motion.h1
                initial={{ y: 120 }}
                animate={{ y: 0 }}
                transition={{ delay: 0.4, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                className="text-center font-serif"
              >
                <span className="block text-6xl sm:text-7xl md:text-8xl lg:text-[9rem] font-bold text-foreground leading-[0.9] tracking-tight">
                  Private intents.
                </span>
              </motion.h1>
            </div>
            <div className="overflow-hidden mt-2">
              <motion.h1
                initial={{ y: 120 }}
                animate={{ y: 0 }}
                transition={{ delay: 0.5, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                className="text-center font-serif"
              >
                <span className="block text-6xl sm:text-7xl md:text-8xl lg:text-[9rem] font-bold leading-[0.9] tracking-tight">
                  <span className="bg-gradient-to-r from-zinc-200 via-slate-300 to-zinc-400 bg-clip-text text-transparent animate-glow-pulse">
                    Public execution.
                  </span>
                </span>
              </motion.h1>
            </div>

            {/* Subheadline */}
            <motion.p
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.8 }}
              className="mt-10 text-center text-xl md:text-2xl lg:text-3xl text-muted-foreground max-w-3xl mx-auto leading-relaxed font-light"
            >
              The first <span className="text-foreground font-normal">TEE-secured dark pool</span> for encrypted OTC swaps.
              <br className="hidden lg:block" />
              Your strategy stays hidden until settlement.
            </motion.p>

            {/* CTA Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1 }}
              className="mt-14 flex flex-col sm:flex-row items-center justify-center gap-5"
            >
              <MagneticButton>
                <Link to="/create">
                  <Button 
                    size="lg" 
                    className="relative overflow-hidden text-lg px-12 py-8 rounded-2xl font-bold group bg-gradient-to-r from-zinc-300 via-slate-200 to-zinc-400 text-zinc-900 hover:from-zinc-200 hover:via-white hover:to-zinc-300 transition-all duration-500 shadow-[0_0_40px_hsla(220,10%,75%,0.3)] hover:shadow-[0_0_60px_hsla(220,10%,85%,0.5)]"
                  >
                    {/* Shine effect */}
                    <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                    <span className="relative flex items-center gap-3">
                      <span>Create Intent</span>
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </span>
                  </Button>
                </Link>
              </MagneticButton>
              
              {!wallet.connected && (
                <MagneticButton>
                  <Button 
                    variant="outline" 
                    size="lg"
                    onClick={connectWallet}
                    className="text-lg px-10 py-8 rounded-2xl border-2 border-primary/30 hover:border-primary/60 bg-primary/5 hover:bg-primary/10 transition-all duration-300"
                  >
                    Connect Wallet
                  </Button>
                </MagneticButton>
              )}
            </motion.div>

            {/* Stats row */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.2 }}
              className="mt-20 grid grid-cols-3 gap-8 max-w-2xl mx-auto"
            >
              {[
                { value: 127, label: 'Active Intents', suffix: '+' },
                { value: 50, label: 'Daily Volume', prefix: '$', suffix: 'M' },
                { value: 100, label: 'Privacy Score', suffix: '%' },
              ].map((stat, i) => (
                <div key={i} className="text-center">
                  <div className="font-mono text-3xl md:text-4xl font-bold text-foreground">
                    {stat.prefix}<AnimatedNumber value={stat.value} />{stat.suffix}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
                </div>
              ))}
            </motion.div>

            {/* Trust badges - Redesigned */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.4 }}
              className="mt-16 flex flex-wrap items-center justify-center gap-6"
            >
              {[
                { icon: Lock, label: 'iExec TEE' },
                { icon: TrendingUp, label: 'Uniswap v4' },
                { icon: Shield, label: 'Arbitrum Sepolia' },
              ].map((badge, i) => (
                <div 
                  key={i}
                  className="flex items-center gap-2.5 px-5 py-2.5 rounded-full bg-white/[0.03] border border-white/[0.06] backdrop-blur-sm"
                >
                  <badge.icon className="w-4 h-4 text-primary/70" />
                  <span className="text-sm text-muted-foreground">{badge.label}</span>
                </div>
              ))}
            </motion.div>
          </div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6 }}
          className="absolute bottom-12 left-1/2 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            className="flex flex-col items-center gap-3"
          >
            <span className="text-xs text-muted-foreground/60 uppercase tracking-widest">Scroll</span>
            <ChevronDown className="w-5 h-5 text-primary/50" />
          </motion.div>
        </motion.div>
      </section>

      {/* How It Works - Premium Cards */}
      <section className="relative py-40 overflow-hidden">
        {/* Section background */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_100%_100%_at_50%_0%,hsla(220,10%,75%,0.06),transparent_50%)]" />
        
        <div className="container px-6 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 60 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="text-center mb-24"
          >
            <motion.span 
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              className="inline-block text-xs tracking-[0.3em] text-primary/70 uppercase font-semibold mb-6"
            >
              The Protocol
            </motion.span>
            <h2 className="font-serif text-5xl md:text-6xl lg:text-7xl font-bold leading-tight">
              Four steps to
              <br />
              <span className="bg-gradient-to-r from-zinc-200 via-slate-300 to-zinc-400 bg-clip-text text-transparent">
                hidden alpha
              </span>
            </h2>
          </motion.div>

          {/* Flow Cards - Horizontal scroll on mobile, grid on desktop */}
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
              {flowSteps.map((item, index) => (
                <motion.div
                  key={item.step}
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.8, delay: index * 0.1 }}
                >
                  <motion.div
                    whileHover={{ y: -8, transition: { duration: 0.3 } }}
                    className="relative h-full p-8 lg:p-10 rounded-3xl border border-white/[0.06] overflow-hidden group"
                  >
                    {/* Hover glow */}
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(400px_circle_at_50%_50%,hsla(38,95%,54%,0.1),transparent)]" />
                    
                    {/* Step number - Large background */}
                    <div className="absolute -top-10 -right-10 font-serif text-[12rem] font-bold text-white/[0.02] leading-none pointer-events-none select-none">
                      {item.step}
                    </div>
                    
                    <div className="relative z-10">
                      {/* Icon + Step */}
                      <div className="flex items-start justify-between mb-6">
                        <div className={`p-4 rounded-2xl bg-gradient-to-br ${item.iconGradient} bg-opacity-20`}>
                          <item.icon className="w-7 h-7 text-foreground" />
                        </div>
                        <span className="font-mono text-sm text-muted-foreground/50">
                          {item.step}
                        </span>
                      </div>
                      
                      {/* Content */}
                      <h3 className="font-serif text-3xl lg:text-4xl font-bold mb-2">
                        {item.title}
                      </h3>
                      <p className="text-primary/80 text-sm font-medium mb-4">
                        {item.subtitle}
                      </p>
                      <p className="text-muted-foreground leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                    
                    {/* Border glow on hover */}
                    <div className="absolute inset-0 rounded-3xl border border-primary/0 group-hover:border-primary/20 transition-colors duration-500" />
                  </motion.div>
                </motion.div>
              ))}
            </div>

            {/* Connecting lines (desktop only) */}
            <div className="hidden md:block absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-32 bg-gradient-to-b from-transparent via-primary/20 to-transparent" />
          </div>
        </div>
      </section>

      {/* Privacy Promise - Cinematic Statement */}
      <section className="relative py-40 overflow-hidden">
        {/* Dramatic background */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-primary/5 to-background" />
          <div className="absolute inset-0 bg-grid opacity-20" />
          <GlowingOrb 
            size={1000} 
            color="hsla(220, 10%, 75%, 0.08)" 
            blur={150} 
            position={{ x: '50%', y: '50%' }} 
          />
        </div>
        
        <div className="container px-6 relative z-10">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-5xl mx-auto text-center"
          >
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-primary/20 bg-primary/5 mb-10"
            >
              <Eye className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-primary">Privacy Guarantee</span>
            </motion.div>

            {/* Statement */}
            <h2 className="font-serif text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-bold leading-[1.1] mb-10">
              Your limit price and size
              <br />
              <span className="bg-gradient-to-r from-zinc-200 via-slate-300 to-zinc-400 bg-clip-text text-transparent">
                never touch the blockchain
              </span>
            </h2>

            <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed max-w-3xl mx-auto mb-12">
              ShadowPool leverages iExec's Trusted Execution Environment to process your intents 
              in complete confidentiality. Only the final matched parameters are published on-chain.
            </p>

            {/* Visual proof */}
            <div className="flex items-center justify-center gap-4 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <EyeOff className="w-4 h-4" />
                <span>Hidden: Price, Size, Strategy</span>
              </div>
              <ArrowRight className="w-4 h-4 text-primary" />
              <div className="flex items-center gap-2 text-foreground">
                <Eye className="w-4 h-4" />
                <span>Public: Matched Result Only</span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Final CTA - Massive and Commanding */}
      <section className="relative py-40">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_100%,hsla(220,10%,75%,0.1),transparent)]" />
        
        <div className="container px-6 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 60 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-4xl mx-auto text-center"
          >
            <h2 className="font-serif text-5xl md:text-6xl lg:text-7xl font-bold mb-8 leading-tight">
              Ready to trade
              <br />
              <span className="bg-gradient-to-r from-zinc-200 via-slate-300 to-zinc-400 bg-clip-text text-transparent">
                in the shadows?
              </span>
            </h2>
            
            <p className="text-xl md:text-2xl text-muted-foreground mb-14 max-w-2xl mx-auto">
              Create your first confidential intent and experience the future of dark pool trading.
            </p>
            
            <MagneticButton className="inline-block">
              <Link to="/create">
                <Button 
                  size="lg" 
                  className="relative overflow-hidden text-xl px-16 py-10 rounded-2xl font-bold group bg-gradient-to-r from-zinc-300 via-slate-200 to-zinc-400 text-zinc-900 hover:from-zinc-200 hover:via-white hover:to-zinc-300 transition-all duration-500 shadow-[0_0_60px_hsla(220,10%,75%,0.4)] hover:shadow-[0_0_100px_hsla(220,10%,85%,0.6)]"
                >
                  <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                  <span className="relative flex items-center gap-4">
                    <span>Get Started</span>
                    <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform duration-300" />
                  </span>
                </Button>
              </Link>
            </MagneticButton>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
