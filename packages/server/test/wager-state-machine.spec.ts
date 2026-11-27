/**
 * Issue #69 — Property-based tests for the wager state machine.
 *
 * Uses fast-check to generate random sequences of operations (create, accept,
 * decline, cancel, stake, settle, abort, reconcile, and gateway faults) and
 * checks the following invariants after every step:
 *
 *   I1. A wager reaches `won` only when its pot is `resolved`.
 *   I2. A wager reaches `refunded` only when its pot is `refunded` (or the pot
 *       never existed, e.g. cancelled before the pot was opened).
 *   I3. Terminal states (won, refunded, cancelled, failed) never change once set.
 *   I4. No transition skips a status: every step follows the documented FSM edges.
 *
 * Run with a fixed seed so CI is deterministic:
 *   jest --runInBand --testNamePattern "wager state machine"
 *
 * The seed is passed via the FAST_CHECK_SEED env var so it can be overridden
 * when reproducing a shrunk counterexample.
 */

import * as fc from 'fast-check';
import { randomUUID } from 'crypto';
import { TERMINAL_STATUSES, WagerStatus } from '../src/wager/wager.entity';
import { Harness, STAKE, createHarness, twoLinkedPlayers } from './harness';
import { Wager } from '../src/wager/wager.entity';
import { PotStatus } from '../src/escrow/escrow.gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All valid FSM edges as (from → to) pairs. */
const VALID_EDGES: Array<[WagerStatus, WagerStatus]> = [
  [WagerStatus.PENDING, WagerStatus.AWAITING_STAKES],
  [WagerStatus.PENDING, WagerStatus.CANCELLED],
  [WagerStatus.PENDING, WagerStatus.FAILED],       // openPot hard failure
  [WagerStatus.AWAITING_STAKES, WagerStatus.STAKED],
  [WagerStatus.AWAITING_STAKES, WagerStatus.SETTLING],
  [WagerStatus.AWAITING_STAKES, WagerStatus.FAILED],
  [WagerStatus.STAKED, WagerStatus.SETTLING],
  [WagerStatus.SETTLING, WagerStatus.WON],
  [WagerStatus.SETTLING, WagerStatus.REFUNDED],
  [WagerStatus.SETTLING, WagerStatus.FAILED],
];

function isValidEdge(from: WagerStatus, to: WagerStatus): boolean {
  if (from === to) return true; // no-op / idempotent call
  return VALID_EDGES.some(([f, t]) => f === from && t === to);
}

/** Checks all four invariants for a wager at a given moment. */
async function assertInvariants(
  h: Harness,
  wagerId: string,
  prevStatus: WagerStatus,
  label: string,
): Promise<void> {
  const wager = await h.wagers.findById(wagerId);
  const pot = await h.gateway.getPot(wagerId);

  // I3 — terminal states never change.
  if (TERMINAL_STATUSES.includes(prevStatus)) {
    expect(wager.status).toBe(prevStatus);
  }

  // I4 — only valid FSM edges.
  expect(isValidEdge(prevStatus, wager.status)).toBe(true);

  // I1 — won iff pot is resolved.
  if (wager.status === WagerStatus.WON) {
    expect(pot?.status).toBe<PotStatus>('resolved');
  }

  // I2 — refunded iff pot is refunded (or no pot at all — wager cancelled
  // before the pot was ever opened).
  if (wager.status === WagerStatus.REFUNDED) {
    const potOk = !pot || pot.status === 'refunded';
    expect(potOk).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

type Op =
  | { kind: 'accept' }
  | { kind: 'decline' }
  | { kind: 'cancel'; who: 'A' | 'B' }
  | { kind: 'stakeA' }
  | { kind: 'stakeB' }
  | { kind: 'settle'; winner: 'A' | 'B' | 'draw' }
  | { kind: 'abort' }
  | { kind: 'reconcile' }
  | { kind: 'fault'; method: 'openPot' | 'submitStake' | 'resolve' | 'refund'; fault: 'lose' | 'drop' | 'fail' };

/** Arbitrary that generates one operation. */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: 'accept' }),
  fc.constant<Op>({ kind: 'decline' }),
  fc.record<Op>({ kind: fc.constant('cancel'), who: fc.constantFrom('A', 'B') } as any) as fc.Arbitrary<Op>,
  fc.constant<Op>({ kind: 'stakeA' }),
  fc.constant<Op>({ kind: 'stakeB' }),
  fc.record({
    kind: fc.constant('settle' as const),
    winner: fc.constantFrom<'A' | 'B' | 'draw'>('A', 'B', 'draw'),
  }),
  fc.constant<Op>({ kind: 'abort' }),
  fc.constant<Op>({ kind: 'reconcile' }),
  fc.record({
    kind: fc.constant('fault' as const),
    method: fc.constantFrom<'openPot' | 'submitStake' | 'resolve' | 'refund'>(
      'openPot',
      'submitStake',
      'resolve',
      'refund',
    ),
    fault: fc.constantFrom<'lose' | 'drop' | 'fail'>('lose', 'drop', 'fail'),
  }),
);

/** A sequence of 1–25 operations. */
const sequenceArb: fc.Arbitrary<Op[]> = fc.array(opArb, { minLength: 1, maxLength: 25 });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('wager state machine (property-based, issue #69)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      reconcile: { enabled: false, maxAttempts: 8 },
    });
  }, 60_000);

  afterAll(() => h.close());

  beforeEach(() => h.gateway.reset());

  // -------------------------------------------------------------------------
  // Core property: random operation sequences never violate invariants
  // -------------------------------------------------------------------------

  it(
    'random operation sequences preserve all four invariants',
    async () => {
      const seed = process.env.FAST_CHECK_SEED ? parseInt(process.env.FAST_CHECK_SEED, 10) : 42;

      await fc.assert(
        fc.asyncProperty(sequenceArb, async (ops) => {
          // Each run uses fresh players and a fresh wager.
          h.gateway.reset();
          const { alice, bob } = await twoLinkedPlayers(h);
          const wager = await h.wagers.create({
            matchId: randomUUID(),
            playerAId: alice.id,
            playerBId: bob.id,
            stakeAmount: STAKE,
          });

          let prev = wager.status;

          for (const op of ops) {
            try {
              switch (op.kind) {
                case 'accept':
                  await h.wagers.accept(wager.id, bob.id);
                  break;
                case 'decline':
                  await h.wagers.decline(wager.id, bob.id);
                  break;
                case 'cancel':
                  await h.wagers.cancel(wager.id, op.who === 'A' ? alice.id : bob.id);
                  break;
                case 'stakeA':
                  await h.wagers.submitStake(wager.id, alice.id, null);
                  break;
                case 'stakeB':
                  await h.wagers.submitStake(wager.id, bob.id, null);
                  break;
                case 'settle':
                  await h.wagers.settle(
                    wager.id,
                    op.winner === 'draw'
                      ? { draw: true }
                      : { winnerId: op.winner === 'A' ? alice.id : bob.id },
                  );
                  break;
                case 'abort':
                  await h.wagers.abort(wager.id, 'property test abort');
                  break;
                case 'reconcile':
                  await h.wagers.reconcile(wager.id);
                  break;
                case 'fault':
                  // Queue the fault so the NEXT relevant gateway call misbehaves.
                  h.gateway.inject(op.method, op.fault);
                  break;
              }
            } catch {
              // Expected: service throws BadRequestException / ForbiddenException
              // for invalid transitions. Those don't corrupt state; we just check
              // invariants on whatever the current DB state is.
            }

            await assertInvariants(h, wager.id, prev, `op=${op.kind}`);
            prev = (await h.wagers.findById(wager.id)).status;
          }
        }),
        {
          seed,
          numRuns: 200,
          verbose: false,
        },
      );
    },
    // Each of 200 runs can hit Postgres; allow generous time.
    300_000,
  );

  // -------------------------------------------------------------------------
  // Targeted invariant checks (always run, seed-independent)
  // -------------------------------------------------------------------------

  it('terminal states never change after won', async () => {
    const { alice, bob } = await twoLinkedPlayers(h);
    const wager = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    await h.wagers.accept(wager.id, bob.id);
    await h.wagers.submitStake(wager.id, alice.id, null);
    await h.wagers.submitStake(wager.id, bob.id, null);
    await h.wagers.settle(wager.id, { winnerId: alice.id });

    // Every subsequent mutating call must leave status as WON.
    for (const call of [
      () => h.wagers.accept(wager.id, bob.id),
      () => h.wagers.settle(wager.id, { winnerId: bob.id }),
      () => h.wagers.abort(wager.id, 'too late'),
      () => h.wagers.reconcile(wager.id),
    ]) {
      await call().catch(() => {});
      expect((await h.wagers.findById(wager.id)).status).toBe(WagerStatus.WON);
    }
  });

  it('terminal states never change after refunded', async () => {
    const { alice, bob } = await twoLinkedPlayers(h);
    const w = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    await h.wagers.accept(w.id, bob.id);
    await h.wagers.submitStake(w.id, alice.id, null);
    await h.wagers.submitStake(w.id, bob.id, null);
    await h.wagers.settle(w.id, { draw: true });

    for (const call of [
      () => h.wagers.settle(w.id, { draw: true }),
      () => h.wagers.abort(w.id, 'too late'),
      () => h.wagers.reconcile(w.id),
    ]) {
      await call().catch(() => {});
      expect((await h.wagers.findById(w.id)).status).toBe(WagerStatus.REFUNDED);
    }
  });

  it('terminal states never change after cancelled', async () => {
    const { alice, bob } = await twoLinkedPlayers(h);
    const w = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    await h.wagers.decline(w.id, bob.id);

    for (const call of [
      () => h.wagers.accept(w.id, bob.id),
      () => h.wagers.cancel(w.id, alice.id),
      () => h.wagers.reconcile(w.id),
    ]) {
      await call().catch(() => {});
      expect((await h.wagers.findById(w.id)).status).toBe(WagerStatus.CANCELLED);
    }
  });

  it('won only when pot is resolved: drop before resolve → reconcile → won', async () => {
    h.gateway.reset();
    const { alice, bob } = await twoLinkedPlayers(h);
    const w = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    await h.wagers.accept(w.id, bob.id);
    await h.wagers.submitStake(w.id, alice.id, null);
    await h.wagers.submitStake(w.id, bob.id, null);

    // The resolve call "drops" (pending outcome, pot still staked).
    h.gateway.inject('resolve', 'drop');
    const settling = await h.wagers.settle(w.id, { winnerId: alice.id });
    expect(settling.status).toBe(WagerStatus.SETTLING);
    expect((await h.gateway.getPot(w.id))?.status).toBe('staked');

    // After reconcile the pot gets resolved and the wager becomes won.
    const reconciled = await h.wagers.reconcile(w.id);
    expect(reconciled.status).toBe(WagerStatus.WON);
    expect((await h.gateway.getPot(w.id))?.status).toBe('resolved');
  });

  it('refunded only when pot is refunded: drop before refund → reconcile → refunded', async () => {
    h.gateway.reset();
    const { alice, bob } = await twoLinkedPlayers(h);
    const w = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    await h.wagers.accept(w.id, bob.id);
    await h.wagers.submitStake(w.id, alice.id, null);
    await h.wagers.submitStake(w.id, bob.id, null);

    h.gateway.inject('refund', 'drop');
    const settling = await h.wagers.settle(w.id, { draw: true });
    expect(settling.status).toBe(WagerStatus.SETTLING);
    expect((await h.gateway.getPot(w.id))?.status).toBe('staked');

    const reconciled = await h.wagers.reconcile(w.id);
    expect(reconciled.status).toBe(WagerStatus.REFUNDED);
    expect((await h.gateway.getPot(w.id))?.status).toBe('refunded');
  });

  it('no transition skips a status (pending → staked requires awaiting_stakes first)', async () => {
    const { alice, bob } = await twoLinkedPlayers(h);
    const w = await h.wagers.create({
      matchId: randomUUID(),
      playerAId: alice.id,
      playerBId: bob.id,
      stakeAmount: STAKE,
    });
    // Cannot stake while still pending (pot not open yet).
    await expect(h.wagers.submitStake(w.id, alice.id, null)).rejects.toThrow(/not taking stakes/);
    expect((await h.wagers.findById(w.id)).status).toBe(WagerStatus.PENDING);

    await h.wagers.accept(w.id, bob.id);
    expect((await h.wagers.findById(w.id)).status).toBe(WagerStatus.AWAITING_STAKES);

    // Cannot settle while awaiting stakes (not staked yet).
    await expect(h.wagers.settle(w.id, { winnerId: alice.id })).rejects.toThrow(/Only a staked wager/);
    expect((await h.wagers.findById(w.id)).status).toBe(WagerStatus.AWAITING_STAKES);
  });
});
