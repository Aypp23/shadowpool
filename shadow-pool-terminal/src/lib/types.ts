// Intent Status Types
export type IntentStatus = 
  | 'draft'
  | 'protected'
  | 'granted'
  | 'submitted'
  | 'matched'
  | 'executed'
  | 'expired';

// Side Types
export type TradeSide = 'buy' | 'sell';

// Token Types
export interface Token {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  icon?: string;
}

export interface TokenPair {
  base: Token;
  quote: Token;
}

// Intent Types
export interface Intent {
  id: string;
  side: TradeSide;
  trader?: string;
  tokenPair: TokenPair;
  amount: string;
  limitPrice: string;
  expiry: Date;
  status: IntentStatus;
  createdAt: Date;
  protectedDataAddress?: string;
  authorizedApp?: string;
  authorizedUser?: string;
  roundId?: string;
  matchId?: string;
  slippageMin?: number;
  slippageMax?: number;
  notes?: string;
}

export interface RoundIntentRef {
  roundId: string;
  position: number;
  protectedData: string;
  trader?: string;
  commitment?: string;
  intentId?: string;
  timestamp?: Date;
}

// Round Types
export type RoundPhase = 'intake' | 'matching' | 'posted' | 'executable' | 'completed';

export interface Round {
  id: string;
  phase: RoundPhase;
  intentsCount: number;
  matchedCount: number;
  startTime: Date;
  endTime: Date;
  rootValidUntil?: Date;
  merkleRoot?: string;
  postedAt?: Date;
  txHash?: string;
}

// Match Types
export interface Match {
  uid: string;
  id: string;
  roundId: string;
  trader: string;
  counterparty?: string;
  traderProtectedDataAddress?: string;
  counterpartyProtectedDataAddress?: string;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  minAmountOut: string;
  expiry: Date;
  matchIdHash?: string;
  leaf?: string;
  merkleProof?: string[];
  signature?: string;
  proofAvailable: boolean;
  executed: boolean;
  executedAt?: Date;
  executionTxHash?: string;
}

// Hook Data Types
export interface HookData {
  roundId: string;
  matchId: string;
  matchIdHash: string;
  trader: string;
  counterparty: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  expiry: number;
  merkleProof: string[];
  signature: string;
  encodedHookData: string;
}

// Execution Result Types
export type ExecutionResult = 
  | { success: true; txHash: string; amountOut: string }
  | { success: false; error: 'invalid_proof' | 'expired' | 'already_executed' | 'insufficient_liquidity' | 'insufficient_balance' | 'unauthorized_caller' | 'invalid_signature' | 'coming_soon' | 'unknown' | 'token_error' | 'invalid_swap_params' | 'hook_mismatch' | 'execution_failed'; message: string };

// Admin Action Types
export interface AdminAction {
  id: string;
  timestamp: Date;
  type: 'ingest' | 'run_tee' | 'post_root' | 'execute';
  params: Record<string, unknown>;
  result: 'success' | 'pending' | 'failed';
  details?: string;
}

// Wallet Types
export interface WalletState {
  connected: boolean;
  address: string | null;
  network: string;
  balance: string;
  voucherBalance: string;
  isAdmin: boolean;
  sessionPaused: boolean;
}

// App Settings
export interface AppSettings {
  showTechnicalDetails: boolean;
  adminModeEnabled: boolean;
  autoRunMatching: boolean;
  autoPostRoot: boolean;
  accentIntensity: number; // 0-100
}
