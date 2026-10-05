import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const name = process.argv[2]
const targetDir = process.argv[3]
if (!name || !targetDir) {
  console.error("Usage: npm run scaffold:server -- <name> <targetDir>")
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.resolve(
  here,
  "../server/templates/cloudflare"
)

const destination = path.resolve(process.cwd(), targetDir)
if (fs.existsSync(destination)) {
  console.error(`Target directory already exists: ${destination}`)
  process.exit(1)
}

fs.cpSync(template, destination, {
  recursive: true
})

const wranglerConfigPath = path.resolve(destination, "wrangler.jsonc")
let fc = fs.readFileSync(wranglerConfigPath, "utf-8")
fs.writeFileSync(wranglerConfigPath, fc.replaceAll("{{ name }}", name), "utf-8")

const packageJson = path.resolve(destination, "package.json")
fc = fs.readFileSync(packageJson, "utf-8")
fs.writeFileSync(packageJson, fc.replaceAll("{{ name }}", name), "utf-8")

console.log(`
  SEPT server created in ${destination}

  Deploy it:
    cd ${destination}
    npm install
    wrangler d1 create --binding DB --update-config ${name}
    wrangler r2 bucket create --binding STORAGE --update-config ${name}
    wrangler d1 migrations apply DB --remote
    wrangler deploy
`)
console.log()

