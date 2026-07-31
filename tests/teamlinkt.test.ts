import { describe, expect, it } from "vitest"

import {
  deriveTeamLinktStandings,
  parseTeamLinktEvents,
  selectTeamLinktGames,
} from "../scripts/providers/teamlinkt"
import { extractYouTubeVideoIds } from "../scripts/youtube"

const row = (input: {
  id: number
  date: string
  time: string
  epoch: number
  homeId: number
  home: string
  homeScore?: number
  awayId: number
  away: string
  awayScore?: number
}) => ({
  "0": input.date,
  "1": input.time,
  "2": `Game <a href="https://leagues.teamlinkt.com/Leagues/event/9966/${input.id}">[Summary]</a>`,
  "3": `<span>${input.home}</span>${input.homeScore === undefined ? "" : ` (${input.homeScore})`}`,
  "4": `<span>${input.away}</span>${input.awayScore === undefined ? "" : ` (${input.awayScore})`}`,
  "5": "<a>SMSV Gym</a>",
  "6": input.epoch,
  home_association_team_id: input.homeId,
  away_assocation_team_id: input.awayId,
})

describe("TeamLinkt provider normalization", () => {
  const response = {
    data: [
      row({
        id: 1,
        date: "Sun May 31, 2026",
        time: "8:35 AM - 9:35 AM",
        epoch: 1_780_238_100,
        homeId: 892656,
        home: "The Tax Collectors",
        homeScore: 66,
        awayId: 892655,
        away: "Cross Bearers",
        awayScore: 59,
      }),
      row({
        id: 2,
        date: "Sun Jun 21, 2026",
        time: "6:30 PM - 7:30 PM",
        epoch: 1_782_088_200,
        homeId: 892654,
        home: "Bye",
        awayId: 892656,
        away: "The Tax Collectors",
      }),
      row({
        id: 3,
        date: "Sun Jul 26, 2026",
        time: "8:50 PM - 9:50 PM",
        epoch: 1_785_120_600,
        homeId: 892656,
        home: "The Tax Collectors",
        awayId: 892657,
        away: "The Judah Lions",
      }),
    ],
  }

  it("normalizes final, bye, and unreported games without trusting HTML", () => {
    const events = parseTeamLinktEvents(response, "9966")
    const games = selectTeamLinktGames(
      events,
      "892656",
      "2026-07-29T12:00:00.000Z",
      "https://www.youtube.com/@SBLHoops"
    )
    expect(games.map((game) => game.state)).toEqual([
      "final",
      "bye",
      "unreported",
    ])
    expect(games[0]).toMatchObject({
      opponentName: "Cross Bearers",
      displayTime: "08:35",
      teamScore: 66,
      opponentScore: 59,
      result: "W",
      video: {
        state: "channel_only",
        reason: "not_found",
      },
    })
    expect(games[1].video).toEqual({
      state: "not_expected",
      reason: "bye",
    })
  })

  it("derives standings from scored season games and excludes the Bye team", () => {
    const standings = deriveTeamLinktStandings(
      parseTeamLinktEvents(response, "9966")
    )
    expect(standings).toHaveLength(3)
    expect(standings.find((team) => team.teamId === "892656")).toMatchObject({
      rank: 1,
      wins: 1,
      losses: 0,
      pointsFor: 66,
      pointsAgainst: 59,
      streak: "W1",
      form: ["W"],
    })
    expect(standings.some((team) => team.teamName === "Bye")).toBe(false)
  })
})

describe("YouTube upload discovery", () => {
  it("extracts unique direct video IDs from the public channel payload", () => {
    const html =
      '{"videoId":"bmWpYMKVNEI"}{"videoId":"bmWpYMKVNEI"}{"videoId":"6mEdC0PTWgA"}'
    expect(extractYouTubeVideoIds(html)).toEqual(["bmWpYMKVNEI", "6mEdC0PTWgA"])
  })
})
