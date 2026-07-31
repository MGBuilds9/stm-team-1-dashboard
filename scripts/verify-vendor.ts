import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { isDeepStrictEqual } from "node:util"
import { pathToFileURL } from "node:url"
import { createGunzip } from "node:zlib"

import { extract } from "tar-stream"
import { z } from "zod"

import {
  TRUSTED_VENDOR_POLICY,
  type TrustedVendorPackage,
} from "./vendor-trust"

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const vendoredPackageSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    file: z.string().min(1),
    sha256: digestSchema,
  })
  .strict()
const vendorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal("basketball-os.vendored-packages.v1"),
    sourceRepository: z.literal("basketball-os"),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    provisional: z.boolean(),
    packages: z
      .array(vendoredPackageSchema)
      .length(TRUSTED_VENDOR_POLICY.packages.length),
    schemas: z
      .object({
        gameVideoAvailabilityV3: digestSchema,
        teamSnapshotV3: digestSchema,
      })
      .strict(),
  })
  .strict()

async function regularFile(file: string, maxBytes: number): Promise<Buffer> {
  const metadata = await fs.lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${file} must be a regular non-symlink file`)
  }
  if (metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(`${file} exceeds its allowed size`)
  }
  return fs.readFile(file)
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function safeArchivePath(value: string): boolean {
  return (
    value.startsWith("package/") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  )
}

export async function inspectVendoredArchive(
  payload: Uint8Array,
  trusted: TrustedVendorPackage
): Promise<void> {
  const archive = extract()
  const members = new Map<string, Buffer>()
  let totalBytes = 0
  const state: { failed: boolean; failure?: Error } = { failed: false }

  archive.on("entry", (header, stream, next) => {
    const fail = (error: Error) => {
      if (state.failed) return
      state.failed = true
      state.failure = error
      stream.resume()
      archive.destroy()
    }
    if (
      header.type !== "file" ||
      !safeArchivePath(header.name) ||
      members.has(header.name)
    ) {
      fail(new Error(`${trusted.file} contains an unsafe archive member`))
      return
    }
    const headerSize = header.size ?? -1
    if (headerSize < 1 || headerSize > 512 * 1024) {
      fail(new Error(`${trusted.file} contains an oversized archive member`))
      return
    }

    const chunks: Buffer[] = []
    let memberBytes = 0
    stream.on("data", (chunk: Buffer) => {
      if (state.failed) return
      memberBytes += chunk.length
      totalBytes += chunk.length
      if (memberBytes > 512 * 1024 || totalBytes > 2 * 1024 * 1024) {
        fail(new Error(`${trusted.file} exceeds its expanded size limit`))
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", fail)
    stream.on("end", () => {
      if (state.failed) return
      members.set(header.name, Buffer.concat(chunks))
      next()
    })
  })

  try {
    await pipeline(Readable.from(payload), createGunzip(), archive)
  } catch (error) {
    if (state.failure) {
      throw new Error(
        `${trusted.file} is not a safe readable package archive: ${state.failure.message}`,
        {
          cause: error,
        }
      )
    }
    throw new Error(`${trusted.file} is not a safe readable package archive`, {
      cause: error,
    })
  }
  if (state.failed) {
    throw new Error(`${trusted.file} is not a safe readable package archive`)
  }

  const actualMembers = [...members.keys()].sort()
  const expectedMembers = [...trusted.members].sort()
  if (
    actualMembers.length !== expectedMembers.length ||
    actualMembers.some((member, index) => member !== expectedMembers[index])
  ) {
    throw new Error(`${trusted.file} archive members do not match policy`)
  }

  const packageJsonBytes = members.get("package/package.json")
  if (!packageJsonBytes) {
    throw new Error(`${trusted.file} is missing package/package.json`)
  }
  const packageJson = z
    .object({
      name: z.string(),
      version: z.string(),
      type: z.literal("module"),
      exports: z.record(z.string(), z.unknown()),
      scripts: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(packageJsonBytes.toString("utf8")))
  if (
    packageJson.name !== trusted.name ||
    packageJson.version !== trusted.version ||
    !isDeepStrictEqual(packageJson.exports, trusted.exports)
  ) {
    throw new Error(`${trusted.file} package identity or exports mismatch`)
  }
  const installLifecycleHooks = new Set([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
  ])
  if (
    Object.keys(packageJson.scripts ?? {}).some((script) =>
      installLifecycleHooks.has(script)
    )
  ) {
    throw new Error(`${trusted.file} contains an install lifecycle hook`)
  }

  for (const [member, expectedHash] of Object.entries(trusted.schemas)) {
    const schema = members.get(member)
    if (!schema || sha256(schema) !== expectedHash) {
      throw new Error(`${trusted.file} schema ${member} SHA-256 mismatch`)
    }
  }
}

export async function verifyVendorDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const expectedDirectoryEntries = new Set([
    "manifest.json",
    "SHA256SUMS",
    ...TRUSTED_VENDOR_POLICY.packages.map((entry) => entry.file),
  ])
  const directoryEntries = await fs.readdir(resolved, { withFileTypes: true })
  if (
    directoryEntries.length !== expectedDirectoryEntries.size ||
    directoryEntries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !expectedDirectoryEntries.has(entry.name)
    )
  ) {
    throw new Error("Vendor directory contents do not exactly match policy")
  }

  const manifest = vendorManifestSchema.parse(
    JSON.parse(
      (
        await regularFile(path.join(resolved, "manifest.json"), 64 * 1024)
      ).toString("utf8")
    )
  )
  if (manifest.provisional) {
    throw new Error(
      "Vendored packages are provisional and cannot enter a production build"
    )
  }
  if (manifest.sourceRevision !== TRUSTED_VENDOR_POLICY.sourceRevision) {
    throw new Error("Vendored Basketball OS source revision is not trusted")
  }
  if (
    manifest.schemas.gameVideoAvailabilityV3 !==
      TRUSTED_VENDOR_POLICY.packages[0].schemas[
        "package/schemas/game-video-availability-v3.schema.json"
      ] ||
    manifest.schemas.teamSnapshotV3 !==
      TRUSTED_VENDOR_POLICY.packages[0].schemas[
        "package/schemas/team-snapshot-v3.schema.json"
      ]
  ) {
    throw new Error("Vendored public schema hashes do not match policy")
  }

  const checksumLines: string[] = []
  for (const [index, trusted] of TRUSTED_VENDOR_POLICY.packages.entries()) {
    const entry = manifest.packages[index]
    if (
      !entry ||
      entry.name !== trusted.name ||
      entry.version !== trusted.version ||
      entry.file !== trusted.file ||
      entry.sha256 !== trusted.sha256
    ) {
      throw new Error("Vendored package manifest does not match policy")
    }
    const payload = await regularFile(
      path.join(resolved, entry.file),
      1024 * 1024
    )
    const actual = sha256(payload)
    if (actual !== entry.sha256) {
      throw new Error(`${entry.file} SHA-256 mismatch`)
    }
    await inspectVendoredArchive(payload, trusted)
    checksumLines.push(`${entry.sha256}  ${entry.file}`)
  }
  checksumLines.sort()
  const checksums = (
    await regularFile(path.join(resolved, "SHA256SUMS"), 16 * 1024)
  )
    .toString("utf8")
    .trim()
    .split("\n")
    .sort()
  if (
    checksums.length !== checksumLines.length ||
    checksums.some((line, index) => line !== checksumLines[index])
  ) {
    throw new Error("SHA256SUMS does not exactly match vendor/manifest.json")
  }
}

async function main(): Promise<void> {
  await verifyVendorDirectory(path.join(process.cwd(), "vendor"))
  process.stdout.write("Vendored Basketball OS packages verified.\n")
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
