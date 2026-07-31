import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  parseBoxScore,
  parseLeaguePlayers,
  parseRoster,
  parseStandings,
} from "@/data/parser"
import type { GameRow } from "@/data/types"

const fixture = (name: string) =>
  fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "live", name),
    "utf8"
  )

describe("sanitized live-source fixtures", () => {
  it("extracts every standings field and derives consistent differentials", () => {
    const standings = parseStandings(fixture("standings.html"))
    const team = standings.find((row) => row.teamName === "Team 1")
    expect(standings).toHaveLength(6)
    expect(team).toMatchObject({
      rank: 3,
      wins: 2,
      losses: 3,
      gamesPlayed: 5,
      pointsFor: 303,
      pointsAgainst: 273,
      differential: 30,
    })
  })

  it("extracts the complete Team 1 roster", () => {
    const roster = parseRoster(fixture("roster.html"))
    expect(roster).toHaveLength(9)
    expect(roster[0]).toMatchObject({
      name: "Shady Bishay",
      jersey: 5,
      gamesPlayed: 3,
      ppg: 21.7,
    })
  })

  it("extracts league rows used for all five leader categories", () => {
    const players = parseLeaguePlayers(fixture("stats.html"))
    expect(players.length).toBeGreaterThan(20)
    expect(players).toContainEqual(
      expect.objectContaining({
        name: "Anthony Hirmina",
        teamName: "Team 6",
        ppg: 31,
      })
    )
  })

  it("extracts both teams, player lines, and totals from a completed game", () => {
    const game: GameRow = {
      id: "ecbe5296-d355-4d8a-abf5-6ba6f73d2964",
      date: "2026-06-24",
      scheduledAt: "2026-06-24T20:00:00",
      displayTime: "20:00",
      state: "final",
      opponentId: "482864b5-9443-4ad7-a4ff-4cb623d3dba0",
      opponentName: "Team 2",
      venue: null,
      isHome: false,
      teamScore: 65,
      opponentScore: 74,
      result: "L",
      officialUrl:
        "https://stmsports.ca/mens-basketball/game/ecbe5296-d355-4d8a-abf5-6ba6f73d2964",
      hasBoxScore: true,
      video: {
        state: "channel_only",
        channelUrl: "https://www.youtube.com/@STMSports-t3z",
        reason: "not_found",
      },
    }
    const boxScore = parseBoxScore(fixture(`box-score-${game.id}.html`), game)
    expect(boxScore?.home.teamName).toBe("Team 2")
    expect(boxScore?.home.score).toBe(74)
    expect(boxScore?.away.teamName).toBe("Team 1")
    expect(boxScore?.away.score).toBe(65)
    expect(boxScore?.home.players.length).toBeGreaterThan(5)
    expect(boxScore?.away.players.length).toBeGreaterThan(5)
  })
})
