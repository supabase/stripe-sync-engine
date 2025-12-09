import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@supabase/stripe-sync-cli'],
}

export default nextConfig
