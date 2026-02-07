

# iExec ShadowPool — Implementation Plan
**Confidential Batch Dark Pool Trading Terminal**

---

## 🎨 Aesthetic Foundation: "Noir Trading Terminal"

### Color Palette
- **Background**: Deep charcoal `#1a1a1a` with subtle noise grain texture overlay
- **Surface layers**: `#242424` (cards), `#2a2a2a` (hover states)
- **Accent**: Amber/Gold `#FFB000` — used sparingly for focus states, active elements, confirmations, and key metrics
- **Text**: Off-white `rgba(255,255,255,0.93)` for body, `rgba(255,255,255,0.60)` for muted
- **Semantic**: Amber for success, `#EF4444` for errors (muted, not neon)

### Typography (Google Fonts)
- **Headings**: Fraunces (variable weight, distinctive serif with optical sizing)
- **Body/UI**: IBM Plex Sans (clean, readable, not generic)
- **Numbers/Code**: IBM Plex Mono (transaction hashes, amounts, addresses)

### Visual Atmosphere
- Subtle noise/grain texture over the entire background (CSS pseudo-element)
- Thin-line contour-map pattern as optional decorative layer
- Asymmetric layouts with optical alignment, not rigid grids
- Cards with 1px amber border on focus, subtle shadows that "whisper"

---

## 🏗️ Architecture & Pages

### 1. Landing Page (`/`)
**Hero Section**
- Bold headline: *"Private intents. Public execution."*
- Subhead explaining the dark pool concept in one line

**Flow Visualization**
- 4-step animated diagram: **Protect → Grant → Match → Execute**
- Each step with an icon, short description, and connecting animated lines
- Steps stagger-reveal on page load (150-250ms offsets)

**Call to Action**
- Three primary actions: "Create Intent", "View Rounds", "Connect Wallet"
- Amber glow on primary CTA, subtle press states

**Trust Elements**
- Privacy guarantee callout: "Your limit price and size never touch the blockchain"
- Powered by iExec TEE + Uniswap v4 badges

---

### 2. Dashboard (`/dashboard`)
**Wallet Summary Card**
- Connected address (truncated with copy button)
- Network badge: "Arbitrum Sepolia"
- Voucher balance placeholder
- Subtle ambient animation (breathing glow border)

**My Intents Table**
- Columns: Token Pair, Side, Amount, Status, Actions
- **Status Pills** with smooth color morphing:
  - Draft (gray) → Protected (blue) → Access Granted (teal) → Submitted (amber) → Matched (green) → Executed (gold) → Expired (muted red)
- Click row to expand details, delete draft actions

**Active Rounds Panel**
- List of ongoing rounds with:
  - Round ID
  - Countdown timer (animated ring)
  - Progress bar showing intake → matching → executable
  - "View Round" action

---

### 3. Create Intent (`/create`)
**Progressive Disclosure Form**
- **Essential Fields** (always visible):
  - Side toggle: Buy / Sell
  - Token Pair picker (searchable dropdown)
  - Amount input (monospace, right-aligned)
  - Limit Price input
  - Expiry selector (relative time: 1hr, 6hr, 24hr, custom)

- **Advanced Fields** (collapsible tray, slides down with easing):
  - Slippage bounds (min/max tolerance)
  - Private notes field
  - Custom authorized user address

**Action Flow**
- Step 1: "Protect Intent (Encrypt)" → Animates to show `protectedDataAddress`
- Step 2: "Grant Access" → Pre-filled authorized app/user inputs
- Step 3: "Submit to Round" → Dropdown to select active round

**Privacy Guarantee Panel**
- Persistent callout explaining TEE confidentiality
- Visual lock icon with subtle pulse

---

### 4. Round Detail (`/round/:id`)
**Round Timeline**
- Horizontal animated timeline: Intake → Matching (TEE) → Root Posted → Executable
- Current phase highlighted with amber accent
- Phase transitions animate smoothly when status changes

**Round Metrics**
- Intents count: "127 intents in this round"
- Matched count
- Round expiry countdown
- Posted merkle root with copy button (monospace, truncated)

**Matches Table**
- Public-only fields: matchId, trader address, tokenIn/Out, amountIn, minAmountOut, expiry
- "Proof Available" badge when executable
- Click to navigate to Execute Trade

**Admin Actions** (visible when admin toggle is on)
- "Run Batch Round (TEE)" button
- "Post Merkle Root" button with mock transaction feedback

---

### 5. Execute Trade (`/execute`)
**Match Selector**
- Dropdown or card-based picker for available matches
- Shows key details: token pair, amounts, expiry

**Hook Data Inspector**
- Collapsible JSON viewer with syntax highlighting
- Copy button for the full payload
- Field explanations on hover

**Execution Panel**
- "Execute via Uniswap v4 Hook" button
- Clear status feedback:
  - Loading spinner during mock execution
  - Success state with confetti burst
  - Error states with human-readable copy:
    - "Invalid proof — the merkle path doesn't match"
    - "Trade expired — submission deadline was 2 hours ago"
    - "Already executed — this match was completed in tx 0x..."

---

### 6. Settings (`/settings`)
**Display Preferences**
- Toggle: "Show Technical Details" (reveals hashes, debug panes globally)
- Accent intensity slider (subtle → vibrant)
- Theme preview swatch

**Admin Mode Toggle**
- Enable/disable Admin/Keeper Console features
- Visible only with mock "admin" wallet

**Resources**
- Links placeholders: Docs, GitHub, Hackathon Submission Checklist
- "About ShadowPool" modal with tech explainer

---

### 7. Admin/Keeper Console (Toggle-activated panel)
**Batch Ingest**
- Text area to paste multiple protectedData addresses
- Validate & parse on input
- "Add to Round" action

**TEE Operations**
- "Run TEE Matching" button with loading state
- "Post Merkle Root" with mock transaction
- Current root display

**Audit Log**
- Timeline of all admin actions
- Each entry: timestamp, action type, parameters, result
- Scrollable, filterable

---

## 🧩 Reusable Component Library

| Component | Purpose |
|-----------|---------|
| `IntentStatusPill` | Animated status badge with morphing colors |
| `TokenPairPicker` | Searchable dropdown with token icons |
| `AmountInput` | Monospace-styled number input with validation |
| `PrivacyCallout` | Persistent trust/security messaging panel |
| `RoundTimeline` | Horizontal phase indicator with animations |
| `MerkleRootCard` | Displays root hash with copy functionality |
| `HookDataInspector` | Collapsible JSON viewer with highlighting |
| `ActionLog` | Timeline component for audit trails |
| `ToastSystem` | Capsule-shaped notifications with smooth animations |
| `CountdownTimer` | Ring/bar countdown with expiry warning states |
| `GrainOverlay` | Noise texture background component |
| `TrayModal` | Slide-up modal with backdrop blur and easeInOutCubic |

---

## ✨ Animation Strategy (Expressive Level)

### Page Load
- Staggered block reveals (150-250ms offsets)
- Main headline scales in with spring physics
- Secondary elements fade up with slight overshoot

### Interactive Elements
- Buttons: Subtle scale (0.98) on press + amber glow pulse
- Status pills: Color morphs over 300ms, no flashing
- Cards: 1px lift on hover, border opacity transition

### Tray Modals
- Slide up with `easeInOutCubic`
- Slight overshoot (1-2px bounce)
- Backdrop blur animates in over 200ms

### Success Celebrations
- Confetti burst on trade execution (particles library or CSS)
- Ring completion animation for round milestones

---

## 🔌 Mock Service Layer

Clean, typed TypeScript service that simulates the real lifecycle:

```typescript
// services/shadowPool.ts
interface Intent { ... }
interface Round { ... }

async function protectData(intent: Intent): Promise<{ protectedDataAddress: string }>
async function grantAccess(protectedDataAddress: string, authorizedApp: string, authorizedUser: string): Promise<{ success: boolean }>
async function runBatchRound(roundId: string, protectedDataAddresses: string[]): Promise<{ matches: Match[] }>
async function postRoundRoot(roundId: string, merkleRoot: string, expiry: number): Promise<{ txHash: string }>
async function executeTradeWithProof(hookData: HookData): Promise<ExecutionResult>
```

Each function simulates realistic delays (1-3 seconds) and returns mock data that mirrors real iExec/on-chain responses.

---

## 📱 Responsive Design

- **Desktop**: Full asymmetric layout, sidebar navigation
- **Tablet**: Stacked layouts, collapsible panels
- **Mobile**: Bottom navigation, full-screen trays, touch-optimized inputs

---

## ♿ Accessibility

- Custom focus rings in amber (visible, not overpowering)
- ARIA labels on all interactive elements
- Keyboard navigation support throughout
- Reduced motion preference detection
- Sufficient contrast ratios (WCAG AA)

---

## 📁 Project Structure

```
src/
├── components/
│   ├── ui/           # Base shadcn components (customized)
│   ├── layout/       # Header, Navigation, Footer
│   ├── intent/       # Intent-related components
│   ├── round/        # Round-related components
│   └── common/       # Shared components (Pills, Inputs, etc.)
├── pages/
│   ├── Landing.tsx
│   ├── Dashboard.tsx
│   ├── CreateIntent.tsx
│   ├── RoundDetail.tsx
│   ├── ExecuteTrade.tsx
│   └── Settings.tsx
├── services/
│   └── shadowPool.ts  # Mock service layer
├── stores/
│   └── useStore.ts    # Global state (Zustand or context)
├── hooks/
│   └── useShadowPool.ts
├── lib/
│   └── mockData.ts    # Sample intents, rounds, matches
└── styles/
    └── index.css      # Custom CSS variables, animations
```

---

## 🎯 Deliverable Summary

A complete, production-grade frontend that:
- Implements all 7 pages with full navigation
- Features the "noir trading terminal" aesthetic with amber accents
- Uses Fraunces + IBM Plex font pairing
- Includes expressive animations with spring physics and staggered reveals
- Provides a mock wallet and service layer ready for real iExec integration
- Works beautifully across desktop, tablet, and mobile
- Passes accessibility checks and feels unmistakably crafted

