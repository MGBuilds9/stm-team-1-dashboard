import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  canonicalSnapshotContentV1,
  finalizeTeamSnapshotV3Migration,
  parseTeamSnapshotV3,
  prepareTeamSnapshotV2Migration,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"

const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024

function semanticHash(snapshot: TeamSnapshotV3): string {
  return createHash("sha256")
    .update(canonicalSnapshotContentV1(snapshot))
    .digest("hex")
}

export function migrateSnapshotV2(input: unknown): TeamSnapshotV3 {
  const unhashed = prepareTeamSnapshotV2Migration(input)
  const placeholder = finalizeTeamSnapshotV3Migration(unhashed, "0".repeat(64))
  return finalizeTeamSnapshotV3Migration(unhashed, semanticHash(placeholder))
}

export function verifySnapshotV3(input: unknown): TeamSnapshotV3 {
  const snapshot = parseTeamSnapshotV3(input)
  if (semanticHash(snapshot) !== snapshot.contentHash) {
    throw new Error("TeamSnapshotV3 semantic content hash does not match")
  }
  return snapshot
}

async function readSnapshot(file: string): Promise<unknown> {
  const metadata = await fs.lstat(file)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_SNAPSHOT_BYTES
  ) {
    throw new Error("Snapshot input must be a bounded regular non-symlink file")
  }
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function replaceAtomically(file: string, value: string): Promise<void> {
  const directory = path.dirname(file)
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  )
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
    const directoryHandle = await fs.open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

async function main(): Promise<void> {
  const target = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), "data", "snapshot.json")
  )
  const input = await readSnapshot(target)
  if (
    input !== null &&
    typeof input === "object" &&
    "schemaVersion" in input &&
    input.schemaVersion === 3
  ) {
    const snapshot = verifySnapshotV3(input)
    process.stdout.write(`UNCHANGED ${snapshot.contentHash}\n`)
    return
  }
  const snapshot = migrateSnapshotV2(input)
  await replaceAtomically(target, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stdout.write(`MIGRATED ${snapshot.contentHash}\n`)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exitCode = 1
  })
}
