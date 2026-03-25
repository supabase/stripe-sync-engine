#!/usr/bin/env node
// Ensures dist bin files have #!/usr/bin/env node shebang.
// tsc doesn't emit shebangs, so we add them post-build.
import { readFileSync, writeFileSync } from 'fs'

const SHEBANG = '#!/usr/bin/env node\n'

for (const file of process.argv.slice(2)) {
  const content = readFileSync(file, 'utf8')
  if (content.startsWith('#!')) {
    // Replace existing shebang (e.g. tsx → node)
    writeFileSync(file, content.replace(/^#!.*\n/, SHEBANG))
  } else {
    // Add shebang
    writeFileSync(file, SHEBANG + content)
  }
}
