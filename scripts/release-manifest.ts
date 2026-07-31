import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  canonicalSnapshotContentV1,
  parseTeamSnapshotV3,
} from "@basketball-os/public-contracts"
import { z } from "zod"

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
  const snapshot = parseTeamSnapshotV3(input)
  const computed = createHash("sha256")
    .update(canonicalSnapshotContentV1(snapshot))
    .digest("hex")
  if (computed !== snapshot.contentHash) {
    throw new Error("Snapshot semantic content hash does not match")
  }
  return computed
}

async function writeManifest(): Promise<void> {
  const snapshot = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "data", "snapshot.json"), "utf8")
  )
  const manifest = buildReleaseManifest({
    codeRevision: process.env.CODE_REVISION ?? "local",
    dataRevision: process.env.DATA_REVISION ?? "local",
    snapshotContentHash: verifiedSnapshotContentHash(snapshot),
  })
  const output = path.join(process.cwd(), "dist", "release.json")
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  })
  process.stdout.write(`Wrote ${path.relative(process.cwd(), output)}.\n`)
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
