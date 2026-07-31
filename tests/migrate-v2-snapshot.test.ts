import fs from "node:fs"

import {
  canonicalSnapshotContentV1,
  parseTeamSnapshotV3,
} from "@basketball-os/public-contracts"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  migrateSnapshotV2,
  verifySnapshotV3,
} from "../scripts/migrate-v2-snapshot"

const sourceSnapshot = JSON.parse(
  fs.readFileSync("data/snapshot.json", "utf8")
) as {
  schemaVersion: 2 | 3
  contentHash: string
  games: Array<{
    state: string
    video?: {
      state: "verified_exact" | "channel_only" | "not_expected"
      channelUrl?: string
      videoUrl?: string
      videoTitle?: string
      matchedBy?: string
    }
    videoUrl?: string | null
    videoTitle?: string | null
    videoMatchedBy?:
      | "date_and_teams"
      | "unique_opponent"
      | "verified_override"
      | "previously_verified"
  }>
}
const v2Snapshot =
  sourceSnapshot.schemaVersion === 2
    ? sourceSnapshot
    : {
        ...sourceSnapshot,
        schemaVersion: 2 as const,
        contentHash: "0".repeat(64),
        games: sourceSnapshot.games.map(({ video, ...game }) => ({
          ...game,
          videoUrl: video?.state === "verified_exact" ? video.videoUrl! : null,
          videoTitle:
            video?.state === "verified_exact" ? video.videoTitle! : null,
          videoChannelUrl:
            video?.state === "verified_exact" ? video.channelUrl : undefined,
          videoMatchedBy:
            video?.state === "verified_exact" ? video.matchedBy : undefined,
        })),
      }

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
})
