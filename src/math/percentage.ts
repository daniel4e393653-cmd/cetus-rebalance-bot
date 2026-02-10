import BN from 'bn.js';

/**
 * Percentage utility class
 */
export class Percentage {
  public numerator: BN;
  public denominator: BN;

  constructor(numerator: BN, denominator: BN) {
    this.numerator = numerator;
    this.denominator = denominator;
  }

  /**
   * Convert to decimal
   */
  toDecimal(): number {
    return this.numerator.toNumber() / this.denominator.toNumber();
  }

  /**
   * Apply percentage to a value
   */
  apply(value: BN, roundUp: boolean = false): BN {
    const result = value.mul(this.numerator).div(this.denominator);
    if (roundUp && value.mul(this.numerator).mod(this.denominator).gt(new BN(0))) {
      return result.add(new BN(1));
    }
    return result;
  }

  /**
   * Add slippage to a value
   */
  addSlippage(value: BN, roundUp: boolean = false): BN {
    const slippageAmount = this.apply(value, roundUp);
    return value.add(slippageAmount);
  }

  /**
   * Subtract slippage from a value
   */
  subtractSlippage(value: BN, roundUp: boolean = false): BN {
    const slippageAmount = this.apply(value, roundUp);
    return value.sub(slippageAmount);
  }

  /**
   * From decimal
   */
  static fromDecimal(decimal: number): Percentage {
    const denominator = new BN(10000);
    const numerator = new BN(Math.floor(decimal * 10000));
    return new Percentage(numerator, denominator);
  }

  /**
   * From percent string (e.g., "0.5" for 0.5%)
   */
  static fromPercent(percent: string): Percentage {
    return this.fromDecimal(parseFloat(percent));
  }
}
