import fs from "node:fs"

import { describe, expect, it } from "vitest"

import snapshotJson from "../data/snapshot.json"
import { teamSnapshotSchema } from "@/data/schema"
import type { TeamSnapshot } from "@/data/types"

const base = snapshotJson as TeamSnapshot
const clone = () => structuredClone(base)

describe("TeamSnapshot validation", () => {
  it("accepts the current validated live snapshot", () => {
    expect(teamSnapshotSchema.parse(base).contentHash).toBe(base.contentHash)
  })

  it("fails closed on a Wednesday 10:00 p.m. game", () => {
    if (base.identity.provider !== "stm") return
    const snapshot = clone()
    const wednesday = snapshot.games.find((game) => game.date === "2026-07-29")!
    wednesday.displayTime = "22:00"
    expect(() => teamSnapshotSchema.parse(snapshot)).toThrow(/Wednesday/)
  })

  it("supports all published game states and a doubleheader", () => {
    const snapshot = clone()
    const seed = structuredClone(snapshot.games[0])
    seed.teamScore = null
    seed.opponentScore = null
    seed.result = null
    seed.hasBoxScore = false
    const states = [
      "scheduled",
      "live",
      "unreported",
      "bye",
      "postponed",
      "canceled",
      "rescheduled",
      "tbd",
    ] as const
    snapshot.games.push(
      ...states.map((state, index) => ({
        ...seed,
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        date: "2026-08-08",
        scheduledAt: state === "tbd" ? null : `2026-08-08T${12 + index}:00:00`,
        displayTime: state === "tbd" ? null : `${12 + index}:00`,
        state,
        video:
          state === "bye" || state === "canceled"
            ? { state: "not_expected" as const, reason: state }
            : {
                state: "channel_only" as const,
                channelUrl: base.identity.youtubeChannelUrl,
                reason: "not_found" as const,
              },
      }))
    )
    expect(() => teamSnapshotSchema.parse(snapshot)).not.toThrow()
  })

  it.each([
    [
      "negative values",
      (snapshot: TeamSnapshot) => {
        snapshot.standings[0].wins = -1
      },
    ],
    [
      "inconsistent records",
      (snapshot: TeamSnapshot) => {
        snapshot.standings[0].gamesPlayed += 1
      },
    ],
    [
      "unsafe URLs",
      (snapshot: TeamSnapshot) => {
        snapshot.games[0].officialUrl = "https://evil.example/game"
      },
    ],
    [
      "unsafe YouTube URLs",
      (snapshot: TeamSnapshot) => {
        snapshot.games[0].video = {
          state: "verified_exact",
          channelUrl: snapshot.identity.youtubeChannelUrl,
          videoUrl: "https://evil.example/watch?v=abcdefghijk",
          videoTitle: "Wrong source",
          matchedBy: "verified_override",
        }
      },
    ],
    [
      "duplicate identities",
      (snapshot: TeamSnapshot) => {
        snapshot.roster[1].id = snapshot.roster[0].id
      },
    ],
    [
      "tied finals",
      (snapshot: TeamSnapshot) => {
        snapshot.games[0].opponentScore = snapshot.games[0].teamScore
      },
    ],
    [
      "box-score mismatches",
      (snapshot: TeamSnapshot) => {
        snapshot.boxScores[0].away.score += 1
      },
    ],
    [
      "impossible shooting lines",
      (snapshot: TeamSnapshot) => {
        snapshot.boxScores[0].home.players[0].fieldGoals.made = 99
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const snapshot = clone()
    mutate(snapshot)
    expect(() => teamSnapshotSchema.parse(snapshot)).toThrow()
  })

  it("represents zero-attempt shooting with a null percentage", () => {
    const zeroAttempt = base.boxScores
      .flatMap((score) => [...score.home.players, ...score.away.players])
      .find((player) => player.fieldGoals.attempted === 0)
    expect(zeroAttempt?.fieldGoals.percentage).toBeNull()
  })

  it("allows not_expected only for bye and canceled games", () => {
    const snapshot = clone()
    snapshot.games[0].video = {
      state: "not_expected",
      reason: "canceled",
    }
    expect(() => teamSnapshotSchema.parse(snapshot)).toThrow(
      /Only bye or canceled games/
    )
  })

  it("keeps unsafe HTML APIs out of application source", () => {
    const files = [
      "src/App.tsx",
      "src/components/ui/chart.tsx",
      "src/data/parser.ts",
    ]
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(
        "dangerouslySetInnerHTML"
      )
    }
  })
})
