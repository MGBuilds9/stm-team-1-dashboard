import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  finalizeTeamSnapshotV3Migration,
  prepareTeamSnapshotV2Migration,
  teamSnapshotV2CompatibilitySchema,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"

import {
  assertDataReceiptFacts,
  buildDataReceiptV3,
  dataReceiptCompatibilitySchema,
  dataReceiptsEqual,
  dataSnapshotSemanticHash,
  validateDataPairV3,
  verifyDataSnapshotV3,
  type DataReceipt,
  type DataReceiptV3,
} from "./data-receipt"

const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024

export interface SnapshotPairMigrationResult {
  status: "migrated" | "unchanged"
  snapshot: TeamSnapshotV3
  receipt: DataReceiptV3
}

export function migrateSnapshotV2(input: unknown): TeamSnapshotV3 {
  const unhashed = prepareTeamSnapshotV2Migration(input)
  return finalizeTeamSnapshotV3Migration(
    unhashed,
    dataSnapshotSemanticHash(unhashed)
  )
}

export function verifySnapshotV3(input: unknown): TeamSnapshotV3 {
  return verifyDataSnapshotV3(input)
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

async function readJsonFile(
  file: string,
  maximumBytes: number,
  optional = false
): Promise<unknown | null> {
  let metadata
  try {
    metadata = await fs.lstat(file)
  } catch (error) {
    if (optional && isMissingFile(error)) return null
    throw error
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(
      `${path.basename(file)} must be a bounded regular non-symlink file`
    )
  }
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function replaceAtomically(file: string, value: string): Promise<void> {
  const directory = path.dirname(file)
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  )
  let renamed = false
  try {
    const handle = await fs.open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(value, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, file)
    renamed = true
    const directoryHandle = await fs.open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } finally {
    if (!renamed) await fs.rm(temporary, { force: true })
  }
}

/**
 * Migrates receipt.json first and snapshot.json last. A process interruption can
 * therefore leave only V2 + the exact recomputable V3 receipt, which this
 * function completes on the next run before Git stages the data-branch pair.
 */
export async function migrateSnapshotPair(
  snapshotFile: string
): Promise<SnapshotPairMigrationResult> {
  const receiptFile = path.join(path.dirname(snapshotFile), "receipt.json")
  const rawSnapshot = await readJsonFile(snapshotFile, MAX_SNAPSHOT_BYTES)
  const rawReceipt = await readJsonFile(receiptFile, MAX_RECEIPT_BYTES, true)
  const receipt: DataReceipt | null =
    rawReceipt === null
      ? null
      : dataReceiptCompatibilitySchema.parse(rawReceipt)
  const snapshotIsV3 =
    rawSnapshot !== null &&
    typeof rawSnapshot === "object" &&
    "schemaVersion" in rawSnapshot &&
    rawSnapshot.schemaVersion === 3

  if (snapshotIsV3) {
    const snapshot = verifyDataSnapshotV3(rawSnapshot)
    if (!receipt || receipt.schemaVersion !== 3) {
      throw new Error("V3 snapshot.json requires its exact V3 receipt.json")
    }
    const validated = validateDataPairV3(snapshot, receipt)
    return {
      status: "unchanged",
      ...validated,
    }
  }

  const previousSnapshot = teamSnapshotV2CompatibilitySchema.parse(rawSnapshot)
  const snapshot = migrateSnapshotV2(previousSnapshot)
  const desiredReceipt = buildDataReceiptV3(
    snapshot,
    previousSnapshot.contentHash
  )
  if (receipt) {
    if (receipt.schemaVersion === 2) {
      assertDataReceiptFacts(receipt, previousSnapshot)
      if (receipt.contentHash !== previousSnapshot.contentHash) {
        throw new Error(
          "receipt.json contentHash does not match the V2 snapshot"
        )
      }
    } else if (!dataReceiptsEqual(receipt, desiredReceipt)) {
      throw new Error("V3 receipt.json does not match the migrated snapshot")
    }
  }

  if (
    !receipt ||
    receipt.schemaVersion !== 3 ||
    !dataReceiptsEqual(receipt, desiredReceipt)
  ) {
    await replaceAtomically(
      receiptFile,
      `${JSON.stringify(desiredReceipt, null, 2)}\n`
    )
  }
  await replaceAtomically(
    snapshotFile,
    `${JSON.stringify(snapshot, null, 2)}\n`
  )
  return {
    status: "migrated",
    snapshot,
    receipt: desiredReceipt,
  }
}

async function main(): Promise<void> {
  const target = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), "data", "snapshot.json")
  )
  const result = await migrateSnapshotPair(target)
  process.stdout.write(
    `${result.status.toUpperCase()} ${result.snapshot.contentHash}\n`
  )
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
