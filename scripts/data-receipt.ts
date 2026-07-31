import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import {
  canonicalSnapshotContentV1,
  parseTeamSnapshotV3,
  type TeamSnapshotV2Compatibility,
  type TeamSnapshotV3,
  type TeamSnapshotV3Unhashed,
} from "@basketball-os/public-contracts"
import { z } from "zod"

const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const receiptFields = {
  generatedAt: z.string().datetime(),
  contentHash: sha256Schema,
  previousHash: sha256Schema.nullable(),
  provider: z.enum(["stm", "teamlinkt"]),
  teamId: z.string().trim().min(1).max(100),
  sourceCount: z.number().int().nonnegative(),
  gameCount: z.number().int().nonnegative(),
  boxScoreCount: z.number().int().nonnegative(),
  matchedVideoCount: z.number().int().nonnegative(),
}

export const legacyDataReceiptV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...receiptFields,
})

export const dataReceiptV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  ...receiptFields,
})

export const dataReceiptCompatibilitySchema = z.discriminatedUnion(
  "schemaVersion",
  [legacyDataReceiptV2Schema, dataReceiptV3Schema]
)

export type LegacyDataReceiptV2 = z.infer<typeof legacyDataReceiptV2Schema>
export type DataReceiptV3 = z.infer<typeof dataReceiptV3Schema>
export type DataReceipt = z.infer<typeof dataReceiptCompatibilitySchema>

export interface ValidatedDataPair {
  snapshot: TeamSnapshotV3
  receipt: DataReceiptV3
}

export function dataReceiptFacts(
  snapshot: TeamSnapshotV2Compatibility | TeamSnapshotV3
) {
  return {
    generatedAt: snapshot.generatedAt,
    provider: snapshot.identity.provider,
    teamId: snapshot.identity.teamId,
    sourceCount: snapshot.sources.length,
    gameCount: snapshot.games.length,
    boxScoreCount: snapshot.boxScores.length,
    matchedVideoCount: snapshot.games.filter((game) =>
      "video" in game
        ? game.video.state === "verified_exact"
        : game.videoUrl !== null && game.videoTitle !== null
    ).length,
  }
}

export function assertDataReceiptFacts(
  receipt: DataReceipt,
  snapshot: TeamSnapshotV2Compatibility | TeamSnapshotV3
): void {
  const expected = dataReceiptFacts(snapshot)
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (receipt[key] !== expected[key]) {
      throw new Error(`receipt.json ${key} does not match snapshot.json`)
    }
  }
}

export function verifyDataSnapshotV3(input: unknown): TeamSnapshotV3 {
  const snapshot = parseTeamSnapshotV3(input)
  const computed = dataSnapshotSemanticHash(snapshot)
  if (computed !== snapshot.contentHash) {
    throw new Error("Snapshot semantic content hash does not match")
  }
  return snapshot
}

export function dataSnapshotSemanticHash(
  snapshot: TeamSnapshotV3 | TeamSnapshotV3Unhashed
): string {
  return createHash("sha256")
    .update(canonicalSnapshotContentV1(snapshot))
    .digest("hex")
}

export function buildDataReceiptV3(
  input: TeamSnapshotV3,
  previousHash: string | null
): DataReceiptV3 {
  const snapshot = verifyDataSnapshotV3(input)
  return dataReceiptV3Schema.parse({
    schemaVersion: 3,
    ...dataReceiptFacts(snapshot),
    contentHash: snapshot.contentHash,
    previousHash,
  })
}

export function dataReceiptsEqual(
  left: DataReceiptV3,
  right: DataReceiptV3
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.generatedAt === right.generatedAt &&
    left.contentHash === right.contentHash &&
    left.previousHash === right.previousHash &&
    left.provider === right.provider &&
    left.teamId === right.teamId &&
    left.sourceCount === right.sourceCount &&
    left.gameCount === right.gameCount &&
    left.boxScoreCount === right.boxScoreCount &&
    left.matchedVideoCount === right.matchedVideoCount
  )
}

export function validateDataPairV3(
  snapshotInput: unknown,
  receiptInput: unknown
): ValidatedDataPair {
  const snapshot = verifyDataSnapshotV3(snapshotInput)
  const receipt = dataReceiptV3Schema.parse(receiptInput)
  assertDataReceiptFacts(receipt, snapshot)
  if (receipt.contentHash !== snapshot.contentHash) {
    throw new Error("receipt.json contentHash does not match snapshot.json")
  }
  return { snapshot, receipt }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

async function readJsonIfPresent(
  file: string,
  maximumBytes: number
): Promise<{ present: false } | { present: true; value: unknown }> {
  let metadata
  try {
    metadata = await fs.lstat(file)
  } catch (error) {
    if (isMissingFile(error)) return { present: false }
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
  return {
    present: true,
    value: JSON.parse(await fs.readFile(file, "utf8")),
  }
}

export async function readValidatedDataPair(input: {
  snapshotFile: string
  receiptFile: string
  allowBothMissing?: boolean
}): Promise<ValidatedDataPair | null> {
  const [snapshot, receipt] = await Promise.all([
    readJsonIfPresent(input.snapshotFile, MAX_SNAPSHOT_BYTES),
    readJsonIfPresent(input.receiptFile, MAX_RECEIPT_BYTES),
  ])
  if (!snapshot.present && !receipt.present) {
    if (input.allowBothMissing) return null
    throw new Error("snapshot.json and receipt.json are both missing")
  }
  if (!snapshot.present || !receipt.present) {
    throw new Error(
      "snapshot.json and receipt.json must exist together as one data pair"
    )
  }
  if (
    snapshot.value !== null &&
    typeof snapshot.value === "object" &&
    "schemaVersion" in snapshot.value &&
    snapshot.value.schemaVersion === 2
  ) {
    throw new Error(
      "Existing TeamSnapshotV2 must be upgraded with npm run migrate:snapshot before use"
    )
  }
  return validateDataPairV3(snapshot.value, receipt.value)
}
