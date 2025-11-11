#!/bin/bash

# Load environment variables from .env file
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Check if Stripe CLI is installed
if ! command -v stripe &> /dev/null; then
  echo "Error: Stripe CLI is not installed"
  echo ""
  echo "Install it using one of these methods:"
  echo "  • macOS: brew install stripe/stripe-cli/stripe"
  echo "  • npm: npm install -g stripe"
  echo "  • Download: https://github.com/stripe/stripe-cli/releases/latest"
  exit 1
fi

# Check if STRIPE_API_KEY is set
if [ -z "$STRIPE_API_KEY" ]; then
  echo "Error: STRIPE_API_KEY not found in .env file"
  exit 1
fi

# Check if STRIPE_PROJECT_NAME is set
if [ -z "$STRIPE_PROJECT_NAME" ]; then
  echo "Error: STRIPE_PROJECT_NAME not found in .env file"
  exit 1
fi

# Check if an event type was provided
if [ -z "$1" ]; then
  echo "Usage: ./stripe-trigger.sh <event-type>"
  echo ""
  echo "Examples:"
  echo "  ./stripe-trigger.sh payment_intent.succeeded"
  echo "  ./stripe-trigger.sh customer.created"
  echo "  ./stripe-trigger.sh subscription.created"
  echo ""
  echo "Available events:"
  stripe trigger --help
  exit 1
fi

# Run Stripe CLI trigger using API key and project name
stripe --project-name "$STRIPE_PROJECT_NAME" \
  trigger "$@" \
  --api-key "$STRIPE_API_KEY"
