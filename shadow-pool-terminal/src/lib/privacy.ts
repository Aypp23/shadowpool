import type { WalletState } from '@/lib/types';

export const PUBLIC_VIEW_ONLY =
  String(import.meta.env.VITE_PUBLIC_VIEW_ONLY ?? 'true').toLowerCase() !== 'false';

export const PUBLIC_K_ANON = (() => {
  const raw = Number(import.meta.env.VITE_PUBLIC_K_ANON ?? 3);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 3;
})();

export function isPublicCount(count: number, k = PUBLIC_K_ANON) {
  return Number.isFinite(count) && count >= k;
}

export function formatPublicCount(count: number, k = PUBLIC_K_ANON) {
  return isPublicCount(count, k) ? String(count) : '—';
}

export function formatPublicRatio(
  numerator: number,
  denominator: number,
  k = PUBLIC_K_ANON
) {
  if (!isPublicCount(denominator, k) || !isPublicCount(numerator, k)) return '—';
  return `${numerator}/${denominator}`;
}

export function formatPublicRate(
  numerator: number,
  denominator: number,
  k = PUBLIC_K_ANON
) {
  if (!isPublicCount(denominator, k) || !isPublicCount(numerator, k)) return '—';
  if (denominator === 0) return '—';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export function isPublicViewer(wallet?: WalletState | null) {
  if (!PUBLIC_VIEW_ONLY) return false;
  return !wallet?.connected;
}

export function isPrivateViewer(wallet?: WalletState | null) {
  if (!PUBLIC_VIEW_ONLY) return true;
  return !!wallet?.connected;
}
