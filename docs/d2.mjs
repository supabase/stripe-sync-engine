import { D2 } from '@terrastruct/d2'
import { writeFileSync } from 'fs'

let instance

/** Get or create the shared D2 WASM instance */
export async function getD2() {
  if (!instance) {
    instance = new D2()
    // Constructor calls init() internally — await readiness via first compile
  }
  return instance
}

/**
 * Compile and render a D2 diagram to SVG.
 * @param {string} source - D2 diagram source text
 * @param {object} [options] - Compile options (e.g. { sketch: true })
 * @returns {Promise<string>} SVG string
 */
export async function render(source, options = {}) {
  const d2 = await getD2()
  const result = await d2.compile(source, options)
  let svg = await d2.render(result.diagram, result.renderOptions)

  // Replace D2's embedded custom fonts with monospace
  svg = svg.replace(
    /font-family:\s*d2-[^;"']*/g,
    'font-family: "SF Mono", "Fira Code", "JetBrains Mono", Menlo, Consolas, monospace'
  )

  return svg
}

/**
 * Render a D2 diagram and write it to a file.
 * @param {string} source - D2 diagram source text
 * @param {string} outPath - Output file path (.svg)
 * @param {object} [options] - Compile options
 * @returns {Promise<string>} The output file path
 */
export async function renderToFile(source, outPath, options = {}) {
  const svg = await render(source, options)
  writeFileSync(outPath, svg)
  return outPath
}

// CLI: node scripts/d2.mjs <input.d2> [output.svg]
const isMain = process.argv[1]?.endsWith('/d2.mjs') || process.argv[1]?.endsWith('\\d2.mjs')

if (isMain && process.argv[2]) {
  const { readFileSync } = await import('fs')
  const { resolve, basename } = await import('path')

  const inputPath = resolve(process.argv[2])
  const source = readFileSync(inputPath, 'utf-8')
  const outPath = process.argv[3] || inputPath.replace(/\.d2$/, '.svg')

  await renderToFile(source, outPath)
  console.log(`${basename(outPath)} (${readFileSync(outPath).length} bytes)`)
  process.exit(0)
}
