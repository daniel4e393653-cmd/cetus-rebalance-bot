import BN from 'bn.js';

/**
 * CLMM (Concentrated Liquidity Market Maker) math utilities
 */

export interface CoinAmounts {
  coinA: BN;
  coinB: BN;
}

export interface TokenAmounts {
  coinA: BN;
  coinB: BN;
}

export class ClmmPoolUtil {
  /**
   * Get coin amounts from liquidity
   */
  static getCoinAmountFromLiquidity(
    liquidity: BN,
    curSqrtPrice: BN,
    lowerSqrtPrice: BN,
    upperSqrtPrice: BN,
    roundUp: boolean
  ): CoinAmounts {
    if (curSqrtPrice.lt(lowerSqrtPrice)) {
      // Current price is below the range, all liquidity is in token A
      const amountA = this.getAmountAFromLiquidity(
        liquidity,
        lowerSqrtPrice,
        upperSqrtPrice,
        roundUp
      );
      return { coinA: amountA, coinB: new BN(0) };
    } else if (curSqrtPrice.gte(upperSqrtPrice)) {
      // Current price is above the range, all liquidity is in token B
      const amountB = this.getAmountBFromLiquidity(
        liquidity,
        lowerSqrtPrice,
        upperSqrtPrice,
        roundUp
      );
      return { coinA: new BN(0), coinB: amountB };
    } else {
      // Current price is within the range
      const amountA = this.getAmountAFromLiquidity(
        liquidity,
        curSqrtPrice,
        upperSqrtPrice,
        roundUp
      );
      const amountB = this.getAmountBFromLiquidity(
        liquidity,
        lowerSqrtPrice,
        curSqrtPrice,
        roundUp
      );
      return { coinA: amountA, coinB: amountB };
    }
  }

  /**
   * Get amount A from liquidity
   */
  static getAmountAFromLiquidity(
    liquidity: BN,
    sqrtPriceLower: BN,
    sqrtPriceUpper: BN,
    roundUp: boolean
  ): BN {
    const numerator = liquidity.mul(sqrtPriceUpper.sub(sqrtPriceLower));
    const denominator = sqrtPriceUpper.mul(sqrtPriceLower).shrn(64);
    
    if (roundUp) {
      return numerator.add(denominator.sub(new BN(1))).div(denominator);
    } else {
      return numerator.div(denominator);
    }
  }

  /**
   * Get amount B from liquidity
   */
  static getAmountBFromLiquidity(
    liquidity: BN,
    sqrtPriceLower: BN,
    sqrtPriceUpper: BN,
    roundUp: boolean
  ): BN {
    const amount = liquidity.mul(sqrtPriceUpper.sub(sqrtPriceLower)).shrn(64);
    
    if (roundUp) {
      return amount.add(new BN(1));
    } else {
      return amount;
    }
  }

  /**
   * Estimate liquidity from coin amounts
   */
  static estimateLiquidityFromcoinAmounts(
    curSqrtPrice: BN,
    tickLower: number,
    tickUpper: number,
    tokenAmounts: TokenAmounts
  ): BN {
    // This is a simplified calculation
    // In production, use the proper formula from Cetus SDK
    const lowerSqrtPrice = this.tickIndexToSqrtPriceX64(tickLower);
    const upperSqrtPrice = this.tickIndexToSqrtPriceX64(tickUpper);

    if (curSqrtPrice.lt(lowerSqrtPrice)) {
      // All in A
      return tokenAmounts.coinA
        .mul(lowerSqrtPrice.mul(upperSqrtPrice).shrn(64))
        .div(upperSqrtPrice.sub(lowerSqrtPrice));
    } else if (curSqrtPrice.gte(upperSqrtPrice)) {
      // All in B
      return tokenAmounts.coinB.shln(64).div(upperSqrtPrice.sub(lowerSqrtPrice));
    } else {
      // Mixed
      const liquidityA = tokenAmounts.coinA
        .mul(curSqrtPrice.mul(upperSqrtPrice).shrn(64))
        .div(upperSqrtPrice.sub(curSqrtPrice));
      const liquidityB = tokenAmounts.coinB
        .shln(64)
        .div(curSqrtPrice.sub(lowerSqrtPrice));
      return liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
    }
  }

  /**
   * Estimate coin amounts from total amount
   */
  static estCoinAmountsFromTotalAmount(
    tickLower: number,
    tickUpper: number,
    curSqrtPrice: BN,
    totalAmount: string,
    tokenPriceA: string,
    tokenPriceB: string
  ): { amountA: number; amountB: number } {
    const total = parseFloat(totalAmount);
    const priceA = parseFloat(tokenPriceA);
    const priceB = parseFloat(tokenPriceB);

    const lowerSqrtPrice = this.tickIndexToSqrtPriceX64(tickLower);
    const upperSqrtPrice = this.tickIndexToSqrtPriceX64(tickUpper);

    if (curSqrtPrice.lt(lowerSqrtPrice)) {
      // All in A
      const amountA = total / priceA;
      return { amountA, amountB: 0 };
    } else if (curSqrtPrice.gte(upperSqrtPrice)) {
      // All in B
      const amountB = total / priceB;
      return { amountA: 0, amountB };
    } else {
      // Mixed - simplified 50/50 split for estimation
      const amountA = (total / 2) / priceA;
      const amountB = (total / 2) / priceB;
      return { amountA, amountB };
    }
  }

  /**
   * Convert tick index to sqrt price
   */
  private static tickIndexToSqrtPriceX64(tickIndex: number): BN {
    // Simplified conversion - use proper implementation from TickMath
    const price = Math.pow(1.0001, tickIndex);
    const sqrtPrice = Math.sqrt(price);
    return new BN(Math.floor(sqrtPrice * Math.pow(2, 64)));
  }
}
