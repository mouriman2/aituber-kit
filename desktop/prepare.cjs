// electron-builder に渡す resources/ を組み立てる。
//   resources/app-server : ../.next/standalone + .next/static + public（NEXT_OUTPUT_STANDALONE=true で next build 済みが前提）
//   resources/node       : このマシンの node.exe（standalone サーバをビルドしたものと同じ Node）
//   resources/bridge     : ai-3d-character の PyInstaller 出力（AI3DC_BRIDGE_DIST で場所を指定）
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const out = path.join(__dirname, 'resources')
const standalone = path.join(root, '.next', 'standalone')
const bridgeDist =
  process.env.AI3DC_BRIDGE_DIST ||
  path.resolve(root, '..', 'ai-3d-character', 'build', 'dist', 'ai3dc-bridge')

function must(p) {
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`)
  return p
}

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true, dereference: true })
}

fs.rmSync(out, { recursive: true, force: true })

must(path.join(standalone, 'server.js'))
copy(standalone, path.join(out, 'app-server'))
copy(must(path.join(root, '.next', 'static')), path.join(out, 'app-server', '.next', 'static'))
copy(must(path.join(root, 'public')), path.join(out, 'app-server', 'public'))

// standalone は .env を読まない前提で、ビルド時の NEXT_PUBLIC_* は既に埋め込まれている。
// サーバ側で実行時に読む変数（VOICEVOX_SERVER_URL 等）は .env をコピーして server.js と同じ場所に置く。
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) copy(envFile, path.join(out, 'app-server', '.env'))

copy(must(process.execPath), path.join(out, 'node', 'node.exe'))
copy(must(path.join(bridgeDist, 'ai3dc-bridge.exe')), path.join(out, 'bridge', 'ai3dc-bridge.exe'))
copy(must(path.join(bridgeDist, '_internal')), path.join(out, 'bridge', '_internal'))

console.log('resources prepared at', out)
