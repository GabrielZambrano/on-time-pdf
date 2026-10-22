const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const work = path.join(root, 'engine-build')
const out = path.join(root, 'engine-dist')
const python = process.env.ONTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

fs.rmSync(work, { recursive: true, force: true })
fs.rmSync(out, { recursive: true, force: true })

const result = spawnSync(
  python,
  ['-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'engine', '--distpath', work, '--workpath', path.join(work, 'tmp'), '--specpath', work, path.join(root, 'engine', 'engine.py')],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status ?? 1)

fs.renameSync(path.join(work, 'engine'), out)
fs.rmSync(work, { recursive: true, force: true })
