import {
  createHash,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  canonicalJson,
  parseTeamSnapshotV3,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"
import {
  computeTeamReleaseDigest,
  detectExactVideoTransitions,
  verifyTeamReleaseAgainstTrustedHead,
  type SignedTeamRelease,
  type TeamReleaseSigningKey,
} from "@basketball-os/team-release"
import { z } from "zod"

import { teamConfigSchema } from "../src/data/config"

const MAX_BUNDLE_BYTES = 12 * 1024 * 1024
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const prefixedDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const stableIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/)
const identitySchema = z
  .object({
    providerId: z.enum(["stm", "teamlinkt"]),
    leagueId: stableIdSchema,
    seasonId: stableIdSchema,
    teamId: stableIdSchema,
  })
  .strict()
const trustKeySchema = z
  .object({
    keyId: stableIdSchema,
    algorithm: z.literal("Ed25519"),
    publicKeyPem: z.string().min(1).max(2_048),
    status: z.enum(["active", "revoked"]),
    audiences: z
      .array(z.enum(["public", "team"]))
      .min(1)
      .max(2),
    identity: identitySchema,
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    revokedAt: z.iso.datetime().optional(),
  })
  .strict()
const trustConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal("basketball-team-dashboard.release-trust.v1"),
    keys: z.array(trustKeySchema),
  })
  .strict()
const releaseReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal("basketball-team-dashboard.release-receipt.v1"),
    releaseId: stableIdSchema,
    sequence: z.number().int().positive(),
    previousReleaseDigest: prefixedDigestSchema.nullable(),
    releaseDigest: prefixedDigestSchema,
    bundleSha256: digestSchema,
    contentHash: digestSchema,
    sourceSetHash: prefixedDigestSchema,
    verificationHash: prefixedDigestSchema,
    signerKeyId: stableIdSchema,
    issuedAt: z.iso.datetime(),
    audience: z.literal("public"),
    codeRevision: stableIdSchema,
    dataRevision: stableIdSchema,
  })
  .strict()

export type ReleaseReceipt = z.infer<typeof releaseReceiptSchema>

export interface ImportTeamReleaseOptions {
  bundlePath: string
  outputDirectory: string
  teamConfigPath: string
  trustConfigPath: string
  now?: Date | string
}

export type ImportTeamReleaseResult =
  | { state: "imported"; receipt: ReleaseReceipt }
  | { state: "unchanged"; receipt: ReleaseReceipt }

function driftError(): Error {
  return new Error(
    "Existing derived release files drift from the trusted receipt"
  )
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function readStableRegularFile(
  file: string,
  maximumBytes: number
): Promise<Buffer> {
  const before = await fs.lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${file} must be a regular non-symlink file`)
  }
  if (before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`${file} exceeds its allowed size`)
  }
  const payload = await fs.readFile(file)
  const after = await fs.lstat(file, { bigint: true })
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`${file} changed while it was being read`)
  }
  return payload
}

async function readOptionalStableRegularFile(
  file: string,
  maximumBytes: number
): Promise<Buffer | null> {
  try {
    return await readStableRegularFile(file, maximumBytes)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

function parseCanonicalJson(payload: Buffer, file: string): unknown {
  const text = payload.toString("utf8")
  const parsed = JSON.parse(text) as unknown
  if (canonicalJson(parsed) !== text) {
    throw new Error(`${file} must use canonical JSON without duplicate keys`)
  }
  return parsed
}

async function readOptionalCanonicalJson(
  file: string,
  maximumBytes: number
): Promise<unknown | null> {
  const payload = await readOptionalStableRegularFile(file, maximumBytes)
  return payload === null ? null : parseCanonicalJson(payload, file)
}

function signingKeys(
  config: z.infer<typeof trustConfigSchema>
): TeamReleaseSigningKey[] {
  const seen = new Set<string>()
  return config.keys.map((key) => {
    if (seen.has(key.keyId)) {
      throw new Error(`Duplicate trusted key id: ${key.keyId}`)
    }
    seen.add(key.keyId)
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(key.publicKeyPem)
    } catch {
      throw new Error(`Trusted key ${key.keyId} is not valid public-key PEM`)
    }
    return {
      keyId: key.keyId,
      algorithm: key.algorithm,
      publicKey,
      status: key.status,
      audiences: key.audiences,
      identity: key.identity,
      validFrom: key.validFrom,
      ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
      ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
    }
  })
}

async function assertSafeOutputDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  const metadata = await fs.lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Release output must be a regular non-symlink directory")
  }
  for (const name of [
    "team-release.json",
    "snapshot.json",
    "release-receipt.json",
  ]) {
    try {
      const target = await fs.lstat(path.join(directory, name))
      if (target.isSymbolicLink()) {
        throw new Error(`Refusing symlink output target: ${name}`)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue
      }
      throw error
    }
  }
}

async function atomicWrite(file: string, value: string): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  )
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.chmod(temporary, 0o644)
  await fs.rename(temporary, file)
}

async function currentSnapshot(
  outputDirectory: string
): Promise<TeamSnapshotV3 | null> {
  const parsed = await readOptionalCanonicalJson(
    path.join(outputDirectory, "snapshot.json"),
    MAX_BUNDLE_BYTES
  )
  return parsed === null ? null : parseTeamSnapshotV3(parsed)
}

export async function importTeamRelease(
  options: ImportTeamReleaseOptions
): Promise<ImportTeamReleaseResult> {
  const bundleBytes = await readStableRegularFile(
    options.bundlePath,
    MAX_BUNDLE_BYTES
  )
  const bundleText = bundleBytes.toString("utf8")
  const bundle = parseCanonicalJson(bundleBytes, "Team release")

  const teamConfig = teamConfigSchema.parse(
    JSON.parse(
      (await readStableRegularFile(options.teamConfigPath, 64 * 1024)).toString(
        "utf8"
      )
    )
  )
  const trustConfig = trustConfigSchema.parse(
    JSON.parse(
      (
        await readStableRegularFile(options.trustConfigPath, 256 * 1024)
      ).toString("utf8")
    )
  )
  const keys = signingKeys(trustConfig)
  if (keys.length === 0) {
    throw new Error("At least one scoped release verification key is required")
  }

  await assertSafeOutputDirectory(options.outputDirectory)
  const receiptPath = path.join(options.outputDirectory, "release-receipt.json")
  const storedBundlePath = path.join(
    options.outputDirectory,
    "team-release.json"
  )
  const previousReceiptValue = await readOptionalCanonicalJson(
    receiptPath,
    64 * 1024
  )
  const storedBundleBytes = await readOptionalStableRegularFile(
    storedBundlePath,
    MAX_BUNDLE_BYTES
  )
  const previousSnapshot = await currentSnapshot(options.outputDirectory)
  const previousReceipt =
    previousReceiptValue === null
      ? null
      : releaseReceiptSchema.parse(previousReceiptValue)
  const hasCompletePreviousRelease =
    previousReceipt !== null &&
    storedBundleBytes !== null &&
    previousSnapshot !== null
  const hasNoPreviousRelease =
    previousReceipt === null &&
    storedBundleBytes === null &&
    previousSnapshot === null
  if (!hasCompletePreviousRelease && !hasNoPreviousRelease) {
    throw new Error("Existing derived release files are incomplete")
  }
  if (previousReceipt && storedBundleBytes && previousSnapshot) {
    const storedBundle = parseCanonicalJson(
      storedBundleBytes,
      storedBundlePath
    ) as Partial<SignedTeamRelease>
    const storedSnapshotPayload = storedBundle.snapshotPayload
    if (typeof storedSnapshotPayload !== "string") {
      throw driftError()
    }
    const storedSnapshotBytes = Buffer.from(storedSnapshotPayload, "base64")
    if (
      sha256(storedBundleBytes) !== previousReceipt.bundleSha256 ||
      computeTeamReleaseDigest(storedBundle as SignedTeamRelease) !==
        previousReceipt.releaseDigest ||
      storedSnapshotBytes.toString("base64") !== storedSnapshotPayload ||
      !storedSnapshotBytes.equals(
        Buffer.from(canonicalJson(previousSnapshot), "utf8")
      ) ||
      previousSnapshot.contentHash !== previousReceipt.contentHash
    ) {
      throw driftError()
    }
  }
  const bundleSha256 = sha256(bundleBytes)
  const idempotent =
    previousReceipt !== null && previousReceipt.bundleSha256 === bundleSha256
  if (
    idempotent &&
    (storedBundleBytes === null || !storedBundleBytes.equals(bundleBytes))
  ) {
    throw driftError()
  }
  const expectedSequence =
    previousReceipt === null
      ? 1
      : idempotent
        ? previousReceipt.sequence
        : previousReceipt.sequence + 1
  const expectedPreviousReleaseDigest =
    previousReceipt === null
      ? null
      : idempotent
        ? previousReceipt.previousReleaseDigest
        : previousReceipt.releaseDigest
  const expectedIdentity = {
    providerId: teamConfig.provider,
    leagueId: teamConfig.leagueId,
    seasonId: teamConfig.seasonId,
    teamId: teamConfig.teamId,
  }
  const verified = verifyTeamReleaseAgainstTrustedHead(bundle, {
    keys,
    expectedIdentity,
    expectedSequence,
    expectedPreviousReleaseDigest,
    ...(options.now ? { now: options.now } : {}),
  })
  if (verified.manifest.audience !== "public") {
    throw new Error("Dashboard imports require a public-audience release")
  }
  if (
    verified.snapshot.identity.name !== teamConfig.teamName ||
    verified.snapshot.identity.youtubeChannelUrl !==
      teamConfig.youtube.channelUrl
  ) {
    throw new Error("Signed snapshot does not match the configured team")
  }

  if (previousSnapshot) {
    const transitions = detectExactVideoTransitions(
      previousSnapshot,
      verified.snapshot
    )
    if (transitions.length > 0) {
      throw new Error(
        `VIDEO_REVIEW_REQUIRED: ${transitions
          .map((transition) => transition.gameId)
          .join(",")}`
      )
    }
  }

  const releaseDigest = computeTeamReleaseDigest(bundle as SignedTeamRelease)
  const receipt = releaseReceiptSchema.parse({
    schemaVersion: 1,
    contract: "basketball-team-dashboard.release-receipt.v1",
    releaseId: verified.manifest.releaseId,
    sequence: verified.manifest.sequence,
    previousReleaseDigest: verified.manifest.previousReleaseDigest,
    releaseDigest,
    bundleSha256,
    contentHash: verified.snapshot.contentHash,
    sourceSetHash: verified.manifest.sourceSetHash,
    verificationHash: verified.manifest.verificationHash,
    signerKeyId: verified.signerKeyId,
    issuedAt: verified.manifest.issuedAt,
    audience: "public",
    codeRevision: verified.manifest.codeRevision,
    dataRevision: verified.manifest.dataRevision,
  })
  const snapshotText = canonicalJson(verified.snapshot)
  const receiptText = canonicalJson(receipt)

  if (idempotent) {
    if (
      previousReceipt === null ||
      canonicalJson(previousReceipt) !== receiptText ||
      previousSnapshot === null ||
      canonicalJson(previousSnapshot) !== snapshotText
    ) {
      throw driftError()
    }
    return { state: "unchanged", receipt }
  }

  await atomicWrite(storedBundlePath, bundleText)
  await atomicWrite(
    path.join(options.outputDirectory, "snapshot.json"),
    snapshotText
  )
  await atomicWrite(receiptPath, receiptText)
  const directory = await fs.open(options.outputDirectory, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  return { state: "imported", receipt }
}

async function main(): Promise<void> {
  const bundlePath = process.argv[2]
  if (!bundlePath) {
    throw new Error("Usage: import-team-release <candidate-release.json>")
  }
  const result = await importTeamRelease({
    bundlePath,
    outputDirectory: path.join(process.cwd(), "data"),
    teamConfigPath: path.join(process.cwd(), "config", "team.json"),
    trustConfigPath: path.join(process.cwd(), "config", "release-trust.json"),
  })
  process.stdout.write(
    `${result.state === "imported" ? "IMPORTED" : "UNCHANGED"} ${result.receipt.contentHash}\n`
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
