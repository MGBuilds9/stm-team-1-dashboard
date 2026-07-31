import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  buildReleaseManifest,
  parseReleaseManifest,
  releaseMatches,
  verifiedDataPairContentHash,
  verifiedSnapshotContentHash,
  writeManifest,
} from "../scripts/release-manifest"
import configJson from "../config/team.json"
import receiptJson from "../data/receipt.json"
import snapshotJson from "../data/snapshot.json"

const expected = {
  codeRevision: "a".repeat(40),
  dataRevision: "b".repeat(40),
  snapshotContentHash: "c".repeat(64),
}
const temporaryDirectories: string[] = []

async function releaseRoot(input: {
  snapshot?: unknown | string
  receipt?: unknown | string
  config?: unknown | string
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-release-"))
  temporaryDirectories.push(root)
  const data = path.join(root, "data")
  const config = path.join(root, "config")
  await fs.mkdir(data)
  await fs.mkdir(config)
  await fs.mkdir(path.join(root, "dist"))
  const write = async (file: string, value: unknown | string) =>
    fs.writeFile(
      file,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`
    )
  if (input.snapshot !== undefined) {
    await write(path.join(data, "snapshot.json"), input.snapshot)
  }
  if (input.receipt !== undefined) {
    await write(path.join(data, "receipt.json"), input.receipt)
  }
  await write(path.join(config, "team.json"), input.config ?? configJson)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("exact deployed release reconciliation", () => {
  it("builds and parses a deterministic public release manifest", () => {
    const manifest = buildReleaseManifest(expected)

    expect(manifest).toEqual({
      schemaVersion: 1,
      releaseContract: "basketball-team-dashboard.release.v1",
      ...expected,
    })
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual(manifest)
  })

  it("requires both the tested code and data revisions to match production", () => {
    const manifest = buildReleaseManifest(expected)

    expect(releaseMatches(manifest, expected)).toBe(true)
    expect(
      releaseMatches(manifest, {
        ...expected,
        dataRevision: "d".repeat(40),
      })
    ).toBe(false)
    expect(
      releaseMatches(manifest, {
        ...expected,
        codeRevision: "e".repeat(40),
      })
    ).toBe(false)
  })

  it("rejects publication when semantic snapshot content and its hash diverge", () => {
    expect(verifiedSnapshotContentHash(snapshotJson)).toBe(
      snapshotJson.contentHash
    )
    expect(() =>
      verifiedSnapshotContentHash({
        ...snapshotJson,
        capabilities: {
          ...snapshotJson.capabilities,
          liveScores: !snapshotJson.capabilities.liveScores,
        },
      })
    ).toThrow(/semantic content hash/)
  })

  it("binds release content to a coherent snapshot and receipt pair", () => {
    expect(verifiedDataPairContentHash(snapshotJson, receiptJson)).toBe(
      snapshotJson.contentHash
    )
    expect(() =>
      verifiedDataPairContentHash(snapshotJson, {
        ...receiptJson,
        contentHash: "f".repeat(64),
      })
    ).toThrow(/contentHash does not match/)
    expect(() =>
      verifiedDataPairContentHash(snapshotJson, {
        ...receiptJson,
        injected: true,
      })
    ).toThrow(/Unrecognized key/)
  })

  it("writes a release manifest only from a coherent exact data pair", async () => {
    const root = await releaseRoot({
      snapshot: snapshotJson,
      receipt: receiptJson,
    })

    const manifest = await writeManifest(root)

    expect(manifest.snapshotContentHash).toBe(snapshotJson.contentHash)
    await expect(
      fs.readFile(path.join(root, "dist", "release.json"), "utf8")
    ).resolves.toContain(snapshotJson.contentHash)
  })

  it("binds release output to the configured team identity", async () => {
    const root = await releaseRoot({
      snapshot: snapshotJson,
      receipt: receiptJson,
      config: {
        ...configJson,
        teamId: "different-team",
      },
    })

    await expect(writeManifest(root)).rejects.toThrow(
      /identity teamId does not match/
    )
    await expect(
      fs.stat(path.join(root, "dist", "release.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    ["missing receipt", { snapshot: snapshotJson }],
    ["orphan receipt", { receipt: receiptJson }],
    [
      "stale receipt",
      {
        snapshot: snapshotJson,
        receipt: { ...receiptJson, contentHash: "f".repeat(64) },
      },
    ],
    ["malformed receipt", { snapshot: snapshotJson, receipt: "{not-json" }],
  ])("refuses release output for a %s", async (_label, pair) => {
    const root = await releaseRoot(pair)

    await expect(writeManifest(root)).rejects.toThrow()
    await expect(
      fs.stat(path.join(root, "dist", "release.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    ["unknown fields", { ...buildReleaseManifest(expected), injected: true }],
    [
      "short revisions",
      { ...buildReleaseManifest(expected), codeRevision: "deadbeef" },
    ],
    [
      "unsafe hashes",
      {
        ...buildReleaseManifest(expected),
        snapshotContentHash: "<script>alert(1)</script>",
      },
    ],
  ])("rejects %s", (_label, manifest) => {
    expect(() => parseReleaseManifest(JSON.stringify(manifest))).toThrow()
  })
})
