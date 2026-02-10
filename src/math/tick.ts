import BN from 'bn.js';

/**
 * Tick math utilities for Cetus CLMM
 * Based on Uniswap V3 tick math
 */

const MAX_TICK = 443636;
const MIN_TICK = -443636;
const TICK_SPACING = 1;

// Magic constants from Uniswap V3 TickMath
// Each constant represents 1/sqrt(1.0001^(2^i)) in Q128 format
const MAGIC_CONSTANTS: [number, BN][] = [
  [0x1,     new BN('fffcb933bd6fad37aa2d162d1a594001', 16)],
  [0x2,     new BN('fff97272373d413259a46990580e213a', 16)],
  [0x4,     new BN('fff2e50f5f656932ef12357cf3c7fdcc', 16)],
  [0x8,     new BN('ffe5caca7e10e4e61c3624eaa0941cd0', 16)],
  [0x10,    new BN('ffcb9843d60f6159c9db58835c926644', 16)],
  [0x20,    new BN('ff973b41fa98c081472e6896dfb254c0', 16)],
  [0x40,    new BN('ff2ea16466c96a3843ec78b326b52861', 16)],
  [0x80,    new BN('fe5dee046a99a2a811c461f1969c3053', 16)],
  [0x100,   new BN('fcbe86c7900a88aedcffc83b479aa3a4', 16)],
  [0x200,   new BN('f987a7253ac413176f2b074cf7815e54', 16)],
  [0x400,   new BN('f3392b0822b70005940c7a398e4b70f3', 16)],
  [0x800,   new BN('e7159475a2c29b7443b29c7fa6e889d9', 16)],
  [0x1000,  new BN('d097f3bdfd2022b8845ad8f792aa5825', 16)],
  [0x2000,  new BN('a9f746462d870fdf8a65dc1f90e061e5', 16)],
  [0x4000,  new BN('70d869a156d2a1b890bb3df62baf32f7', 16)],
  [0x8000,  new BN('31be135f97d08fd981231505542fcfa6', 16)],
  [0x10000, new BN('9aa508b5b7a84e1c677de54f3e99bc9', 16)],
  [0x20000, new BN('5d6af8dedb81196699c329225ee604', 16)],
  [0x40000, new BN('2216e584f5fa1ea926041bedfe98', 16)],
  [0x80000, new BN('48a170391f7dc42444e8fa2', 16)],
];

// 2^128 in Q128 format (represents 1.0)
const Q128_ONE = new BN('100000000000000000000000000000000', 16);

// Maximum uint256 for inversion
const MAX_UINT256 = new BN('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16);

export class TickMath {
  /**
   * Get the sqrt price for a given tick index in Q64.64 format
   * Uses Uniswap V3 magic constants for efficient, precise computation.
   */
  static tickIndexToSqrtPriceX64(tickIndex: number): BN {
    if (tickIndex < MIN_TICK || tickIndex > MAX_TICK) {
      throw new Error('Tick index out of bounds');
    }

    const absTick = Math.abs(tickIndex);

    // Start with 1.0 in Q128 format
    let ratio = (absTick & 0x1) !== 0
      ? new BN('fffcb933bd6fad37aa2d162d1a594001', 16)
      : Q128_ONE.clone();

    // Multiply by each magic constant for each set bit
    for (let i = 1; i < MAGIC_CONSTANTS.length; i++) {
      const [bit, constant] = MAGIC_CONSTANTS[i];
      if ((absTick & bit) !== 0) {
        ratio = ratio.mul(constant).shrn(128);
      }
    }

    // For positive ticks, invert the ratio
    if (tickIndex > 0) {
      ratio = MAX_UINT256.div(ratio);
    }

    // Convert from Q128 to Q64.64 by shifting right 64 bits
    return ratio.shrn(64);
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
