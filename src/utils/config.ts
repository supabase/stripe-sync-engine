import dotenv from 'dotenv'

type configType = {
  DATABASE_URL: string
  NODE_ENV: string
  SCHEMA: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_WEBHOOK_URL: string
}

function getConfigFromEnv(key: string, _default?: string): string {
  const value = process.env[key];
  if (!value && _default != undefined) {
    return _default;
  }
  if (!value) {
    throw new Error(`${key} is undefined`)
  }
  return value
}

export function getConfig(): configType {
  dotenv.config()

  return {
    DATABASE_URL: getConfigFromEnv('DATABASE_URL'),
    SCHEMA: getConfigFromEnv('SCHEMA'),
    NODE_ENV: getConfigFromEnv('NODE_ENV'),
    STRIPE_SECRET_KEY: getConfigFromEnv('STRIPE_SECRET_KEY'),
    STRIPE_WEBHOOK_SECRET: getConfigFromEnv('STRIPE_WEBHOOK_SECRET', ''),
    STRIPE_WEBHOOK_URL: getConfigFromEnv('STRIPE_WEBHOOK_URL')
  }
}
