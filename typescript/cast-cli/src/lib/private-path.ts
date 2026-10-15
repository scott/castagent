import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

/**
 * Create `dir` as mode 0700. `mkdir` applies the process umask, so the
 * mode passed to mkdir is not the mode the directory is born with.
 * umask 077 makes 0700 stick. An existing directory is tightened in
 * place. That chmod does not follow a loose create.
 */
export function ensurePrivateDir(dir: string): void {
  const previous = process.umask(0o077)
  try {
    fs.mkdirSync(dir, {recursive: true, mode: PRIVATE_DIR_MODE})
  } finally {
    process.umask(previous)
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  if ((stat.mode & 0o777) !== PRIVATE_DIR_MODE) {
    fs.chmodSync(dir, PRIVATE_DIR_MODE)
  }
}

/**
 * Create an empty file as mode 0600 when it is missing. An existing
 * file is left untouched here. Callers that must tighten a file that
 * already exists do that after they know the inode is the one they own.
 */
export function createPrivateFile(filePath: string): void {
  const previous = process.umask(0o077)
  try {
    if (fs.existsSync(filePath)) return
    const fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    )
    fs.closeSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
  } finally {
    process.umask(previous)
  }
}

export function tightenPrivateFile(filePath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return
  }
  if (!stat.isFile()) return
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE)
  }
}

/**
 * Write `contents` by creating a temp file mode 0600 in the same
 * directory and renaming it into place. The secret is never written
 * to an inode that was created world-readable.
 */
export function writePrivateFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  )
  const previous = process.umask(0o077)
  let fd: number | null = null
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    )
    fs.writeFileSync(fd, contents)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, filePath)
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // The original error is the one to surface.
      }
    }
    try {
      fs.rmSync(tmp, {force: true})
    } catch {
      // The temp file may already have been renamed.
    }
    throw error
  } finally {
    process.umask(previous)
  }
}
