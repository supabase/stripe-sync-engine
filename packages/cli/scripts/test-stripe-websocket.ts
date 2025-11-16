#!/usr/bin/env tsx

/**
 * POC Test: Check if regular Stripe API keys can create StripeCLI WebSocket sessions
 *
 * This tests whether the internal /v1/stripecli/sessions endpoint is accessible
 * with a standard test API key, or if it requires special permissions.
 */

import dotenv from 'dotenv'
import chalk from 'chalk'

dotenv.config()

const STRIPE_API_KEY = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY

if (!STRIPE_API_KEY) {
  console.error(chalk.red('Error: STRIPE_API_KEY environment variable not set'))
  console.log(chalk.yellow('\nSet your Stripe API key in .env file:'))
  console.log(chalk.gray('STRIPE_API_KEY=sk_test_...'))
  process.exit(1)
}

if (!STRIPE_API_KEY.startsWith('sk_test_')) {
  console.error(chalk.red('Error: Only test mode API keys are supported for WebSocket sessions'))
  console.log(chalk.yellow('Your key starts with:'), STRIPE_API_KEY.substring(0, 8))
  process.exit(1)
}

console.log(chalk.blue('🧪 Testing Stripe WebSocket Session API\n'))
console.log(chalk.gray('API Key:'), STRIPE_API_KEY.substring(0, 12) + '...')
console.log(chalk.gray('Endpoint:'), 'POST https://api.stripe.com/v1/stripecli/sessions\n')

async function testStripeWebSocketSession() {
  const params = new URLSearchParams({
    device_name: 'stripe-sync-engine-poc-test',
    'websocket_features[]': 'webhooks', // Valid: webhooks, request_logs, or v2_events
    forward_to_url: 'http://localhost:3000/stripe-webhooks',
  })

  console.log(chalk.blue('Sending request...'))

  try {
    // Attempt to match Stripe CLI headers
    const clientUserAgent = JSON.stringify({
      name: 'stripe-cli',
      version: '1.19.0',
      publisher: 'stripe',
      os: process.platform,
      uname: `${process.platform} ${process.arch}`,
    })

    const response = await fetch('https://api.stripe.com/v1/stripecli/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Stripe/v1 stripe-cli/1.19.0',
        'X-Stripe-Client-User-Agent': clientUserAgent,
      },
      body: params.toString(),
    })

    console.log(chalk.cyan(`\nHTTP Status: ${response.status} ${response.statusText}\n`))

    const contentType = response.headers.get('content-type')
    const responseText = await response.text()

    if (response.ok) {
      // Success! Parse JSON response
      const session = JSON.parse(responseText)

      console.log(chalk.green('✅ SUCCESS! WebSocket session created!\n'))
      console.log(chalk.cyan('Session Details:'))
      console.log(
        chalk.gray('  WebSocket URL:'),
        session.WebSocketURL || session.websocket_url || 'N/A'
      )
      console.log(
        chalk.gray('  WebSocket ID:'),
        session.WebSocketID || session.websocket_id || 'N/A'
      )
      console.log(
        chalk.gray('  Feature:'),
        session.WebSocketAuthorizedFeature || session.websocket_authorized_feature || 'N/A'
      )
      console.log(
        chalk.gray('  Reconnect Delay:'),
        session.ReconnectDelay || session.reconnect_delay || 'N/A'
      )

      console.log(chalk.green('\n✅ Your API key has access to the stripecli/sessions endpoint!'))
      console.log(
        chalk.green('✅ We can implement the WebSocket client without Stripe CLI dependency!\n')
      )

      return true
    } else {
      // Failed - analyze error
      console.log(chalk.red('❌ FAILED: Could not create WebSocket session\n'))

      let errorData
      try {
        errorData = JSON.parse(responseText)
      } catch {
        errorData = { raw: responseText }
      }

      console.log(chalk.yellow('Error Response:'))
      console.log(JSON.stringify(errorData, null, 2))

      // Check for specific error patterns
      if (
        responseText.includes('permission') ||
        responseText.includes('authorized') ||
        responseText.includes('stripecli_session_write')
      ) {
        console.log(
          chalk.red('\n❌ Permission Denied: API key lacks stripecli_session_write permission')
        )
        console.log(
          chalk.yellow('📋 This is an internal-only permission that regular API keys do not have.')
        )
        console.log(
          chalk.yellow('📋 Fallback: We need to use Stripe CLI (spawn process) instead.\n')
        )
      } else if (responseText.includes('live')) {
        console.log(
          chalk.red('\n❌ Live mode not supported: StripeCLI sessions only work with test keys')
        )
      } else {
        console.log(chalk.yellow('\n⚠️  Unknown error - check response above'))
      }

      return false
    }
  } catch (error) {
    console.log(chalk.red('❌ Request failed with exception:\n'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
      console.error(chalk.gray(error.stack))
    }
    return false
  }
}

testStripeWebSocketSession()
  .then((success) => {
    process.exit(success ? 0 : 1)
  })
  .catch((error) => {
    console.error(chalk.red('Unexpected error:'), error)
    process.exit(1)
  })
