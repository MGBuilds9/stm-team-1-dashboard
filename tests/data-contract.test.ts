import { createHash } from "node:crypto"

import {
  canonicalSnapshotContentV1,
  parseTeamSnapshotV3,
} from "@basketball-os/public-contracts"
import { describe, expect, it } from "vitest"

import snapshotJson from "../data/snapshot.json"
import { assembleSnapshot } from "@/data/parser"
import type { TeamSnapshotV3 } from "@/data/types"

const snapshot = parseTeamSnapshotV3(snapshotJson)
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex")

describe("TeamSnapshotV3 producer contract", () => {
  it("binds the embedded snapshot to its canonical semantic hash", () => {
    expect(snapshot.contentHash).toBe(
      sha256(canonicalSnapshotContentV1(snapshot))
    )
  })

  it("assembles V3 and hashes the complete semantic projection", () => {
    const candidate = assembleSnapshot({
      generatedAt: snapshot.generatedAt,
      standings: snapshot.standings,
      roster: snapshot.roster,
      games: snapshot.games,
      leaguePlayers: snapshot.roster.map((player) => ({
        name: player.name,
        teamName: snapshot.team.name,
        ppg: player.ppg,
        rpg: player.rpg,
        apg: player.apg,
        spg: player.spg,
        bpg: player.bpg,
      })),
      boxScores: snapshot.boxScores,
      sources: snapshot.sources,
      identity: snapshot.identity,
      capabilities: snapshot.capabilities,
      sourceTeamName: snapshot.team.name,
    })
    const produced: TeamSnapshotV3 = {
      ...candidate,
      contentHash: sha256(canonicalSnapshotContentV1(candidate)),
    }

    expect(produced.schemaVersion).toBe(3)
    expect(() => parseTeamSnapshotV3(produced)).not.toThrow()
    expect(produced.contentHash).toBe(
      sha256(canonicalSnapshotContentV1(produced))
    )
  })

  it("excludes volatile retrieval metadata but covers public video semantics", () => {
    const retrievalRefresh = {
      ...snapshot,
      generatedAt: "2026-08-01T04:00:00.000Z",
      sources: snapshot.sources.map((source) => ({
        ...source,
        checkedAt: "2026-08-01T04:00:00.000Z",
        hash: "f".repeat(64),
      })),
    }
    const videoStateChange = structuredClone(snapshot)
    const game = videoStateChange.games.find(
      (candidate) => candidate.video.state !== "not_expected"
    )!
    game.video = {
      state: "channel_only",
      channelUrl: snapshot.identity.youtubeChannelUrl,
      reason: "source_unavailable",
    }

    expect(canonicalSnapshotContentV1(retrievalRefresh)).toBe(
      canonicalSnapshotContentV1(snapshot)
    )
    expect(canonicalSnapshotContentV1(videoStateChange)).not.toBe(
      canonicalSnapshotContentV1(snapshot)
    )
  })
})
