import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { z } from "zod"

import { assertSnapshotIdentityMatchesConfig } from "../src/data/config"
import {
  readValidatedDataPair,
  validateDataPairV3,
  verifyDataSnapshotV3,
} from "./data-receipt"
import { readTeamConfig } from "./team-config"

const revisionSchema = z.union([
  z.literal("local"),
  z.string().regex(/^[a-f0-9]{40}$/),
])
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)

const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseContract: z.literal("basketball-team-dashboard.release.v1"),
    codeRevision: revisionSchema,
    dataRevision: revisionSchema,
    snapshotContentHash: hashSchema,
  })
  .strict()

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>

export interface ExpectedRelease {
  codeRevision: string
  dataRevision: string
  snapshotContentHash: string
}

export function buildReleaseManifest(
  expected: ExpectedRelease
): ReleaseManifest {
  return releaseManifestSchema.parse({
    schemaVersion: 1,
    releaseContract: "basketball-team-dashboard.release.v1",
    ...expected,
  })
}

export function parseReleaseManifest(value: string): ReleaseManifest {
  return releaseManifestSchema.parse(JSON.parse(value))
}

export function releaseMatches(
  manifest: ReleaseManifest,
  expected: ExpectedRelease
): boolean {
  return (
    manifest.codeRevision === expected.codeRevision &&
    manifest.dataRevision === expected.dataRevision &&
    manifest.snapshotContentHash === expected.snapshotContentHash
  )
}

export function verifiedSnapshotContentHash(input: unknown): string {
  return verifyDataSnapshotV3(input).contentHash
}

export function verifiedDataPairContentHash(
  snapshotInput: unknown,
  receiptInput: unknown
): string {
  return validateDataPairV3(snapshotInput, receiptInput).snapshot.contentHash
}

export async function writeManifest(
  root = process.cwd()
): Promise<ReleaseManifest> {
  const pair = await readValidatedDataPair({
    snapshotFile: path.join(root, "data", "snapshot.json"),
    receiptFile: path.join(root, "data", "receipt.json"),
  })
  if (!pair) throw new Error("Validated data pair is required")
  const config = await readTeamConfig(path.join(root, "config", "team.json"))
  assertSnapshotIdentityMatchesConfig(pair.snapshot, config)
  const manifest = buildReleaseManifest({
    codeRevision: process.env.CODE_REVISION ?? "local",
    dataRevision: process.env.DATA_REVISION ?? "local",
    snapshotContentHash: pair.snapshot.contentHash,
  })
  const output = path.join(root, "dist", "release.json")
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  })
  process.stdout.write(`Wrote ${path.relative(root, output)}.\n`)
  return manifest
}

async function compareManifest(args: string[]): Promise<void> {
  const [manifestPath, codeRevision, dataRevision, snapshotContentHash] = args
  if (!manifestPath || !codeRevision || !dataRevision || !snapshotContentHash) {
    throw new Error(
      "Usage: release-manifest matches <path> <codeRevision> <dataRevision> <snapshotContentHash>"
    )
  }
  const manifest = parseReleaseManifest(
    await fs.readFile(path.resolve(manifestPath), "utf8")
  )
  const matches = releaseMatches(manifest, {
    codeRevision,
    dataRevision,
    snapshotContentHash,
  })
  process.stdout.write(matches ? "MATCH\n" : "MISMATCH\n")
  if (!matches) process.exitCode = 1
}

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2)
  if (action === "write") {
    await writeManifest()
    return
  }
  if (action === "matches") {
    await compareManifest(args)
    return
  }
  throw new Error("Usage: release-manifest <write|matches>")
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 2
  })
}
