/**
 * Issue #70 — Integration tests: crash in the middle of a payout.
 *
 * Crash-safe settlement is a headline claim of the toolkit. These tests prove
 * the three hardest crash windows:
 *
 *   Scenario A — Crash *before* submit (the reconciler re-submits).
 *     Intent is committed (wager moves to `settling`), but the process crashes
 *     before the payout transaction is submitted. The on-chain pot is still
 *     `staked`. Reconcile must detect the stale `settling` row, submit the
 *     payout, and move the wager to `won` exactly once.
 *
 *   Scenario B — Crash *after* submit (the reconciler finds `resolved` and
 *     marks `won` without a second payout).
 *     The transaction lands on-chain, but the process crashes before it can
 *     record the result. The pot is now `resolved`. Reconcile must read the
 *     pot, recognise the payout already happened, and mark `won` — without
 *     issuing a second `resolve` call.
 *
 *   Scenario C — Crash during refund.
 *     Same pattern as Scenario B but for refunds: the `refund` transaction
 *     lands, the process crashes, reconcile reads pot=refunded and marks
 *     the wager `refunded` without calling `refund` again.
 *
 * Token-balance verification: because the mock gateway stores pot state in
 * the same Postgres schema as the wager, every assertion about "nobody was
 * paid twice" is enforced by checking the mock pot's `status` and `winner`
 * fields — the same fields the real contract would update — and counting
 * how many times `resolve` / `refund` was actually called through
 * `gateway.calls`.
 */

import { randomUUID } from 'crypto';
import { SettlementKind, WagerStatus } from '../src/wager/wager.entity';
import { Harness, STAKE, createHarness, twoLinkedPlayers } from './harness';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fully-staked wager, ready for settlement. */
async function stakedWager(h: Harness) {
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
  return { wager, alice, bob };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('crash-safe settlement (issue #70)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      reconcile: { enabled: false, maxAttempts: 8 },
    });
  }, 60_000);

  afterAll(() => h.close());

  beforeEach(() => {
    h.gateway.reset();
    h.events.length = 0;
  });

  // -------------------------------------------------------------------------
  // Scenario A — crash before submit
  // -------------------------------------------------------------------------

  describe('Scenario A: crash before payout is submitted', () => {
    it('reconciler submits the payout and the winner is paid exactly once', async () => {
      const { wager, alice } = await stakedWager(h);

      // Simulate a crash *before* submission: inject a `drop` on `resolve` so
      // the call never reaches the mock (pot stays `staked`), simulating the
      // process dying before the transaction was sent.
      h.gateway.inject('resolve', 'drop');
      const settling = await h.wagers.settle(wager.id, { winnerId: alice.id });

      // Intent committed, pot still open.
      expect(settling.status).toBe(WagerStatus.SETTLING);
      expect(settling.settlementKind).toBe(SettlementKind.PAYOUT);
      expect(settling.winnerId).toBe(alice.id);
      expect((await h.gateway.getPot(wager.id))?.status).toBe('staked');

      // Reset the call log so we can count fresh reconcile calls.
      h.gateway.calls.length = 0;

      // The reconciler re-submits (no fault injected now).
      const reconciled = await h.wagers.reconcile(wager.id);

      // Wager is now won.
      expect(reconciled.status).toBe(WagerStatus.WON);
      expect(reconciled.winnerId).toBe(alice.id);

      // Pot is resolved (payment happened exactly once).
      const pot = await h.gateway.getPot(wager.id);
      expect(pot?.status).toBe('resolved');
      expect(pot?.winner).toBe(alice.address);

      // `resolve` was called exactly once during reconcile (not a second time
      // by `settle`, which had already dropped its call).
      expect(h.gateway.calls.filter((c) => c === 'resolve')).toHaveLength(1);

      // Exactly one `wager.won` event was emitted.
      expect(h.events.filter((e) => e.type === 'wager.won' && e.wager.id === wager.id)).toHaveLength(1);
    });

    it('reconciler re-submits a payout that was dropped multiple times', async () => {
      const { wager, bob } = await stakedWager(h);

      // Drop the first two resolve calls, then let the third through.
      h.gateway.inject('resolve', 'drop', 'drop');

      await h.wagers.settle(wager.id, { winnerId: bob.id });
      expect((await h.wagers.findById(wager.id)).status).toBe(WagerStatus.SETTLING);

      // First reconcile: drop again.
      await h.wagers.reconcile(wager.id);
      expect((await h.wagers.findById(wager.id)).status).toBe(WagerStatus.SETTLING);

      // Second reconcile: succeeds.
      const final = await h.wagers.reconcile(wager.id);
      expect(final.status).toBe(WagerStatus.WON);
      expect(final.winnerId).toBe(bob.id);
      expect((await h.gateway.getPot(wager.id))?.status).toBe('resolved');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario B — crash after submit (payout already landed)
  // -------------------------------------------------------------------------

  describe('Scenario B: crash after payout transaction lands', () => {
    it('reconciler finds the pot resolved and marks won without a second payout', async () => {
      const { wager, bob } = await stakedWager(h);

      // `lose`: the transaction lands (pot becomes resolved) but the caller
      // receives `pending` — simulating the process crashing after the tx was
      // accepted but before it could record the confirmed outcome.
      h.gateway.inject('resolve', 'lose');
      const after = await h.wagers.settle(wager.id, { winnerId: bob.id });

      // The wager may already be `won` (the reconcile step inside settle reads
      // the pot and sees `resolved`), or still `settling` if the settlement
      // path returned early after the pending outcome.
      const potAfterSettle = await h.gateway.getPot(wager.id);
      expect(potAfterSettle?.status).toBe('resolved');
      expect([WagerStatus.SETTLING, WagerStatus.WON]).toContain(after.status);

      // Reset call log before reconcile.
      h.gateway.calls.length = 0;

      const reconciled = await h.wagers.reconcile(wager.id);
      expect(reconciled.status).toBe(WagerStatus.WON);
      expect(reconciled.winnerId).toBe(bob.id);

      // Pot unchanged — still resolved.
      expect((await h.gateway.getPot(wager.id))?.status).toBe('resolved');

      // `resolve` must NOT have been called again during reconcile (the pot
      // was already resolved; issuing a second resolve would be a double-pay).
      expect(h.gateway.calls.filter((c) => c === 'resolve')).toHaveLength(0);

      // Exactly one won event total.
      expect(h.events.filter((e) => e.type === 'wager.won' && e.wager.id === wager.id)).toHaveLength(1);
    });

    it('balance invariant: winner gains exactly one stake, loser keeps nothing extra', async () => {
      // With the mock gateway the "token balance" is captured through the pot's
      // winner field and status. Verify that only the declared winner is set.
      const { wager, alice, bob } = await stakedWager(h);
      h.gateway.inject('resolve', 'lose');

      await h.wagers.settle(wager.id, { winnerId: alice.id });
      const pot = await h.gateway.getPot(wager.id);

      // Only alice's address is recorded as winner — bob was not credited.
      expect(pot?.status).toBe('resolved');
      expect(pot?.winner).toBe(alice.address);
      expect(pot?.winner).not.toBe(bob.address);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario C — crash during refund
  // -------------------------------------------------------------------------

  describe('Scenario C: crash during refund', () => {
    it('reconciler finds the pot refunded and marks wager refunded without a second refund', async () => {
      const { wager } = await stakedWager(h);

      // `lose`: the refund transaction lands (pot becomes refunded) but the
      // response comes back as `pending`.
      h.gateway.inject('refund', 'lose');
      const after = await h.wagers.settle(wager.id, { draw: true });

      const potAfterSettle = await h.gateway.getPot(wager.id);
      expect(potAfterSettle?.status).toBe('refunded');
      expect([WagerStatus.SETTLING, WagerStatus.REFUNDED]).toContain(after.status);

      h.gateway.calls.length = 0;

      const reconciled = await h.wagers.reconcile(wager.id);
      expect(reconciled.status).toBe(WagerStatus.REFUNDED);

      // Pot still refunded — no second refund was issued.
      expect((await h.gateway.getPot(wager.id))?.status).toBe('refunded');
      expect(h.gateway.calls.filter((c) => c === 'refund')).toHaveLength(0);

      expect(h.events.filter((e) => e.type === 'wager.refunded' && e.wager.id === wager.id)).toHaveLength(1);
    });

    it('drop before refund: reconciler submits the refund and marks refunded', async () => {
      const { wager } = await stakedWager(h);

      // `drop`: refund never reached the gateway (pot still staked).
      h.gateway.inject('refund', 'drop');
      await h.wagers.settle(wager.id, { draw: true });
      expect((await h.wagers.findById(wager.id)).status).toBe(WagerStatus.SETTLING);
      expect((await h.gateway.getPot(wager.id))?.status).toBe('staked');

      h.gateway.calls.length = 0;

      const reconciled = await h.wagers.reconcile(wager.id);
      expect(reconciled.status).toBe(WagerStatus.REFUNDED);
      expect((await h.gateway.getPot(wager.id))?.status).toBe('refunded');

      // The reconciler submitted exactly one refund.
      expect(h.gateway.calls.filter((c) => c === 'refund')).toHaveLength(1);

      expect(h.events.filter((e) => e.type === 'wager.refunded' && e.wager.id === wager.id)).toHaveLength(1);
    });

    it('balance invariant: both players refunded, neither holds the other\'s stake', async () => {
      // In the mock gateway a refund clears both playerAStaked and playerBStaked,
      // confirming both players' stakes were returned.
      const { wager } = await stakedWager(h);
      h.gateway.inject('refund', 'lose');

      await h.wagers.settle(wager.id, { draw: true });
      const pot = await h.gateway.getPot(wager.id);

      expect(pot?.status).toBe('refunded');
      // After refund the mock clears both staked flags (see mock-escrow.gateway).
      expect(pot?.playerAStaked).toBe(false);
      expect(pot?.playerBStaked).toBe(false);
    });

    it('abort during awaiting_stakes triggers a refund of whatever was staked', async () => {
      const { alice, bob } = await twoLinkedPlayers(h);
      const w = await h.wagers.create({
        matchId: randomUUID(),
        playerAId: alice.id,
        playerBId: bob.id,
        stakeAmount: STAKE,
      });
      await h.wagers.accept(w.id, bob.id);
      await h.wagers.submitStake(w.id, alice.id, null);
      // Only alice staked; bob didn't. Abort should refund.

      const aborted = await h.wagers.abort(w.id, 'server crash recovery');

      expect(aborted.status).toBe(WagerStatus.REFUNDED);
      expect(aborted.settlementKind).toBe(SettlementKind.REFUND);
      expect((await h.gateway.getPot(w.id))?.status).toBe('refunded');

      // No wager.won event was ever emitted.
      expect(h.events.filter((e) => e.type === 'wager.won')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-scenario: concurrent reconcile calls don't double-pay
  // -------------------------------------------------------------------------

  it('concurrent reconcile calls after a crash pay out exactly once', async () => {
    const { wager, alice } = await stakedWager(h);

    h.gateway.inject('resolve', 'drop');
    await h.wagers.settle(wager.id, { winnerId: alice.id });

    h.gateway.calls.length = 0;

    // Fire two reconcile calls concurrently — only one should win the
    // conditional update and call resolve.
    await Promise.all([
      h.wagers.reconcile(wager.id),
      h.wagers.reconcile(wager.id),
    ]);

    // The pot must be resolved, not doubly-resolved.
    const pot = await h.gateway.getPot(wager.id);
    expect(pot?.status).toBe('resolved');

    // `resolve` called at most once (the second reconcile either finds the
    // wager already won or loses the conditional update).
    expect(h.gateway.calls.filter((c) => c === 'resolve').length).toBeLessThanOrEqual(1);

    // Exactly one `wager.won` event.
    expect(h.events.filter((e) => e.type === 'wager.won' && e.wager.id === wager.id)).toHaveLength(1);
  });
});
