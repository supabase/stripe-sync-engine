import { defineCommand } from 'citty'
import { install, uninstall, getCurrentVersion } from '@stripe/sync-integration-supabase'

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Install Stripe sync to Supabase Edge Functions',
  },
  args: {
    token: {
      type: 'string',
      description: 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)',
    },
    project: {
      type: 'string',
      description: 'Supabase project ref (or SUPABASE_PROJECT_REF env)',
    },
    stripeKey: {
      type: 'string',
      description: 'Stripe API key (or STRIPE_API_KEY env)',
    },
    packageVersion: {
      type: 'string',
      description: 'Package version to install (e.g., 1.0.8-beta.1, defaults to latest)',
    },
    workerInterval: {
      type: 'string',
      default: '30',
      description: 'Worker interval in seconds (default: 30)',
    },
    managementUrl: {
      type: 'string',
      description:
        'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)',
    },
    rateLimit: {
      type: 'string',
      default: '60',
      description: 'Max Stripe API requests per second (default: 60)',
    },
    syncInterval: {
      type: 'string',
      default: '604800',
      description: 'How often to run a full resync in seconds (default: 604800 = 1 week)',
    },
    skipInitialSync: {
      type: 'boolean',
      default: false,
      description: 'Skip triggering the first sync immediately after install',
    },
  },
  async run({ args }) {
    const token = args.token || process.env.SUPABASE_ACCESS_TOKEN
    const project = args.project || process.env.SUPABASE_PROJECT_REF
    const stripeKey = args.stripeKey || process.env.STRIPE_API_KEY
    const managementUrl = args.managementUrl || process.env.SUPABASE_MANAGEMENT_URL

    if (!token) {
      throw new Error('Missing --token or SUPABASE_ACCESS_TOKEN env')
    }
    if (!project) {
      throw new Error('Missing --project or SUPABASE_PROJECT_REF env')
    }
    if (!stripeKey) {
      throw new Error('Missing --stripe-key or STRIPE_API_KEY env')
    }

    const version = args.packageVersion || getCurrentVersion()

    console.log(`Installing Stripe sync to Supabase project ${project}...`)
    console.log(`  Edge function version: ${version}`)

    await install({
      supabaseAccessToken: token,
      supabaseProjectRef: project,
      stripeKey,
      packageVersion: version,
      workerIntervalSeconds: parseInt(args.workerInterval),
      rateLimit: parseInt(args.rateLimit),
      syncIntervalSeconds: parseInt(args.syncInterval),
      skipInitialSync: args.skipInitialSync,
      supabaseManagementUrl: managementUrl,
    })

    console.log('Installation complete.')
  },
})

const uninstallCmd = defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Uninstall Stripe sync from Supabase Edge Functions',
  },
  args: {
    token: {
      type: 'string',
      description: 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)',
    },
    project: {
      type: 'string',
      description: 'Supabase project ref (or SUPABASE_PROJECT_REF env)',
    },
    managementUrl: {
      type: 'string',
      description:
        'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)',
    },
  },
  async run({ args }) {
    const token = args.token || process.env.SUPABASE_ACCESS_TOKEN
    const project = args.project || process.env.SUPABASE_PROJECT_REF
    const managementUrl = args.managementUrl || process.env.SUPABASE_MANAGEMENT_URL

    if (!token) {
      throw new Error('Missing --token or SUPABASE_ACCESS_TOKEN env')
    }
    if (!project) {
      throw new Error('Missing --project or SUPABASE_PROJECT_REF env')
    }

    console.log(`Uninstalling Stripe sync from Supabase project ${project}...`)

    await uninstall({
      supabaseAccessToken: token,
      supabaseProjectRef: project,
      supabaseManagementUrl: managementUrl,
    })

    console.log('Uninstall complete.')
  },
})

export const supabaseCmd = defineCommand({
  meta: {
    name: 'supabase',
    description: 'Manage Stripe sync on Supabase',
  },
  subCommands: {
    install: installCmd,
    uninstall: uninstallCmd,
  },
})
