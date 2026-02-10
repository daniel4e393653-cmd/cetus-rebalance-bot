import BN from 'bn.js';

/**
 * Tick math utilities for Cetus CLMM
 * Based on Uniswap V3 tick math
 */

const MAX_TICK = 443636;
const MIN_TICK = -443636;
const TICK_SPACING = 1;

// sqrt(1.0001) in Q64.96 format
const SQRT_RATIO_1_0001 = new BN('102084710076281216349245697447631535106');

export class TickMath {
  /**
   * Get the sqrt price for a given tick index
   */
  static tickIndexToSqrtPriceX64(tickIndex: number): BN {
    if (tickIndex < MIN_TICK || tickIndex > MAX_TICK) {
      throw new Error('Tick index out of bounds');
    }

    const absTick = Math.abs(tickIndex);
    let ratio = new BN('18446744073709551616'); // 2^64

    // Calculate sqrt(1.0001^tick) using binary exponentiation
    const tickBits = absTick.toString(2).split('').reverse();
    
    for (let i = 0; i < tickBits.length; i++) {
      if (tickBits[i] === '1') {
        ratio = ratio.mul(SQRT_RATIO_1_0001.pow(new BN(2 ** i))).shrn(64 * i);
      }
    }

    if (tickIndex < 0) {
      ratio = new BN('340282366920938463463374607431768211456').div(ratio); // 2^128 / ratio
    }

    return ratio;
  }

  /**
   * Get the tick index for a given sqrt price
   */
  static sqrtPriceX64ToTickIndex(sqrtPriceX64: BN): number {
    // Approximate log base sqrt(1.0001) of (sqrtPriceX64 / 2^64)
    const price = sqrtPriceX64.toNumber() / Math.pow(2, 64);
    const tick = Math.floor(Math.log(price) / Math.log(1.0001));
    return Math.max(MIN_TICK, Math.min(MAX_TICK, tick));
  }

  /**
   * Get the previous initializable tick index
   */
  static getPrevInitializableTickIndex(tickIndex: number, tickSpacing: number): number {
    return Math.floor(tickIndex / tickSpacing) * tickSpacing;
  }

  /**
   * Get the next initializable tick index
   */
  static getNextInitializableTickIndex(tickIndex: number, tickSpacing: number): number {
    return Math.ceil(tickIndex / tickSpacing) * tickSpacing;
  }

  /**
   * Check if a tick is initializable (aligned with tick spacing)
   */
  static isTickInitializable(tickIndex: number, tickSpacing: number): boolean {
    return tickIndex % tickSpacing === 0;
  }
}
