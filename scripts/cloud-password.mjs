import { randomBytes, pbkdf2Sync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

if (!process.stdin.isTTY) throw new Error('请在终端交互式设置密码；不要把密码写入命令参数。')
async function hidden(prompt) {
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const handler = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { cleanup(); reject(new Error('已取消')); return }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return }
        if (char === '\u007f') value = value.slice(0, -1)
        else value += char
      }
    }
    const cleanup = () => { process.stdin.off('data', handler); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n') }
    process.stdin.on('data', handler)
  })
}
const password = await hidden('设置登录密码（至少 12 个字符，输入不回显）：')
if (password.length < 12 || password.length > 512) throw new Error('密码长度应为 12–512 个字符。')
if (await hidden('再次输入密码：') !== password) throw new Error('两次密码不一致。')
const salt = randomBytes(16)
const hash = `pbkdf2-sha256:100000:${salt.toString('hex')}:${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`
if (process.argv.includes('--local')) {
  await writeFile('.dev.vars', `PASSWORD_HASH="${hash}"\n`, { mode: 0o600 })
  console.log('本地开发密码已设置。')
} else {
  const command = spawn('npx', ['wrangler', 'secret', 'put', 'PASSWORD_HASH'], { stdio: ['pipe', 'inherit', 'inherit'] })
  command.stdin.end(hash)
  const code = await new Promise((resolve) => command.on('exit', resolve))
  if (code !== 0) throw new Error('密码配置未成功。')
  console.log('云端密码已更新，旧登录会话将失效。')
}
