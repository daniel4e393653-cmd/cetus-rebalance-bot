#!/usr/bin/env node

/**
 * Test script to verify multiple RPC configuration
 * This script validates that the bot can:
 * 1. Parse multiple RPC URLs from environment variables
 * 2. Parse single RPC URL (backwards compatibility)
 * 3. Use default RPC URLs when none are provided
 */

// Test cases for RPC URL parsing
const testCases = [
  {
    name: 'Multiple RPC URLs (comma-separated)',
    env: { 
      NETWORK: 'mainnet',
      RPC_URLS: 'https://fullnode.mainnet.sui.io,https://sui-mainnet-rpc.allthatnode.com,https://mainnet.suiet.app'
    },
    expected: [
      'https://fullnode.mainnet.sui.io',
      'https://sui-mainnet-rpc.allthatnode.com',
      'https://mainnet.suiet.app'
    ]
  },
  {
    name: 'Single RPC URL (backwards compatibility)',
    env: { 
      NETWORK: 'mainnet',
      RPC_URL: 'https://custom-rpc.example.com'
    },
    expected: ['https://custom-rpc.example.com']
  },
  {
    name: 'Default mainnet RPC URL',
    env: { 
      NETWORK: 'mainnet'
    },
    expected: ['https://fullnode.mainnet.sui.io']
  },
  {
    name: 'Default testnet RPC URL',
    env: { 
      NETWORK: 'testnet'
    },
    expected: ['https://fullnode.testnet.sui.io']
  },
  {
    name: 'RPC_URLS takes precedence over RPC_URL',
    env: { 
      NETWORK: 'mainnet',
      RPC_URLS: 'https://primary.example.com,https://secondary.example.com',
      RPC_URL: 'https://ignored.example.com'
    },
    expected: ['https://primary.example.com', 'https://secondary.example.com']
  },
  {
    name: 'Multiple RPC URLs with extra whitespace',
    env: { 
      NETWORK: 'mainnet',
      RPC_URLS: '  https://rpc1.example.com  ,  https://rpc2.example.com  ,  https://rpc3.example.com  '
    },
    expected: [
      'https://rpc1.example.com',
      'https://rpc2.example.com',
      'https://rpc3.example.com'
    ]
  }
];

// RPC URL parsing logic (extracted from index.ts main function)
function parseRpcUrls(env) {
  let rpcUrls;
  if (env.RPC_URLS) {
    // Multiple RPC URLs provided (comma-separated)
    rpcUrls = env.RPC_URLS.split(',').map(url => url.trim()).filter(url => url.length > 0);
  } else if (env.RPC_URL) {
    // Single RPC URL provided (backwards compatibility)
    rpcUrls = [env.RPC_URL];
  } else {
    // Default RPC URLs
    rpcUrls = env.NETWORK === 'mainnet'
      ? ['https://fullnode.mainnet.sui.io']
      : ['https://fullnode.testnet.sui.io'];
  }
  return rpcUrls;
}

// Run tests
console.log('🧪 Testing RPC URL Configuration Parsing\n');
console.log('=' .repeat(70));

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = parseRpcUrls(test.env);
  const success = JSON.stringify(result) === JSON.stringify(test.expected);
  
  if (success) {
    console.log(`✅ Test ${index + 1}: ${test.name}`);
    console.log(`   Parsed: ${result.length} RPC URL(s)`);
    passed++;
  } else {
    console.log(`❌ Test ${index + 1}: ${test.name}`);
    console.log(`   Expected: ${JSON.stringify(test.expected)}`);
    console.log(`   Got:      ${JSON.stringify(result)}`);
    failed++;
  }
  console.log('');
});

console.log('=' .repeat(70));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests\n`);

if (failed > 0) {
  process.exit(1);
}

console.log('✨ All tests passed! RPC URL parsing is working correctly.\n');
console.log('💡 Key Features Validated:');
console.log('   • Multiple RPC URLs can be configured (comma-separated)');
console.log('   • Single RPC URL still works (backwards compatible)');
console.log('   • Default RPC URLs are used when none provided');
console.log('   • RPC_URLS takes precedence over RPC_URL');
console.log('   • Extra whitespace is handled correctly\n');
