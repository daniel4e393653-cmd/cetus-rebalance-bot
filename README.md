# Cetus Liquidity Rebalance Bot

A lightweight, automated liquidity rebalance bot for Cetus Protocol on the Sui Network. This bot monitors your concentrated liquidity positions and automatically rebalances them when they go out of range, maintaining the same liquidity amount and range width.

## Features

- **Automated Monitoring**: Checks your positions every 30 seconds (configurable)
- **Auto-Rebalancing**: Automatically rebalances positions when they go out of range
- **Same Parameters**: Maintains the same liquidity amount and range width after rebalancing
- **Fee Collection**: Collects fees before rebalancing
- **Safe Execution**: Includes slippage protection and transaction confirmation
- **Comprehensive Logging**: Detailed logs for all operations
- **Dry Run Mode**: Monitor-only mode for testing
- **Multiple RPC Support**: Load balancing across multiple RPC endpoints for better performance
- **Smart Caching**: Reduces redundant API calls with intelligent pool data caching
- **Automatic Failover**: Automatically retries failed requests with different RPC endpoints

## Prerequisites

- Node.js 18+ 
- npm or yarn
- A Sui wallet with private key
- SUI tokens for gas fees
- Existing Cetus liquidity positions

## Installation

### 1. Clone or Download the Project

```bash
cd cetus-rebalance-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Required: Network (mainnet or testnet)
NETWORK=mainnet

# Required: Your wallet's private key (64 character hex string)
# WARNING: Never share or commit this key!
PRIVATE_KEY=your_private_key_here

# Optional: Multiple RPC URLs (comma-separated) for better performance and reliability
# The bot will distribute requests across these endpoints and automatically retry on failure
RPC_URLS=https://fullnode.mainnet.sui.io,https://sui-mainnet-rpc.allthatnode.com

# Optional: Check interval in seconds (default: 30)
CHECK_INTERVAL_SECONDS=30

# Optional: Slippage tolerance in percent (default: 0.5)
SLIPPAGE_PERCENT=0.5

# Optional: Enable/disable rebalancing (default: true)
REBALANCE_ENABLED=true

# Optional: Log level
LOG_LEVEL=info
```

### 4. Build the Project

```bash
npm run build
```

## Usage

### Start the Bot

```bash
npm start
```

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Watch Mode (rebuild on changes)

```bash
npm run watch
```

## How It Works

### Position Monitoring

1. The bot fetches all your Cetus liquidity positions
2. For each position, it checks if the current pool price is within the position's tick range
3. If the price is outside the range, the position is flagged for rebalancing

### Rebalancing Process

When a position is out of range, the bot:

1. **Removes Liquidity**: Removes all liquidity from the old position and collects fees
2. **Closes Position**: Closes the old position NFT
3. **Opens New Position**: Creates a new position with the same range width, centered around the current price
4. **Adds Liquidity**: Adds the same liquidity amount to the new position

### Example

```
Original Position:
- Range: [1000, 2000]
- Liquidity: 1000000
- Current tick: 2500 (OUT OF RANGE)

After Rebalance:
- Range: [2000, 3000] (same 1000 width, centered on 2500)
- Liquidity: 1000000 (same amount)
- Current tick: 2500 (IN RANGE)
```

## Configuration Options

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NETWORK` | Yes | - | Network to connect to (`mainnet` or `testnet`) |
| `PRIVATE_KEY` | Yes | - | Wallet private key (64 hex chars) |
| `RPC_URLS` | No | Auto | Comma-separated list of RPC endpoints for load balancing and failover |
| `RPC_URL` | No | Auto | Single RPC endpoint (deprecated, use `RPC_URLS` instead) |
| `CHECK_INTERVAL_SECONDS` | No | 30 | How often to check positions |
| `SLIPPAGE_PERCENT` | No | 0.5 | Slippage tolerance for transactions |
| `REBALANCE_ENABLED` | No | true | Enable/disable actual rebalancing |
| `LOG_LEVEL` | No | info | Logging level (debug, info, warn, error) |

## Performance Optimization

The bot includes several performance optimizations to improve speed and reliability:

### Multiple RPC Endpoints

Configure multiple RPC endpoints to distribute API load and improve reliability:

```env
RPC_URLS=https://fullnode.mainnet.sui.io,https://sui-mainnet-rpc.allthatnode.com,https://mainnet.suiet.app
```

**Benefits:**
- **Load Distribution**: Requests are distributed across multiple endpoints using round-robin
- **Automatic Failover**: If one RPC fails, the bot automatically retries with the next endpoint
- **Better Uptime**: Reduces downtime from single RPC endpoint failures
- **Faster Responses**: Multiple endpoints can provide better response times

### Smart Caching

The bot caches pool data for 5 seconds to reduce redundant API calls:
- Pool data is fetched once and reused within the cache window
- Significantly reduces the number of API calls during operations
- Improves overall performance without sacrificing data accuracy

### Retry Logic

Failed API requests are automatically retried up to 3 times with different RPC endpoints, ensuring operations complete successfully even when individual RPCs are slow or unavailable.

## Getting Your Private Key

### From Sui Wallet (Browser Extension)

1. Open Sui Wallet extension
2. Click on your account
3. Select "Export Private Key"
4. Copy the private key (without `0x` prefix)

### From Sui CLI

```bash
sui keytool export --key-identity <key-alias>
```

## Security Considerations

⚠️ **IMPORTANT SECURITY WARNINGS:**

1. **Never share your private key** - Anyone with your private key can access your funds
2. **Never commit `.env` file** - The `.gitignore` is configured to exclude it
3. **Use a dedicated bot wallet** - Don't use your main wallet for the bot
4. **Monitor gas fees** - Ensure your wallet has enough SUI for gas fees
5. **Test on testnet first** - Always test on testnet before mainnet
6. **Review transactions** - Check the logs to verify transaction details

## Monitoring and Logs

The bot logs all activities to:
- Console (real-time)
- `bot.log` file (persistent)

Log levels:
- `debug`: Detailed information for debugging
- `info`: General operational information
- `warn`: Warning messages
- `error`: Error messages

## Troubleshooting

### Common Issues

#### "Insufficient gas"
- Ensure your wallet has enough SUI for transaction fees
- Each rebalance requires ~4 transactions (remove liquidity, close position, open position, add liquidity)

#### "Position not found"
- Verify the wallet address has positions on Cetus
- Check that you're connected to the correct network

#### "Transaction failed"
- Check the logs for specific error messages
- Verify slippage tolerance is appropriate
- Ensure tokens are not locked or frozen

#### "Private key invalid"
- Ensure the private key is 64 characters (hex)
- Remove `0x` prefix if present
- Verify the key is for the correct wallet

### Debug Mode

Set `LOG_LEVEL=debug` in `.env` for detailed logging:

```env
LOG_LEVEL=debug
```

### Dry Run Mode

To test without executing transactions:

```env
REBALANCE_ENABLED=false
```

## Architecture

```
cetus-rebalance-bot/
├── src/
│   ├── index.ts          # Main bot logic
│   └── math/
│       ├── tick.ts       # Tick math utilities
│       ├── clmm.ts       # CLMM math utilities
│       ├── percentage.ts # Percentage calculations
│       └── position.ts   # Position math utilities
├── .env                  # Environment variables (not committed)
├── .env.example          # Example environment file
├── .gitignore           # Git ignore rules
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── README.md            # This file
```

## API Reference

### `CetusRebalanceBot`

Main bot class with the following methods:

#### `constructor(config: RebalanceConfig)`
Creates a new bot instance with the specified configuration.

#### `start(): void`
Starts the bot monitoring loop.

#### `stop(): void`
Stops the bot monitoring loop.

#### `getStatus(): { isRunning, lastCheckTime, address }`
Returns the current bot status.

#### `getWalletPositions(): Promise<PositionInfo[]>`
Fetches all positions owned by the wallet.

#### `isPositionOutOfRange(position): Promise<boolean>`
Checks if a position is currently out of range.

#### `rebalancePosition(position): Promise<void>`
Rebalances a single position.

## Dependencies

- `@cetusprotocol/cetus-sui-clmm-sdk`: Cetus CLMM SDK
- `@mysten/sui`: Sui blockchain SDK
- `bn.js`: Big number operations
- `decimal.js`: Decimal operations
- `dotenv`: Environment variable management
- `winston`: Logging
- `node-cron`: Task scheduling

## License

MIT

## Disclaimer

This software is provided as-is, without warranty of any kind. Use at your own risk. Always test thoroughly on testnet before using on mainnet. The authors are not responsible for any losses incurred from using this software.

## Support

For issues and questions:
- Cetus Protocol Discord: https://discord.gg/cetus
- Cetus Documentation: https://cetus-1.gitbook.io/cetus-developer-docs

## Contributing

Contributions are welcome! Please ensure:
1. Code follows existing style
2. All tests pass
3. Documentation is updated
4. Security best practices are followed
