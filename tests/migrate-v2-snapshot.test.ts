import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  canonicalSnapshotContentV1,
  parseTeamSnapshotV3,
  teamSnapshotV2CompatibilitySchema,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"
import { afterEach, describe, expect, it } from "vitest"

import snapshotJson from "../data/snapshot.json"
import {
  migrateSnapshotPair,
  migrateSnapshotV2,
  verifySnapshotV3,
} from "../scripts/migrate-v2-snapshot"

const sourceSnapshot = parseTeamSnapshotV3(snapshotJson)
const v2Snapshot = teamSnapshotV2CompatibilitySchema.parse({
  ...sourceSnapshot,
  schemaVersion: 2,
  contentHash: "0".repeat(64),
  games: sourceSnapshot.games.map(({ video, ...game }) => ({
    ...game,
    videoUrl: video.state === "verified_exact" ? video.videoUrl : null,
    videoTitle: video.state === "verified_exact" ? video.videoTitle : null,
    videoChannelUrl:
      video.state === "verified_exact" ? video.channelUrl : undefined,
    videoMatchedBy:
      video.state === "verified_exact" ? video.matchedBy : undefined,
  })),
})

const temporaryDirectories: string[] = []

function receiptFacts(snapshot: typeof v2Snapshot | TeamSnapshotV3) {
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

function v2Receipt(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    ...receiptFacts(v2Snapshot),
    contentHash: v2Snapshot.contentHash,
    previousHash: "1".repeat(64),
    ...overrides,
  }
}

function v3Receipt(
  snapshot: TeamSnapshotV3,
  overrides: Record<string, unknown> = {}
) {
  return {
    schemaVersion: 3,
    ...receiptFacts(snapshot),
    contentHash: snapshot.contentHash,
    previousHash: v2Snapshot.contentHash,
    ...overrides,
  }
}

async function createPair(input: {
  snapshot: unknown
  receipt?: unknown | string
}): Promise<{ directory: string; snapshotFile: string; receiptFile: string }> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "dashboard-v3-migration-")
  )
  temporaryDirectories.push(directory)
  const snapshotFile = path.join(directory, "snapshot.json")
  const receiptFile = path.join(directory, "receipt.json")
  await fs.writeFile(
    snapshotFile,
    `${JSON.stringify(input.snapshot, null, 2)}\n`
  )
  if (input.receipt !== undefined) {
    await fs.writeFile(
      receiptFile,
      typeof input.receipt === "string"
        ? input.receipt
        : `${JSON.stringify(input.receipt, null, 2)}\n`
    )
  }
  return { directory, snapshotFile, receiptFile }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("TeamSnapshotV2 migration", () => {
  it("rehashes the V3 semantic projection and maps every video state explicitly", () => {
    const migrated = migrateSnapshotV2(v2Snapshot)

    expect(() => parseTeamSnapshotV3(migrated)).not.toThrow()
    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.contentHash).toBe(
      createHash("sha256")
        .update(canonicalSnapshotContentV1(migrated))
        .digest("hex")
    )
    expect(migrated.games).toHaveLength(v2Snapshot.games.length)
    for (const [index, game] of migrated.games.entries()) {
      const previous = v2Snapshot.games[index]
      if (previous.videoUrl && previous.videoTitle) {
        expect(game.video).toMatchObject({
          state: "verified_exact",
          videoUrl: previous.videoUrl,
          videoTitle: previous.videoTitle,
          matchedBy: previous.videoMatchedBy ?? "previously_verified",
        })
      } else if (previous.state === "bye" || previous.state === "canceled") {
        expect(game.video).toEqual({
          state: "not_expected",
          reason: previous.state,
        })
      } else {
        expect(game.video).toMatchObject({
          state: "channel_only",
          reason: "not_found",
        })
      }
    }
  })

  it("rejects a V3 snapshot whose semantic hash was changed", () => {
    const migrated = migrateSnapshotV2(v2Snapshot)

    expect(() =>
      verifySnapshotV3({
        ...migrated,
        capabilities: {
          ...migrated.capabilities,
          liveScores: !migrated.capabilities.liveScores,
        },
      })
    ).toThrow(/semantic content hash/)
  })

  it("migrates a coherent V2 snapshot and receipt as one Git data pair", async () => {
    const pair = await createPair({
      snapshot: v2Snapshot,
      receipt: v2Receipt(),
    })

    const result = await migrateSnapshotPair(pair.snapshotFile)
    const storedSnapshot = parseTeamSnapshotV3(
      await readJson(pair.snapshotFile)
    )
    const storedReceipt = await readJson(pair.receiptFile)

    expect(result.status).toBe("migrated")
    expect(storedReceipt).toMatchObject({
      schemaVersion: 3,
      contentHash: storedSnapshot.contentHash,
      previousHash: v2Snapshot.contentHash,
      provider: storedSnapshot.identity.provider,
      teamId: storedSnapshot.identity.teamId,
    })
  })

  it("recovers a V2 snapshot with a missing receipt deterministically", async () => {
    const pair = await createPair({ snapshot: v2Snapshot })

    const result = await migrateSnapshotPair(pair.snapshotFile)

    expect(result.status).toBe("migrated")
    await expect(readJson(pair.receiptFile)).resolves.toMatchObject({
      schemaVersion: 3,
      contentHash: result.snapshot.contentHash,
      previousHash: v2Snapshot.contentHash,
    })
  })

  it("leaves an already coherent V3 pair byte-for-byte unchanged", async () => {
    const snapshot = migrateSnapshotV2(v2Snapshot)
    const pair = await createPair({
      snapshot,
      receipt: v3Receipt(snapshot),
    })
    const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")
    const beforeReceipt = await fs.readFile(pair.receiptFile, "utf8")

    const result = await migrateSnapshotPair(pair.snapshotFile)

    expect(result.status).toBe("unchanged")
    await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
      beforeSnapshot
    )
    await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
      beforeReceipt
    )
  })

  it("rejects a stale V3 receipt without rewriting the valid V3 snapshot", async () => {
    const snapshot = migrateSnapshotV2(v2Snapshot)
    const pair = await createPair({
      snapshot,
      receipt: v3Receipt(snapshot, { contentHash: "f".repeat(64) }),
    })
    const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")
    const beforeReceipt = await fs.readFile(pair.receiptFile, "utf8")

    await expect(migrateSnapshotPair(pair.snapshotFile)).rejects.toThrow(
      /contentHash does not match/
    )
    await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
      beforeSnapshot
    )
    await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
      beforeReceipt
    )
  })

  it("rejects a malformed receipt before changing the V2 snapshot", async () => {
    const pair = await createPair({
      snapshot: v2Snapshot,
      receipt: "{not-json",
    })
    const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")

    await expect(migrateSnapshotPair(pair.snapshotFile)).rejects.toThrow()
    await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
      beforeSnapshot
    )
  })

  it.each([
    ["content hash", { contentHash: "f".repeat(64) }],
    ["team identity", { teamId: "different-team" }],
    ["source count", { sourceCount: v2Snapshot.sources.length + 1 }],
  ])(
    "rejects a mismatched V2 receipt (%s) without changing either file",
    async (_label, mismatch) => {
      const pair = await createPair({
        snapshot: v2Snapshot,
        receipt: v2Receipt(mismatch),
      })
      const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")
      const beforeReceipt = await fs.readFile(pair.receiptFile, "utf8")

      await expect(migrateSnapshotPair(pair.snapshotFile)).rejects.toThrow(
        /does not match/
      )
      await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
        beforeSnapshot
      )
      await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
        beforeReceipt
      )
    }
  )

  it.each([
    ["missing", undefined],
    ["V2", v2Receipt()],
  ])(
    "rejects a V3 snapshot with a %s receipt instead of fabricating provenance",
    async (_label, receipt) => {
      const snapshot = migrateSnapshotV2(v2Snapshot)
      const pair = await createPair({ snapshot, receipt })
      const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")
      const beforeReceipt =
        receipt === undefined
          ? null
          : await fs.readFile(pair.receiptFile, "utf8")

      await expect(migrateSnapshotPair(pair.snapshotFile)).rejects.toThrow(
        /requires its exact V3 receipt/
      )
      await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
        beforeSnapshot
      )
      if (beforeReceipt === null) {
        await expect(fs.stat(pair.receiptFile)).rejects.toMatchObject({
          code: "ENOENT",
        })
      } else {
        await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
          beforeReceipt
        )
      }
    }
  )

  it("completes only the exact V2 plus V3 receipt state left by interruption", async () => {
    const snapshot = migrateSnapshotV2(v2Snapshot)
    const receipt = v3Receipt(snapshot)
    const pair = await createPair({
      snapshot: v2Snapshot,
      receipt,
    })
    const beforeReceipt = await fs.readFile(pair.receiptFile, "utf8")

    const result = await migrateSnapshotPair(pair.snapshotFile)

    expect(result.status).toBe("migrated")
    expect(parseTeamSnapshotV3(await readJson(pair.snapshotFile))).toEqual(
      snapshot
    )
    await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
      beforeReceipt
    )
  })

  it("rejects a non-exact V3 receipt beside V2 before changing either file", async () => {
    const snapshot = migrateSnapshotV2(v2Snapshot)
    const pair = await createPair({
      snapshot: v2Snapshot,
      receipt: v3Receipt(snapshot, {
        previousHash: "f".repeat(64),
      }),
    })
    const beforeSnapshot = await fs.readFile(pair.snapshotFile, "utf8")
    const beforeReceipt = await fs.readFile(pair.receiptFile, "utf8")

    await expect(migrateSnapshotPair(pair.snapshotFile)).rejects.toThrow(
      /does not match the migrated snapshot/
    )
    await expect(fs.readFile(pair.snapshotFile, "utf8")).resolves.toBe(
      beforeSnapshot
    )
    await expect(fs.readFile(pair.receiptFile, "utf8")).resolves.toBe(
      beforeReceipt
    )
  })
})
