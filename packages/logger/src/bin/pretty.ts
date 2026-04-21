#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { Box, Text, renderToString } from 'ink'
import React from 'react'
import { ProgressView, ProgressHeader, formatProgressHeader } from '../format/progress.js'

// MARK: - ANSI helpers

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const GRAY = '\x1b[90m'
const MAGENTA = '\x1b[35m'

const LEVEL_STYLE: Record<string, { label: string; color: string }> = {
  debug: { label: 'DEBUG', color: GRAY },
  info: { label: 'INFO ', color: GREEN },
  warn: { label: 'WARN ', color: YELLOW },
  error: { label: 'ERROR', color: RED },
}

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const STATUS_ICON: Record<string, { symbol: string; color: string }> = {
  start: { symbol: '\u25cf', color: CYAN },
  complete: { symbol: '\u25cf', color: GREEN },
  error: { symbol: '\u25cf', color: RED },
  skip: { symbol: '\u23ed', color: GRAY },
  range_complete: { symbol: '\u25cb', color: DIM },
}

// Keys to omit from log data display
const SKIP_DATA_KEYS = new Set(['name', 'engine_request_id'])

function typeLabel(label: string, color: string): string {
  return `${color}${label}:${RESET}`
}

// MARK: - CLI args

const args = process.argv.slice(2)
let minLevel = -1
let showProgress = true

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--level' && args[i + 1]) {
    minLevel = LEVEL_ORDER[args[i + 1]!] ?? -1
    i++
  } else if (args[i] === '--no-progress') {
    showProgress = false
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stderr.write(
      `Usage: sync-pretty-log [options]\n\n` +
        `Pretty-print sync engine NDJSON logs from stdin.\n\n` +
        `Options:\n` +
        `  --level <level>  Minimum log level: debug, info, warn, error\n` +
        `  --no-progress    Hide progress messages\n` +
        `  -h, --help       Show this help\n\n` +
        `Example:\n` +
        `  cat sync_run.log | sync-pretty-log\n` +
        `  cat sync_run.log | sync-pretty-log --level warn\n`
    )
    process.exit(0)
  }
}

// MARK: - Formatters

function ts(raw?: string): string {
  if (!raw) return `${DIM}--:--:--${RESET} `
  try {
    const d = new Date(raw)
    return `${DIM}${d.toISOString().slice(11, 19)}${RESET} `
  } catch {
    return `${DIM}--:--:--${RESET} `
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026'
}

const DATA_INDENT = ' '.repeat(4)

function formatDataKV(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (SKIP_DATA_KEYS.has(k)) continue
    const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
    parts.push(`${DIM}${k}=${RESET}${truncate(val, 120)}`)
  }
  return parts.length > 0 ? '\n' + DATA_INDENT + parts.join('\n' + DATA_INDENT) : ''
}

function formatLog(msg: {
  log: { level: string; message: string; data?: Record<string, unknown> }
  _ts?: string
}): string | null {
  const { level, message, data } = msg.log
  if (LEVEL_ORDER[level] !== undefined && LEVEL_ORDER[level]! < minLevel) return null

  const style = LEVEL_STYLE[level] ?? { label: level.toUpperCase().padEnd(5), color: '' }
  const component = data?.name ? `${DIM}[${data.name}]${RESET} ` : ''
  const kv = data ? formatDataKV(data) : ''
  return `${ts(msg._ts)}${typeLabel('log', style.color)} ${style.color}${style.label}${RESET} ${component}${message}${kv}`
}

function formatStreamStatus(msg: {
  stream_status: {
    stream: string
    status: string
    time_range?: { gte?: string; lt?: string }
    error?: string
    reason?: string
  }
  _ts?: string
}): string {
  const { stream, status, time_range, error, reason } = msg.stream_status
  const icon = STATUS_ICON[status] ?? { symbol: '?', color: '' }
  const statusLabel = status.toUpperCase()

  let detail = ''
  if ((status === 'start' || status === 'range_complete') && time_range) {
    const gte = time_range.gte?.slice(0, 19) ?? '?'
    const lt = time_range.lt?.slice(0, 19) ?? '?'
    detail = `  ${DIM}[${gte} \u2192 ${lt})${RESET}`
  } else if (error) {
    detail = `  ${truncate(error, 100)}`
  } else if (reason) {
    detail = `  ${truncate(reason, 100)}`
  }

  return `${ts(msg._ts)}${typeLabel('stream_status', icon.color)} ${icon.color}${icon.symbol}${RESET} ${BOLD}${stream}${RESET}  ${icon.color}${statusLabel}${RESET}${detail}`
}

const columns = process.stdout.columns || 200

function formatProgress(msg: { progress: Record<string, unknown>; _ts?: string }): string | null {
  if (!showProgress) return null
  const progress = msg.progress as import('@stripe/sync-protocol').ProgressPayload
  const rendered = renderToString(React.createElement(ProgressHeader, { progress }), { columns })
  const timestamp = ts(msg._ts)
  const indented = rendered
    .split('\n')
    .map((l) => `${DATA_INDENT}${l}`)
    .join('\n')
  return `${timestamp}${typeLabel('progress', YELLOW)}\n${indented}`
}

function formatEof(msg: { eof: Record<string, unknown>; _ts?: string }): string {
  const eof = msg.eof as {
    status?: string
    has_more?: boolean
    run_progress?: Record<string, unknown>
  }
  const timestamp = ts(msg._ts)
  const statusColor = eof.status === 'failed' ? RED : eof.status === 'succeeded' ? GREEN : YELLOW

  if (eof.run_progress) {
    const progress = eof.run_progress as import('@stripe/sync-protocol').ProgressPayload
    const borderColor =
      eof.status === 'failed' ? 'red' : eof.status === 'succeeded' ? 'green' : 'yellow'
    const rendered = renderToString(
      React.createElement(
        Box,
        {
          borderStyle: 'round',
          borderColor,
          paddingX: 1,
          flexDirection: 'column',
        },
        React.createElement(
          Text,
          { bold: true },
          `${eof.status?.toUpperCase() ?? 'EOF'}  has_more=${String(eof.has_more ?? false)}`
        ),
        React.createElement(ProgressView, { progress })
      ),
      { columns }
    )
    return `${timestamp}${typeLabel('eof', statusColor)}\n${rendered}`
  }

  return `${timestamp}${typeLabel('eof', statusColor)} ${statusColor}${BOLD}${eof.status?.toUpperCase() ?? 'EOF'}${RESET}  has_more=${String(eof.has_more ?? false)}`
}

function formatRecord(msg: {
  record: { stream: string; data: Record<string, unknown> }
  _ts?: string
}): string {
  const { stream, data } = msg.record
  const id = data?.id ? `  id=${String(data.id)}` : ''
  return `${ts(msg._ts)}${typeLabel('record', MAGENTA)} ${BOLD}${stream}${RESET}${id}`
}

function formatSourceState(msg: {
  source_state: { stream?: string; state_type?: string; state?: unknown }
  _ts?: string
}): string {
  const { stream, state_type } = msg.source_state
  const label = stream ?? 'global'
  return `${ts(msg._ts)}${typeLabel('source_state', CYAN)} ${BOLD}${label}${RESET}  ${state_type ?? 'stream'}`
}

function formatCatalog(msg: {
  catalog: { streams: Array<{ stream: { name: string } }> }
  _ts?: string
}): string {
  const streams = msg.catalog.streams
  const names = streams.map((s) => s.stream.name).join(', ')
  return `${ts(msg._ts)}${typeLabel('catalog', CYAN)} ${streams.length} streams: ${truncate(names, columns - 30)}`
}

function formatConnectionStatus(msg: {
  connection_status: { status: string; message?: string }
  _ts?: string
}): string {
  const { status, message } = msg.connection_status
  const color = status === 'succeeded' ? GREEN : status === 'failed' ? RED : YELLOW
  const detail = message ? `: ${message}` : ''
  return `${ts(msg._ts)}${typeLabel('connection_status', color)} ${status}${detail}`
}

function formatSpec(msg: { _ts?: string }): string {
  return `${ts(msg._ts)}${typeLabel('spec', DIM)} config schema received`
}

function formatControl(msg: { control: { control_type: string }; _ts?: string }): string {
  return `${ts(msg._ts)}${typeLabel('control', DIM)} ${msg.control.control_type}`
}

function formatSourceInput(msg: { source_input: unknown; _ts?: string }): string {
  const input = msg.source_input as Record<string, unknown> | undefined
  const summary = input?.type ? String(input.type) : 'event'
  return `${ts(msg._ts)}${typeLabel('source_input', CYAN)} ${summary}`
}

// MARK: - Main loop

function formatLine(line: string): string | null {
  if (!line.trim()) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line)
  } catch {
    return line // Non-JSON — pass through
  }

  switch (parsed.type) {
    case 'log':
      return formatLog(parsed as Parameters<typeof formatLog>[0])
    case 'stream_status':
      return formatStreamStatus(parsed as Parameters<typeof formatStreamStatus>[0])
    case 'progress':
      return formatProgress(parsed as Parameters<typeof formatProgress>[0])
    case 'eof':
      return formatEof(parsed as Parameters<typeof formatEof>[0])
    case 'record':
      return formatRecord(parsed as Parameters<typeof formatRecord>[0])
    case 'source_state':
      return formatSourceState(parsed as Parameters<typeof formatSourceState>[0])
    case 'catalog':
      return formatCatalog(parsed as Parameters<typeof formatCatalog>[0])
    case 'connection_status':
      return formatConnectionStatus(parsed as Parameters<typeof formatConnectionStatus>[0])
    case 'spec':
      return formatSpec(parsed as { _ts?: string })
    case 'control':
      return formatControl(parsed as Parameters<typeof formatControl>[0])
    case 'source_input':
      return formatSourceInput(parsed as Parameters<typeof formatSourceInput>[0])
    default:
      // Unknown type — show as dimmed JSON
      return `${ts((parsed as { _ts?: string })._ts)}${typeLabel(String(parsed.type ?? '???'), DIM)} ${DIM}${line}${RESET}`
  }
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const output = formatLine(line)
  if (output !== null) {
    process.stdout.write(output + '\n')
  }
})

rl.on('close', () => {
  process.exit(0)
})
