import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { GrainOverlay } from '@/components/common/GrainOverlay';

export function Layout() {
  return (
    <div className="min-h-screen relative">
      {/* Grain overlay */}
      <GrainOverlay />
      
      {/* Header */}
      <Header />
      
      {/* Content */}
      <main className="relative pt-20">
        <Outlet />
      </main>
    </div>
  );
}
