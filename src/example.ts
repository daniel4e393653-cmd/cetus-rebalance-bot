/**
 * Example usage of CetusRebalanceBot
 * 
 * This file demonstrates how to use the bot programmatically
 * instead of running it as a standalone service.
 */

import { CetusRebalanceBot, RebalanceConfig } from './index';

async function example() {
  // Configuration
  const config: RebalanceConfig = {
    network: 'mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io',
    privateKey: 'your_private_key_here', // Replace with your private key
    checkIntervalSeconds: 30,
    slippagePercent: 0.5,
    rebalanceEnabled: true
  };

  // Create bot instance
  const bot = new CetusRebalanceBot(config);

  // Get bot status
  console.log('Bot status:', bot.getStatus());

  // Get all wallet positions
  const positions = await bot.getWalletPositions();
  console.log('Positions:', positions);

  // Check if a specific position is out of range
  if (positions.length > 0) {
    const position = positions[0];
    const isOutOfRange = await bot.isPositionOutOfRange(position);
    console.log(`Position ${position.positionId} is out of range:`, isOutOfRange);

    // Rebalance a specific position (if needed)
    if (isOutOfRange) {
      console.log('Rebalancing position...');
      // await bot.rebalancePosition(position);
    }
  }

  // Start the bot (continuous monitoring)
  // bot.start();

  // Stop the bot after some time
  // setTimeout(() => bot.stop(), 60000); // Stop after 1 minute
}

// Run example
example().catch(console.error);
