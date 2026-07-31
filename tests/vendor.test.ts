import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"

import { pack } from "tar-stream"
import { afterEach, describe, expect, it } from "vitest"

import {
  inspectVendoredArchive,
  verifyVendorDirectory,
} from "../scripts/verify-vendor"
import type { TrustedVendorPackage } from "../scripts/vendor-trust"

const temporaryDirectories: string[] = []

interface ArchiveEntry {
  name: string
  type?: "file" | "symlink"
  body?: string | Buffer
  linkname?: string
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function createArchive(entries: ArchiveEntry[]): Promise<Buffer> {
  const archive = pack()
  const chunks: Buffer[] = []
  archive.on("data", (chunk: Buffer) => chunks.push(chunk))
  const completed = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve)
    archive.on("error", reject)
  })
  for (const entry of entries) {
    archive.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        linkname: entry.linkname,
      },
      entry.body ?? ""
    )
  }
  archive.finalize()
  await completed
  return gzipSync(Buffer.concat(chunks))
}

const syntheticPackageJson = JSON.stringify({
  name: "@basketball-os/public-contracts",
  version: "0.1.0",
  type: "module",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  },
})
const syntheticSchema = '{"type":"object"}'
const syntheticPolicy: TrustedVendorPackage = {
  name: "@basketball-os/public-contracts",
  version: "0.1.0",
  file: "basketball-os-public-contracts-0.1.0.tgz",
  sha256: "0".repeat(64),
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  },
  members: ["package/package.json", "package/schemas/test.schema.json"],
  schemas: {
    "package/schemas/test.schema.json": sha256(syntheticSchema),
  },
}

async function copyVendor(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "basketball-vendor-"))
  temporaryDirectories.push(root)
  await fs.cp("vendor", root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("vendored Basketball OS package boundary", () => {
  it("verifies every exact production package byte", async () => {
    await expect(verifyVendorDirectory("vendor")).resolves.toBeUndefined()
  })

  it("rejects provisional packages at the production boundary", async () => {
    const vendor = await copyVendor()
    const manifestPath = path.join(vendor, "manifest.json")
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>
    manifest.provisional = true
    await fs.writeFile(manifestPath, JSON.stringify(manifest))

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(/provisional/i)
  })

  it("rejects a changed package byte", async () => {
    const vendor = await copyVendor()
    const packagePath = path.join(
      vendor,
      "basketball-os-public-contracts-0.1.0.tgz"
    )
    await fs.appendFile(packagePath, "tampered")

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(
      /SHA-256 mismatch/
    )
  })

  it("rejects a self-asserted source revision", async () => {
    const vendor = await copyVendor()
    const manifestPath = path.join(vendor, "manifest.json")
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>
    manifest.sourceRevision = "f".repeat(40)
    await fs.writeFile(manifestPath, JSON.stringify(manifest))

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(
      /source revision is not trusted/
    )
  })

  it("rejects swapped package identities even when archive bytes are unchanged", async () => {
    const vendor = await copyVendor()
    const manifestPath = path.join(vendor, "manifest.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      packages: Array<{ name: string }>
    }
    const firstName = manifest.packages[0].name
    manifest.packages[0].name = manifest.packages[1].name
    manifest.packages[1].name = firstName
    await fs.writeFile(manifestPath, JSON.stringify(manifest))

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(
      /manifest does not match policy/
    )
  })

  it("rejects self-asserted schema hashes", async () => {
    const vendor = await copyVendor()
    const manifestPath = path.join(vendor, "manifest.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemas: Record<string, string>
    }
    manifest.schemas.gameVideoAvailabilityV3 = "a".repeat(64)
    manifest.schemas.teamSnapshotV3 = "b".repeat(64)
    await fs.writeFile(manifestPath, JSON.stringify(manifest))

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(
      /schema hashes do not match policy/
    )
  })

  it("rejects unexpected files at the vendor boundary", async () => {
    const vendor = await copyVendor()
    await fs.writeFile(path.join(vendor, "unreviewed.tgz"), "unexpected")

    await expect(verifyVendorDirectory(vendor)).rejects.toThrow(
      /directory contents do not exactly match policy/
    )
  })

  it("rejects a non-regular package archive member", async () => {
    const archive = await createArchive([
      { name: "package/package.json", body: syntheticPackageJson },
      {
        name: "package/schemas/test.schema.json",
        type: "symlink",
        linkname: "../../outside",
      },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/safe readable package archive/)
  })

  it.each(["../outside", "package/../outside", String.raw`package\outside`])(
    "rejects unsafe archive path %s",
    async (name) => {
      const archive = await createArchive([{ name, body: "unsafe" }])

      await expect(
        inspectVendoredArchive(archive, syntheticPolicy)
      ).rejects.toThrow(/safe readable package archive/)
    }
  )

  it("rejects duplicate archive members", async () => {
    const archive = await createArchive([
      { name: "package/package.json", body: syntheticPackageJson },
      { name: "package/package.json", body: syntheticPackageJson },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/safe readable package archive/)
  })

  it("rejects a member that exceeds the expansion limit", async () => {
    const archive = await createArchive([
      {
        name: "package/oversized.bin",
        body: Buffer.alloc(512 * 1024 + 1, 1),
      },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/safe readable package archive/)
  })

  it("rejects an archive that exceeds the aggregate expansion limit", async () => {
    const archive = await createArchive(
      Array.from({ length: 5 }, (_, index) => ({
        name: `package/chunk-${index}.bin`,
        body: Buffer.alloc(450 * 1024, index),
      }))
    )

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/safe readable package archive/)
  })

  it("rejects package identity and export substitution inside an archive", async () => {
    const archive = await createArchive([
      {
        name: "package/package.json",
        body: JSON.stringify({
          ...JSON.parse(syntheticPackageJson),
          name: "@basketball-os/team-release",
        }),
      },
      {
        name: "package/schemas/test.schema.json",
        body: syntheticSchema,
      },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/package identity or exports mismatch/)
  })

  it("rejects install lifecycle hooks inside an archive", async () => {
    const archive = await createArchive([
      {
        name: "package/package.json",
        body: JSON.stringify({
          ...JSON.parse(syntheticPackageJson),
          scripts: { install: "node unreviewed-install.js" },
        }),
      },
      {
        name: "package/schemas/test.schema.json",
        body: syntheticSchema,
      },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/install lifecycle hook/)
  })

  it("rejects schema substitution inside an otherwise valid archive", async () => {
    const archive = await createArchive([
      { name: "package/package.json", body: syntheticPackageJson },
      {
        name: "package/schemas/test.schema.json",
        body: '{"type":"string"}',
      },
    ])

    await expect(
      inspectVendoredArchive(archive, syntheticPolicy)
    ).rejects.toThrow(/schema .* SHA-256 mismatch/)
  })
})
