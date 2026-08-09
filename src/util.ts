import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

type ClipCommand = { read: [string, ...string[]]; write: [string, ...string[]] }

const CANDIDATES: ClipCommand[] = [
  // Linux Wayland
  { read: ["wl-paste", "--no-newline"], write: ["wl-copy"] },
  // Linux X11
  { read: ["xclip", "-selection", "clipboard", "-o"], write: ["xclip", "-selection", "clipboard"] },
  { read: ["xsel", "--clipboard", "--output"], write: ["xsel", "--clipboard", "--input"] },
  // macOS
  { read: ["pbpaste"], write: ["pbcopy"] },
  // Windows
  {
    read: ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
    write: ["powershell", "-NoProfile", "-Command", "Set-Clipboard"],
  },
]

let detected: ClipCommand | null | undefined

async function detectClipCommand(): Promise<ClipCommand | null> {
  if (detected !== undefined) return detected
  for (const candidate of CANDIDATES) {
    try {
      await execFileP(candidate.read[0], candidate.read.slice(1), {
        timeout: 2000,
        windowsHide: true,
      })
      detected = candidate
      return candidate
    } catch {
      // try next candidate
    }
  }
  detected = null
  return null
}

/** Read the current clipboard contents. Throws if no clipboard tool is available. */
export async function readClipboard(): Promise<string> {
  const cmd = await detectClipCommand()
  if (!cmd) throw new Error("no clipboard tool found (install wl-clipboard/xclip/xsel)")
  const { stdout } = await execFileP(cmd.read[0], cmd.read.slice(1), {
    timeout: 2000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

/** Write text to the clipboard. Throws if no clipboard tool is available. */
export async function writeClipboard(text: string): Promise<void> {
  const cmd = await detectClipCommand()
  if (!cmd) throw new Error("no clipboard tool found (install wl-clipboard/xclip/xsel)")

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.write[0], cmd.write.slice(1), {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("clipboard write timed out"))
    }, 5000)
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`clipboard write exited with code ${code}`))
    })
    child.stdin.write(text)
    child.stdin.end()
  })
}

/** Best-effort check whether a clipboard tool is available. */
export async function hasClipboard(): Promise<boolean> {
  return (await detectClipCommand()) !== null
}

/** Format a JSON-serializable value for display inside prompts. */
export function prettyJSON(value: unknown): string {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** SHA-1 hex digest (used for stable fingerprints). */
export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex")
}
