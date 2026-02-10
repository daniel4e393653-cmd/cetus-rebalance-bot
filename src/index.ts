import { initCetusSDK, CetusClmmSDK, Position, Pool, ClmmPositionStatus } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiTransactionBlockResponse, SuiTransactionBlockResponseOptions } from '@mysten/sui/client';
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
  rpcUrls: string[];
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

type SignAndExecuteTransactionBlockArgs = {
  transactionBlock: Transaction;
  signer: Ed25519Keypair;
  options?: SuiTransactionBlockResponseOptions;
};

type SignAndExecuteTransactionArgs = {
  transaction: Transaction;
  signer: Ed25519Keypair;
  options?: SuiTransactionBlockResponseOptions;
};

type TransactionExecutorClient =
  | {
      signAndExecuteTransactionBlock: (
        args: SignAndExecuteTransactionBlockArgs
      ) => Promise<SuiTransactionBlockResponse>;
      signAndExecuteTransaction?: (
        args: SignAndExecuteTransactionArgs
      ) => Promise<SuiTransactionBlockResponse>;
    }
  | {
      signAndExecuteTransaction: (
        args: SignAndExecuteTransactionArgs
      ) => Promise<SuiTransactionBlockResponse>;
      signAndExecuteTransactionBlock?: (
        args: SignAndExecuteTransactionBlockArgs
      ) => Promise<SuiTransactionBlockResponse>;
    };

class CetusRebalanceBot {
  private sdk: CetusClmmSDK;
  private keypair: Ed25519Keypair;
  private config: RebalanceConfig;
  private isRunning: boolean = false;
  private lastCheckTime: Date | null = null;
  private currentRpcIndex: number = 0;
  private poolCache: Map<string, { pool: Pool; timestamp: number }> = new Map();
  private readonly POOL_CACHE_TTL = 5000; // 5 seconds cache

  constructor(config: RebalanceConfig) {
    this.config = config;
    
    // Initialize SDK with first RPC URL
    this.sdk = initCetusSDK({
      network: config.network,
      fullNodeUrl: config.rpcUrls[0]
    });

    // Initialize keypair from private key
    this.keypair = Ed25519Keypair.fromSecretKey(
      Buffer.from(config.privateKey.replace('0x', ''), 'hex')
    );

    // Set sender address
    this.sdk.senderAddress = this.keypair.getPublicKey().toSuiAddress();
    
    logger.info(`Bot initialized for address: ${this.sdk.senderAddress}`);
    logger.info(`Network: ${config.network}`);
    logger.info(`RPC URLs configured: ${config.rpcUrls.length}`);
    logger.info(`Check interval: ${config.checkIntervalSeconds} seconds`);
    logger.info(`Rebalance enabled: ${config.rebalanceEnabled}`);
  }

  /**
   * Get next RPC URL using round-robin
   */
  private getNextRpcUrl(): string {
    const url = this.config.rpcUrls[this.currentRpcIndex];
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpcUrls.length;
    return url;
  }

  /**
   * Reinitialize SDK with next RPC URL (for failover)
   */
  private switchToNextRpc(): void {
    const nextUrl = this.getNextRpcUrl();
    logger.info(`Switching to RPC: ${nextUrl}`);
    
    this.sdk = initCetusSDK({
      network: this.config.network,
      fullNodeUrl: nextUrl
    });
    this.sdk.senderAddress = this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Get pool with caching and retry logic
   */
  private async getPoolWithCache(poolId: string, maxRetries = 3): Promise<Pool> {
    // Check cache first
    const cached = this.poolCache.get(poolId);
    if (cached && Date.now() - cached.timestamp < this.POOL_CACHE_TTL) {
      logger.debug(`Using cached pool data for ${poolId}`);
      return cached.pool;
    }

    // Fetch with retry logic
    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const pool = await this.sdk.Pool.getPool(poolId);
        
        // Cache the result
        this.poolCache.set(poolId, { pool, timestamp: Date.now() });
        
        return pool;
      } catch (error) {
        lastError = error;
        logger.warn(`Failed to fetch pool ${poolId} (attempt ${attempt + 1}/${maxRetries}): ${error}`);
        
        if (attempt < maxRetries - 1) {
          // Switch to next RPC for retry
          this.switchToNextRpc();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    throw new Error(`Failed to fetch pool after ${maxRetries} attempts: ${lastError}`);
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
          // Skip deleted or non-existent positions
          if (pos.position_status !== ClmmPositionStatus.Exists) {
            logger.debug(`Skipping position ${pos.pos_object_id} with status: ${pos.position_status}`);
            continue;
          }

          // Get pool info to get coin types
          const pool = await this.getPoolWithCache(pos.pool);
          
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
      const pool = await this.getPoolWithCache(position.poolId);
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
      
      const pool = await this.getPoolWithCache(position.poolId);
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
   * Sign and execute a transaction block with timeout, retries, and automatic RPC failover.
   * This function:
   * - Executes the transaction with a 15-second timeout
   * - Retries up to 3 times if it fails or times out
   * - Automatically switches to the next RPC URL on each failure
   * - Logs detailed success/failure messages for each step
   * - Confirms the transaction succeeded before returning
   */
  private async signAndExecuteTransactionBlockCompat(
    tx: Transaction,
    options: SuiTransactionBlockResponseOptions = { showEffects: true, showEvents: true }
  ): Promise<SuiTransactionBlockResponse> {
    const maxRetries = 3;
    const timeoutMs = 15000; // 15 seconds
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.debug(`Transaction attempt ${attempt + 1}/${maxRetries}`);
        
        // Execute transaction with timeout
        const result = await this.executeTransactionWithTimeout(tx, options, timeoutMs);
        
        // Validate transaction result
        this.validateTransactionResult(result, 'Transaction execution failed');
        
        logger.info(`✓ Transaction succeeded: ${result.digest}`);
        
        // Wait for transaction confirmation
        await this.waitForTransaction(result.digest);
        
        logger.info(`✓ Transaction confirmed: ${result.digest}`);
        
        return result;
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`✗ Transaction attempt ${attempt + 1}/${maxRetries} failed: ${errorMsg}`);
        
        if (error instanceof Error && error.stack) {
          logger.debug(`Error stack: ${error.stack}`);
        }
        
        // Switch to next RPC on failure (except for last attempt)
        if (attempt < maxRetries - 1) {
          this.switchToNextRpc();
          logger.info(`Retrying with next RPC endpoint...`);
          
          // Wait a bit before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // All retries failed
    const finalError = lastError instanceof Error ? lastError.message : String(lastError);
    logger.error(`✗ Transaction failed after ${maxRetries} attempts: ${finalError}`);
    throw new Error(`Transaction failed after ${maxRetries} attempts: ${finalError}`);
  }

  /**
   * Execute transaction with timeout wrapper
   */
  private async executeTransactionWithTimeout(
    tx: Transaction,
    options: SuiTransactionBlockResponseOptions,
    timeoutMs: number
  ): Promise<SuiTransactionBlockResponse> {
    let timeoutId: NodeJS.Timeout | null = null;
    
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Transaction execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Create execution promise
    const executionPromise = this.executeTransaction(tx, options);

    try {
      // Race between execution and timeout
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      // Clean up timeout if execution completed first
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Execute transaction using the appropriate client method
   */
  private async executeTransaction(
    tx: Transaction,
    options: SuiTransactionBlockResponseOptions
  ): Promise<SuiTransactionBlockResponse> {
    const client = this.sdk.fullClient as TransactionExecutorClient;

    if (typeof client.signAndExecuteTransactionBlock === 'function') {
      return client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer: this.keypair,
        options
      });
    }

    if (typeof client.signAndExecuteTransaction === 'function') {
      return client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options
      });
    }

    throw new Error('Client does not support signAndExecuteTransactionBlock or signAndExecuteTransaction methods');
  }

  /**
   * Remove all liquidity from a position
   */
  private async removeAllLiquidity(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Removing liquidity from position ${position.positionId}`);
      
      const pool = await this.getPoolWithCache(position.poolId);
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

      const { tokenMinA, tokenMinB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        false
      );

      // Build remove liquidity transaction
      const removeLiquidityParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        delta_liquidity: position.liquidity,
        min_amount_a: tokenMinA.toString(),
        min_amount_b: tokenMinB.toString(),
        pool_id: position.poolId,
        pos_id: position.positionId,
        rewarder_coin_types: [],
        collect_fee: true
      };

      logger.debug(`Building remove liquidity transaction for position ${position.positionId}`);
      const tx = await this.sdk.Position.removeLiquidityTransactionPayload(removeLiquidityParams);
      
      // Sign and execute transaction
      logger.debug(`Signing and executing remove liquidity transaction`);
      const result = await this.signAndExecuteTransactionBlockCompat(tx);
      
      logger.info(`Liquidity removed from position ${position.positionId}. Tx: ${result.digest}`);
    } catch (error) {
      this.logError(`Error removing liquidity from position ${position.positionId}`, error);
      throw error;
    }
  }

  /**
   * Close a position
   */
  private async closePosition(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Closing position ${position.positionId}`);
      
      const pool = await this.getPoolWithCache(position.poolId);
      
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
        collect_fee: false
      };

      logger.debug(`Building close position transaction for position ${position.positionId}`);
      const tx = await this.sdk.Position.closePositionTransactionPayload(closePositionParams);
      
      // Sign and execute transaction
      logger.debug(`Signing and executing close position transaction`);
      const result = await this.signAndExecuteTransactionBlockCompat(tx);
      
      logger.info(`Position ${position.positionId} closed. Tx: ${result.digest}`);
    } catch (error) {
      this.logError(`Error closing position ${position.positionId}`, error);
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

      logger.debug(`Building open position transaction with range [${lowerTick}, ${upperTick}]`);
      const tx = this.sdk.Position.openPositionTransactionPayload(openPositionParams);
      
      // Sign and execute transaction
      logger.debug(`Signing and executing open position transaction`);
      const result = await this.signAndExecuteTransactionBlockCompat(tx, {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true
      });

      logger.info(`New position opened. Tx: ${result.digest}`);

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
      this.logError(`Error opening new position with range [${lowerTick}, ${upperTick}]`, error);
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
      
      const pool = await this.getPoolWithCache(poolId);
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

      // Estimate the correct delta_liquidity from coin amounts at the new tick range
      const estimatedLiquidity = ClmmPoolUtil.estimateLiquidityFromcoinAmounts(
        curSqrtPrice,
        lowerTick,
        upperTick,
        coinAmounts
      );

      // Build add liquidity transaction
      const addLiquidityParams = {
        coinTypeA,
        coinTypeB,
        pool_id: poolId,
        pos_id: positionId,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        delta_liquidity: estimatedLiquidity.toString(),
        max_amount_a: tokenMaxA.toString(),
        max_amount_b: tokenMaxB.toString(),
        collect_fee: false,
        rewarder_coin_types: []
      };

      logger.debug(`Building add liquidity transaction for position ${positionId}`);
      const tx = await this.sdk.Position.createAddLiquidityPayload(addLiquidityParams);
      
      // Sign and execute transaction
      logger.debug(`Signing and executing add liquidity transaction`);
      const result = await this.signAndExecuteTransactionBlockCompat(tx);
      
      logger.info(`Liquidity added to position ${positionId}. Tx: ${result.digest}`);
    } catch (error) {
      this.logError(`Error adding liquidity to position ${positionId}`, error);
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
   * Validate transaction result and throw error if failed
   */
  private validateTransactionResult(result: SuiTransactionBlockResponse, context: string): void {
    const status = result.effects?.status?.status;
    const error = result.effects?.status?.error;
    
    if (status !== 'success') {
      const errorMsg = error || 'Unknown error';
      throw new Error(`${context}: ${errorMsg}`);
    }
  }

  /**
   * Log error with detailed information including stack trace
   */
  private logError(context: string, error: unknown): void {
    logger.error(`${context}: ${error}`);
    if (error instanceof Error && error.stack) {
      logger.error(`Error stack: ${error.stack}`);
    }
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
    this.checkAndRebalance().catch((error) => {
      logger.error(`Error in initial checkAndRebalance: ${error}`);
    });

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

  // Parse RPC URLs - support both comma-separated and single URL
  let rpcUrls: string[];
  if (process.env.RPC_URLS) {
    // Multiple RPC URLs provided (comma-separated)
    rpcUrls = process.env.RPC_URLS.split(',').map(url => url.trim()).filter(url => url.length > 0);
  } else if (process.env.RPC_URL) {
    // Single RPC URL provided (backwards compatibility)
    rpcUrls = [process.env.RPC_URL];
  } else {
    // Default RPC URLs
    rpcUrls = process.env.NETWORK === 'mainnet'
      ? ['https://fullnode.mainnet.sui.io']
      : ['https://fullnode.testnet.sui.io'];
  }

  // Validate URLs
  const validUrls = rpcUrls.filter(url => {
    try {
      new URL(url);
      return true;
    } catch {
      logger.warn(`Invalid RPC URL ignored: ${url}`);
      return false;
    }
  });

  if (validUrls.length === 0) {
    logger.error('No valid RPC URLs configured');
    process.exit(1);
  }

  logger.info(`Configured ${validUrls.length} RPC endpoint(s)`);

  const config: RebalanceConfig = {
    network: process.env.NETWORK as 'mainnet' | 'testnet',
    rpcUrls: validUrls,
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
