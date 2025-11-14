import ngrok from '@ngrok/ngrok'
import chalk from 'chalk'

export interface NgrokTunnel {
  url: string
  close: () => Promise<void>
}

/**
 * Create an ngrok tunnel to expose the local server to the internet.
 * @param port - The local port to expose
 * @param authToken - ngrok authentication token
 * @returns The tunnel URL and a close function
 */
export async function createTunnel(port: number, authToken: string): Promise<NgrokTunnel> {
  try {
    console.log(chalk.blue(`\nCreating ngrok tunnel for port ${port}...`))

    const listener = await ngrok.forward({
      addr: port,
      authtoken: authToken,
    })

    const url = listener.url()
    if (!url) {
      throw new Error('Failed to get ngrok URL')
    }

    console.log(chalk.green(`✓ ngrok tunnel created: ${url}`))

    return {
      url,
      close: async () => {
        console.log(chalk.blue('\nClosing ngrok tunnel...'))
        await listener.close()
        console.log(chalk.green('✓ ngrok tunnel closed'))
      },
    }
  } catch (error) {
    console.error(chalk.red('\nFailed to create ngrok tunnel:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    throw error
  }
}
