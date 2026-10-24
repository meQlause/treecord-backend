import { describe, expect, it } from 'vitest';
import { fundingSteps } from '../../../../src/worker/autofund/autofund.rules.js';

const usdc = (whole: number): bigint => BigInt(whole) * BigInt(1_000_000);

describe('fundingSteps', () => {
  it('an empty operator wallet mints the shortfall, approves the campaign, then contributes the rest', () => {
    expect(fundingSteps({ remaining: usdc(10_000), balance: usdc(0), allowance: usdc(0) })).toEqual(
      [
        { kind: 'mint', amount: usdc(10_000) },
        { kind: 'approve', amount: usdc(10_000) },
        { kind: 'contribute', amount: usdc(10_000) },
      ],
    );
  });

  it('picks up a pass that stopped half way: a balance and an allowance already there are not sent again', () => {
    expect(fundingSteps({ remaining: usdc(4), balance: usdc(3), allowance: usdc(4) })).toEqual([
      { kind: 'mint', amount: usdc(1) },
      { kind: 'contribute', amount: usdc(4) },
    ]);
    expect(fundingSteps({ remaining: usdc(4), balance: usdc(9), allowance: usdc(9) })).toEqual([
      { kind: 'contribute', amount: usdc(4) },
    ]);
  });

  it('a full campaign needs nothing', () => {
    expect(fundingSteps({ remaining: usdc(0), balance: usdc(0), allowance: usdc(0) })).toEqual([]);
  });
});
