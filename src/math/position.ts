import BN from 'bn.js';
import { Percentage } from './percentage';
import { CoinAmounts } from './clmm';

/**
 * Position math utilities
 */

export interface AdjustedCoinAmounts {
  tokenMaxA: BN;
  tokenMaxB: BN;
  tokenMinA: BN;
  tokenMinB: BN;
}

/**
 * Adjust coin amounts for slippage
 */
export function adjustForCoinSlippage(
  coinAmounts: CoinAmounts,
  slippageTolerance: Percentage,
  roundUp: boolean
): AdjustedCoinAmounts {
  const tokenMaxA = slippageTolerance.addSlippage(coinAmounts.coinA, roundUp);
  const tokenMaxB = slippageTolerance.addSlippage(coinAmounts.coinB, roundUp);
  const tokenMinA = slippageTolerance.subtractSlippage(coinAmounts.coinA, !roundUp);
  const tokenMinB = slippageTolerance.subtractSlippage(coinAmounts.coinB, !roundUp);

  return {
    tokenMaxA,
    tokenMaxB,
    tokenMinA,
    tokenMinB
  };
}

/**
 * Calculate liquidity from amounts
 */
export function getLiquidityFromAmounts(
  amountA: BN,
  amountB: BN,
  sqrtPriceLower: BN,
  sqrtPriceUpper: BN,
  curSqrtPrice: BN
): BN {
  if (curSqrtPrice.lt(sqrtPriceLower)) {
    // All in A
    return amountA.mul(sqrtPriceLower.mul(sqrtPriceUpper).shrn(64))
      .div(sqrtPriceUpper.sub(sqrtPriceLower));
  } else if (curSqrtPrice.gte(sqrtPriceUpper)) {
    // All in B
    return amountB.shln(64).div(sqrtPriceUpper.sub(sqrtPriceLower));
  } else {
    // Mixed
    const liquidityA = amountA.mul(curSqrtPrice.mul(sqrtPriceUpper).shrn(64))
      .div(sqrtPriceUpper.sub(curSqrtPrice));
    const liquidityB = amountB.shln(64).div(curSqrtPrice.sub(sqrtPriceLower));
    return liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
  }
}
