# Living Dividend — Member-facing UX Design

**Date:** 2026-07-01
**Status:** DRAFT (design pass; no code yet)
**Author:** Joi (with Garrett)
**Related:** ADR-019, `2026-07-01-living-dividend-design.md`,
`workspace/contracts-drafts/LivingDividend.compact` (contract v0.2)

## Core mental model to convey

The dividend is not a coupon. It's not a payment. It's not a bonus. It's a
**share of the network's activity that grew for you while you weren't
looking.** Every kWh anyone consumed, anywhere, added a little to your
balance.

UX has to make that feel true: real-time growth, visible, slow, unglamorous,
solid.

## Screens

### Screen 1 — Dividend tab (new tab in consumer app)

- Headline: `Your share` — big number in kWh, smaller ≈ KES underneath
- Rate line: "Growing at 0.03 kWh / hr" (computed client-side from recent
  DividendMinted events)
- Primary button: `[ Claim to my wallet ]` — one button, no amount picker
- Total earned since joining (running counter)
- Health indicator: `● Alive · Last activity 12 days ago`
  - Turns amber near T-30
  - Never alarm-language

### Screen 2 — Post-claim confirmation

- Zero drama: `12.847 kWh claimed / Sent to your wallet`
- Subtle prompt of what they can do with the EBT: use for power, hold,
  send, cash out (nod to full liquidity per ADR-018)

### Screen 3 — First-run walkthrough (3 cards, no jargon)

1. **What this is:** "Every time anyone in the network buys power, a
   little of that goes into a pool. Every verified member gets an equal
   share."
2. **How it grows:** "You don't have to do anything for it to grow.
   Come check on it, claim it, whenever you want."
3. **Why it stays alive:** "Open the app once every few months so we
   know you're still around. If we don't hear from you for 180 days,
   your share goes back to help everyone else."

Target reading level: Swahili 5th-grade. No "dividend," "accumulator,"
or "blockchain."

### Screen 4 — Empty state (pre-registration)

- Ties KYC to a concrete benefit: "Complete your KYC to join the Living
  Dividend and start earning your share"
- Reassurance: "It's free. It stays yours. It grows on its own."

## Auto-touch behavior

- On every app open, if `lastSeen + 30 days < now`, silently submit
  `touchLiveness` in background. Sponsored DUST. No user awareness.
- Member has to actively not open app for 6 months to reach T (180 days).
- **Exception:** if `hasPendingPrune(me) == true`, show full-screen
  "You've been away — we've kept your share safe. Tap to keep it."
  On tap: submit `touchLiveness`. Turns grace period into a real second
  chance.

## Notifications (minimal)

1. Right after registration: "You're in. Your share starts growing now. ✨"
2. Monthly summary (opt-in, off by default): "This month your share grew
   by X kWh."
3. Amber-tier prune warning (T-30, on-device): "You haven't opened the
   app in 5 months. Come see your share."

That's it. No daily nag. No "claim now!" No badges. The system's dignity
depends on not begging for attention.

## Denomination principle

kWh first, KES second everywhere. EBT is power (ADR-019). KES is the
derived approximation. Reinforces the framing without pedagogy.

## Contract implications discovered by this design

**None.** Two potential needs surfaced:
1. "Growing at X kWh/hr" — computed off-chain by watching recent
   `DividendMinted` events on the indexer. No contract change.
2. Rate projection — `getStats().totalLivingMembers` + event history is
   sufficient. Existing readers cover it.

**Contract is UX-complete as-is.**

## Handoff to app team

When the LD tab ships, needed API surface from pollpower-v2-api:

```
GET  /api/ld/member-state          → getMemberState(me) result + isLive flag
GET  /api/ld/claimable             → getClaimableAmount(me) result
GET  /api/ld/rate-hint             → recent bump events, computed rate
POST /api/ld/claim                 → build + sponsor + submit claim tx
POST /api/ld/touch                 → build + sponsor + submit touchLiveness tx
GET  /api/ld/prune-status          → hasPendingPrune(me)
```

Same relay pattern as v7 transfers (DUST-sponsored, user-signed).

## Open UX questions (for a later pass)

- Exact copy in Swahili + English — needs bilingual review before pilot
- Onboarding illustration style — matches existing consumer app or new?
- Cooperative view: if members are part of a cooperative, does the
  cooperative see aggregate LD activity? (ADR-006 territory, deferrable)
- Notification opt-in/out UI location
- Recovery flow UI when member reports lost phone → cooperative attests →
  new address registered (this is the ADR-019 §6.1(a) unregister/register
  flow made concrete)
