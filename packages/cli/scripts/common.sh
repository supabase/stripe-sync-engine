#!/bin/bash

# Common functions for integration tests

# Start PostgreSQL if not already running
# Usage: start_postgres [container_name] [database_name]
start_postgres() {
    local container_name="${1:-stripe-sync-test-db}"
    local database_name="${2:-app_db}"

    echo "🐘 Checking PostgreSQL..."

    # Check if PostgreSQL is accessible on port 5432
    if pg_isready -h localhost -p 5432 -U postgres > /dev/null 2>&1 || \
       docker ps --format '{{.Ports}}' | grep -q '0.0.0.0:5432->5432'; then
        echo "✓ PostgreSQL is already running and accessible"
        echo ""
        return 0
    fi

    # Check if our container exists but is stopped
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "   Starting existing PostgreSQL container..."
        docker start "$container_name" > /dev/null 2>&1
    else
        echo "   Creating PostgreSQL Docker container..."
        docker run --name "$container_name" \
            -e POSTGRES_PASSWORD=postgres \
            -e POSTGRES_DB="$database_name" \
            -p 5432:5432 \
            -d postgres:16-alpine > /dev/null 2>&1
    fi

    echo "   Waiting for PostgreSQL to be ready..."
    sleep 3

    # Wait for PostgreSQL to be ready
    for i in {1..10}; do
        if pg_isready -h localhost -p 5432 -U postgres > /dev/null 2>&1 || \
           docker exec "$container_name" pg_isready -U postgres > /dev/null 2>&1; then
            echo "✓ PostgreSQL is ready"
            echo ""
            return 0
        fi
        sleep 1
    done

    echo "❌ PostgreSQL failed to start"
    echo ""
    return 1
}

# Stop and remove PostgreSQL container (only if it was created by us)
# Usage: stop_postgres [container_name]
stop_postgres() {
    local container_name="${1:-stripe-sync-test-db}"

    # Only stop/remove if the container exists with our specific name
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "   Stopping PostgreSQL container: $container_name"
        docker stop "$container_name" > /dev/null 2>&1 || true
        docker rm "$container_name" > /dev/null 2>&1 || true
    else
        echo "   Skipping PostgreSQL cleanup (using existing instance)"
    fi
}

# Check for required tools
# Usage: check_required_tools tool1 tool2 ...
check_required_tools() {
    echo "🔧 Checking prerequisites..."
    local missing=0

    for tool in "$@"; do
        if ! command -v "$tool" &> /dev/null; then
            echo "❌ $tool not found - required for this test"
            missing=1
        else
            echo "✓ $tool found"
        fi
    done

    if [ $missing -eq 1 ]; then
        exit 1
    fi
    echo ""
}

# Load environment variables from .env file
# Usage: load_env_file
load_env_file() {
    if [ -f .env ]; then
        echo "✓ Loading environment variables from .env"
        export $(cat .env | grep -v '^#' | xargs)
    else
        echo "❌ .env file not found"
        exit 1
    fi
}

# Check required environment variables
# Usage: check_env_vars VAR1 VAR2 ...
check_env_vars() {
    echo "🔐 Checking environment variables..."
    local missing=0

    for var in "$@"; do
        if [ -z "${!var}" ]; then
            echo "❌ Missing required environment variable: $var"
            missing=1
        else
            echo "✓ $var is set"
        fi
    done

    if [ $missing -eq 1 ]; then
        echo ""
        echo "Required environment variables: $@"
        exit 1
    fi
    echo ""
}
