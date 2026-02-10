import { initCetusSDK, CetusClmmSDK, Position, Pool } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import BN from 'bn.js';
import cron from 'node-cron';
import winston from 'winston';
import dotenv from 'dotenv';
import { TickMath } from './math/tick';
import { ClmmPoolUtil } from './math/clmm';
import { Percentage } from './math/percentage';
import { adjustForCoinSlippage } from './math/position';

dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

interface RebalanceConfig {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  privateKey: string;
  checkIntervalSeconds: number;
  slippagePercent: number;
  rebalanceEnabled: boolean;
}

interface PositionInfo {
  positionId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  coinTypeA: string;
  coinTypeB: string;
}

class CetusRebalanceBot {
  private sdk: CetusClmmSDK;
  private keypair: Ed25519Keypair;
  private config: RebalanceConfig;
  private isRunning: boolean = false;
  private lastCheckTime: Date | null = null;

  constructor(config: RebalanceConfig) {
    this.config = config;
    
    // Initialize SDK
    this.sdk = initCetusSDK({
      network: config.network,
      fullNodeUrl: config.rpcUrl
    });

    // Initialize keypair from private key
    this.keypair = Ed25519Keypair.fromSecretKey(
      Buffer.from(config.privateKey.replace('0x', ''), 'hex')
    );

    // Set sender address
    this.sdk.senderAddress = this.keypair.getPublicKey().toSuiAddress();
    
    logger.info(`Bot initialized for address: ${this.sdk.senderAddress}`);
    logger.info(`Network: ${config.network}`);
    logger.info(`Check interval: ${config.checkIntervalSeconds} seconds`);
    logger.info(`Rebalance enabled: ${config.rebalanceEnabled}`);
  }

  /**
   * Get all positions owned by the wallet
   */
  async getWalletPositions(): Promise<PositionInfo[]> {
    try {
      logger.info('Fetching wallet positions...');
      
      const positionList = await this.sdk.Position.getPositionList(
        this.sdk.senderAddress,
        []
      );

      if (!positionList || positionList.length === 0) {
        logger.info('No positions found for this wallet');
        return [];
      }

      const positions: PositionInfo[] = [];

      for (const pos of positionList) {
        try {
          // Get pool info to get coin types
          const pool = await this.sdk.Pool.getPool(pos.pool);
          
          positions.push({
            positionId: pos.pos_object_id,
            poolId: pos.pool,
            tickLower: Number(pos.tick_lower_index),
            tickUpper: Number(pos.tick_upper_index),
            liquidity: pos.liquidity,
            coinTypeA: pool.coinTypeA,
            coinTypeB: pool.coinTypeB
          });
        } catch (error) {
          logger.error(`Error fetching pool info for position ${pos.pos_object_id}: ${error}`);
        }
      }

      logger.info(`Found ${positions.length} positions`);
      return positions;
    } catch (error) {
      logger.error(`Error fetching wallet positions: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a position is out of range
   */
  async isPositionOutOfRange(position: PositionInfo): Promise<boolean> {
    try {
      const pool = await this.sdk.Pool.getPool(position.poolId);
      const currentTick = Number(pool.current_tick_index);
      
      const isInRange = currentTick >= position.tickLower && currentTick < position.tickUpper;
      
      logger.debug(`Position ${position.positionId}: currentTick=${currentTick}, range=[${position.tickLower}, ${position.tickUpper}], inRange=${isInRange}`);
      
      return !isInRange;
    } catch (error) {
      logger.error(`Error checking position range for ${position.positionId}: ${error}`);
      throw error;
    }
  }

  /**
   * Calculate new tick range centered around current price
   */
  calculateNewTickRange(
    currentTick: number, 
    tickSpacing: number, 
    originalRangeWidth: number
  ): { lowerTick: number; upperTick: number } {
    // Calculate half range (maintaining same width as original)
    const halfRange = Math.floor(originalRangeWidth / 2);
    
    // Calculate new bounds centered on current tick
    let lowerTick = TickMath.getPrevInitializableTickIndex(
      currentTick - halfRange,
      tickSpacing
    );
    
    let upperTick = TickMath.getNextInitializableTickIndex(
      currentTick + halfRange,
      tickSpacing
    );

    // Ensure proper alignment with tick spacing
    lowerTick = Math.floor(lowerTick / tickSpacing) * tickSpacing;
    upperTick = Math.ceil(upperTick / tickSpacing) * tickSpacing;

    return { lowerTick, upperTick };
  }

  /**
   * Rebalance a single position
   * 1. Remove all liquidity from old position
   * 2. Close old position
   * 3. Open new position with same liquidity amount around current price
   * 4. Add liquidity to new position
   */
  async rebalancePosition(position: PositionInfo): Promise<void> {
    if (!this.config.rebalanceEnabled) {
      logger.info(`Rebalance disabled. Skipping rebalance for position ${position.positionId}`);
      return;
    }

    try {
      logger.info(`Starting rebalance for position ${position.positionId}`);
      
      const pool = await this.sdk.Pool.getPool(position.poolId);
      const currentTick = Number(pool.current_tick_index);
      const tickSpacing = Number(pool.tickSpacing);
      
      // Calculate original range width
      const originalRangeWidth = position.tickUpper - position.tickLower;
      
      // Calculate new tick range
      const { lowerTick, upperTick } = this.calculateNewTickRange(
        currentTick,
        tickSpacing,
        originalRangeWidth
      );

      logger.info(`New range: [${lowerTick}, ${upperTick}] (current: ${currentTick})`);

      // Step 1: Remove all liquidity and collect fees from old position
      await this.removeAllLiquidity(position);

      // Step 2: Close old position
      await this.closePosition(position);

      // Step 3: Open new position
      const newPositionId = await this.openNewPosition(
        position.poolId,
        lowerTick,
        upperTick,
        position.coinTypeA,
        position.coinTypeB
      );

      // Step 4: Add liquidity to new position with same amount
      await this.addLiquidityToPosition(
        newPositionId,
        position.poolId,
        position.liquidity,
        lowerTick,
        upperTick,
        position.coinTypeA,
        position.coinTypeB
      );

      logger.info(`Successfully rebalanced position. New position ID: ${newPositionId}`);
    } catch (error) {
      logger.error(`Error rebalancing position ${position.positionId}: ${error}`);
      throw error;
    }
  }

  /**
   * Remove all liquidity from a position
   */
  private async removeAllLiquidity(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Removing liquidity from position ${position.positionId}`);
      
      const pool = await this.sdk.Pool.getPool(position.poolId);
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickLower);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickUpper);
      const liquidity = new BN(position.liquidity);
      
      const slippageTolerance = new Percentage(
        new BN(this.config.slippagePercent * 100),
        new BN(10000)
      );

      // Calculate coin amounts from liquidity
      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidity,
        curSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        false
      );

      const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        false
      );

      // Build remove liquidity transaction
      const removeLiquidityParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        delta_liquidity: position.liquidity,
        min_amount_a: tokenMaxA.toString(),
        min_amount_b: tokenMaxB.toString(),
        pool_id: position.poolId,
        pos_id: position.positionId,
        rewarder_coin_types: [],
        collect_fee: true
      };

      const tx = await this.sdk.Position.removeLiquidityTransactionPayload(removeLiquidityParams);
      
      // Sign and execute transaction
      const result = await this.sdk.fullClient.sendTransaction(this.keypair, tx);
      logger.info(`Liquidity removed. Tx: ${result.digest}`);
      
      // Wait for transaction to be confirmed
      await this.waitForTransaction(result.digest);
    } catch (error) {
      logger.error(`Error removing liquidity: ${error}`);
      throw error;
    }
  }

  /**
   * Close a position
   */
  private async closePosition(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Closing position ${position.positionId}`);
      
      const pool = await this.sdk.Pool.getPool(position.poolId);
      
      // Get rewards for the position
      const rewards = await this.sdk.Rewarder.fetchPositionRewarders(pool, position.positionId);
      const rewardCoinTypes = rewards.map((item: any) => item.coin_address);

      const closePositionParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        min_amount_a: '0',
        min_amount_b: '0',
        rewarder_coin_types: rewardCoinTypes,
        pool_id: position.poolId,
        pos_id: position.positionId,
        collect_fee: true
      };

      const tx = await this.sdk.Position.closePositionTransactionPayload(closePositionParams);
      
      // Sign and execute transaction
      const result = await this.sdk.fullClient.sendTransaction(this.keypair, tx);
      logger.info(`Position closed. Tx: ${result.digest}`);
      
      // Wait for transaction to be confirmed
      await this.waitForTransaction(result.digest);
    } catch (error) {
      logger.error(`Error closing position: ${error}`);
      throw error;
    }
  }

  /**
   * Open a new position
   */
  private async openNewPosition(
    poolId: string,
    lowerTick: number,
    upperTick: number,
    coinTypeA: string,
    coinTypeB: string
  ): Promise<string> {
    try {
      logger.info(`Opening new position with range [${lowerTick}, ${upperTick}]`);
      
      const openPositionParams = {
        coinTypeA,
        coinTypeB,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        pool_id: poolId
      };

      const tx = this.sdk.Position.openPositionTransactionPayload(openPositionParams);
      
      // Sign and execute transaction
      const result = await this.sdk.fullClient.sendTransaction(this.keypair, tx);
      logger.info(`New position opened. Tx: ${result.digest}`);
      
      // Wait for transaction to be confirmed
      await this.waitForTransaction(result.digest);

      // Extract position ID from transaction result
      // The position object is created and we need to find its ID
      const txDetails = await this.sdk.fullClient.getTransactionBlock({
        digest: result.digest,
        options: { showEffects: true, showObjectChanges: true }
      });

      // Find the created position object
      let newPositionId = '';
      if (txDetails.objectChanges) {
        for (const change of txDetails.objectChanges) {
          if (change.type === 'created' && change.objectType?.includes('Position')) {
            newPositionId = change.objectId;
            break;
          }
        }
      }

      if (!newPositionId) {
        throw new Error('Could not find new position ID in transaction result');
      }

      return newPositionId;
    } catch (error) {
      logger.error(`Error opening new position: ${error}`);
      throw error;
    }
  }

  /**
   * Add liquidity to a position
   */
  private async addLiquidityToPosition(
    positionId: string,
    poolId: string,
    liquidity: string,
    lowerTick: number,
    upperTick: number,
    coinTypeA: string,
    coinTypeB: string
  ): Promise<void> {
    try {
      logger.info(`Adding liquidity to position ${positionId}`);
      
      const pool = await this.sdk.Pool.getPool(poolId);
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(lowerTick);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(upperTick);
      const liquidityBN = new BN(liquidity);
      
      const slippageTolerance = new Percentage(
        new BN(this.config.slippagePercent * 100),
        new BN(10000)
      );

      // Calculate coin amounts needed for the liquidity
      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidityBN,
        curSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        false
      );

      const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        false
      );

      // Build add liquidity transaction
      const addLiquidityParams = {
        coinTypeA,
        coinTypeB,
        pool_id: poolId,
        pos_id: positionId,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        delta_liquidity: liquidity,
        max_amount_a: tokenMaxA.toString(),
        max_amount_b: tokenMaxB.toString()
      };

      const tx = await this.sdk.Position.addLiquidityTransactionPayload(addLiquidityParams);
      
      // Sign and execute transaction
      const result = await this.sdk.fullClient.sendTransaction(this.keypair, tx);
      logger.info(`Liquidity added. Tx: ${result.digest}`);
      
      // Wait for transaction to be confirmed
      await this.waitForTransaction(result.digest);
    } catch (error) {
      logger.error(`Error adding liquidity: ${error}`);
      throw error;
    }
  }

  /**
   * Wait for a transaction to be confirmed
   */
  private async waitForTransaction(digest: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      try {
        const tx = await this.sdk.fullClient.getTransactionBlock({
          digest,
          options: { showEffects: true }
        });
        
        if (tx.effects?.status?.status === 'success') {
          logger.info(`Transaction ${digest} confirmed`);
          return;
        } else if (tx.effects?.status?.status === 'failure') {
          throw new Error(`Transaction failed: ${tx.effects.status.error}`);
        }
      } catch (error) {
        // Transaction not found yet, wait and retry
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    throw new Error(`Transaction ${digest} not confirmed after ${maxAttempts} attempts`);
  }

  /**
   * Main check and rebalance loop
   */
  async checkAndRebalance(): Promise<void> {
    try {
      logger.info('=== Starting position check ===');
      this.lastCheckTime = new Date();

      const positions = await this.getWalletPositions();
      
      if (positions.length === 0) {
        logger.info('No positions to check');
        return;
      }

      for (const position of positions) {
        try {
          const isOutOfRange = await this.isPositionOutOfRange(position);
          
          if (isOutOfRange) {
            logger.info(`Position ${position.positionId} is OUT OF RANGE`);
            logger.info(`  Pool: ${position.poolId}`);
            logger.info(`  Current range: [${position.tickLower}, ${position.tickUpper}]`);
            logger.info(`  Liquidity: ${position.liquidity}`);
            
            await this.rebalancePosition(position);
          } else {
            logger.info(`Position ${position.positionId} is IN RANGE`);
          }
        } catch (error) {
          logger.error(`Error processing position ${position.positionId}: ${error}`);
        }
      }

      logger.info('=== Position check completed ===');
    } catch (error) {
      logger.error(`Error in checkAndRebalance: ${error}`);
    }
  }

  /**
   * Start the bot
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    this.isRunning = true;
    logger.info('=== Cetus Rebalance Bot Started ===');

    // Run immediately on start
    this.checkAndRebalance();

    // Schedule periodic checks
    const intervalMs = this.config.checkIntervalSeconds * 1000;
    
    const runCheck = async () => {
      if (!this.isRunning) return;
      await this.checkAndRebalance();
      if (this.isRunning) {
        setTimeout(runCheck, intervalMs);
      }
    };

    setTimeout(runCheck, intervalMs);
  }

  /**
   * Stop the bot
   */
  stop(): void {
    this.isRunning = false;
    logger.info('=== Cetus Rebalance Bot Stopped ===');
  }

  /**
   * Get bot status
   */
  getStatus(): { isRunning: boolean; lastCheckTime: Date | null; address: string } {
    return {
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      address: this.sdk.senderAddress
    };
  }
}

// Main execution
async function main() {
  // Validate environment variables
  const requiredEnvVars = ['PRIVATE_KEY', 'NETWORK'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  const config: RebalanceConfig = {
    network: process.env.NETWORK as 'mainnet' | 'testnet',
    rpcUrl: process.env.RPC_URL || (process.env.NETWORK === 'mainnet' 
      ? 'https://fullnode.mainnet.sui.io' 
      : 'https://fullnode.testnet.sui.io'),
    privateKey: process.env.PRIVATE_KEY!,
    checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '30'),
    slippagePercent: parseFloat(process.env.SLIPPAGE_PERCENT || '0.5'),
    rebalanceEnabled: process.env.REBALANCE_ENABLED !== 'false'
  };

  const bot = new CetusRebalanceBot(config);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    bot.stop();
    process.exit(0);
  });

  // Start the bot
  bot.start();
}

// Run main if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
  });
}

export { CetusRebalanceBot, RebalanceConfig, PositionInfo };
