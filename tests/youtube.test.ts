import { describe, expect, it } from "vitest"

import type { GameRow } from "@/data/types"
import {
  markVideoSourceUnavailable,
  resolveGameVideoMatches,
  type YouTubeVideo,
} from "../scripts/youtube"

const CHANNEL = "https://www.youtube.com/@STMSports-t3z"

function game(input: Partial<GameRow> = {}): GameRow {
  return {
    id: "game-1",
    date: "2026-07-29",
    scheduledAt: "2026-07-29T20:00:00",
    displayTime: "20:00",
    state: "final",
    opponentId: "team-2",
    opponentName: "Team 2",
    venue: null,
    isHome: true,
    teamScore: 65,
    opponentScore: 60,
    result: "W",
    officialUrl: "https://stmsports.ca/mens-basketball/game/game-1",
    hasBoxScore: false,
    video: {
      state: "channel_only",
      channelUrl: CHANNEL,
      reason: "not_found",
    },
    ...input,
  }
}

function video(id: string, title: string, authorUrl = CHANNEL): YouTubeVideo {
  return { id, title, authorUrl }
}

describe("game video resolution", () => {
  it("publishes an exact dated matchup with its match provenance", () => {
    const [resolved] = resolveGameVideoMatches({
      games: [game()],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1", "Semi-Uncs"],
      videos: [
        video(
          "6mEdC0PTWgA",
          "STM Summer 2026: Team 1 vs Team 2 - July 29, 2026"
        ),
      ],
    })

    expect(resolved.video).toEqual({
      state: "verified_exact",
      channelUrl: CHANNEL,
      videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
      videoTitle: "STM Summer 2026: Team 1 vs Team 2 - July 29, 2026",
      matchedBy: "date_and_teams",
    })
  })

  it("uses a unique undated opponent match only once per season matchup", () => {
    const [resolved] = resolveGameVideoMatches({
      games: [game()],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1"],
      videos: [video("6mEdC0PTWgA", "Team 1 vs Team 2")],
    })

    expect(resolved.video).toMatchObject({
      state: "verified_exact",
      matchedBy: "unique_opponent",
    })
  })

  it("distinguishes not-found and ambiguous channel fallbacks", () => {
    const [notFound] = resolveGameVideoMatches({
      games: [game()],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1"],
      videos: [],
    })
    const [ambiguous] = resolveGameVideoMatches({
      games: [game()],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1"],
      videos: [
        video("6mEdC0PTWgA", "Team 1 vs Team 2"),
        video("bmWpYMKVNEI", "Team 2 against Team 1"),
      ],
    })

    expect(notFound.video).toMatchObject({
      state: "channel_only",
      reason: "not_found",
    })
    expect(ambiguous.video).toMatchObject({
      state: "channel_only",
      reason: "ambiguous",
    })
  })

  it("preserves an exact link instead of automatically replacing it", () => {
    const previous = game({
      video: {
        state: "verified_exact",
        channelUrl: CHANNEL,
        videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
        videoTitle: "Previously verified upload",
        matchedBy: "verified_override",
      },
    })
    const [resolved] = resolveGameVideoMatches({
      games: [game()],
      previousGames: [previous],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1"],
      videos: [video("bmWpYMKVNEI", "Team 1 vs Team 2 - July 29, 2026")],
    })

    expect(resolved.video).toMatchObject({
      state: "verified_exact",
      videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
      matchedBy: "previously_verified",
    })
  })

  it("preserves exact links during outages and marks every other state explicitly", () => {
    const prior = game({
      video: {
        state: "verified_exact",
        channelUrl: CHANNEL,
        videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
        videoTitle: "Previously verified upload",
        matchedBy: "date_and_teams",
      },
    })
    const unavailable = markVideoSourceUnavailable({
      games: [
        game(),
        game({ id: "game-2", opponentName: "Team 3" }),
        game({
          id: "game-3",
          state: "canceled",
          teamScore: null,
          opponentScore: null,
          result: null,
        }),
      ],
      previousGames: [prior],
      channelUrl: CHANNEL,
    })

    expect(unavailable[0].video).toMatchObject({
      state: "verified_exact",
      matchedBy: "previously_verified",
    })
    expect(unavailable[1].video).toEqual({
      state: "channel_only",
      channelUrl: CHANNEL,
      reason: "source_unavailable",
    })
    expect(unavailable[2].video).toEqual({
      state: "not_expected",
      reason: "canceled",
    })
  })

  it("allows a reviewed override only when the video belongs to the channel", () => {
    const overrideUrl = "https://www.youtube.com/watch?v=6mEdC0PTWgA"
    const [resolved] = resolveGameVideoMatches({
      games: [game()],
      channelUrl: CHANNEL,
      teamAliases: ["Team 1"],
      videos: [video("6mEdC0PTWgA", "Reviewed upload")],
      overrides: { "game-1": overrideUrl },
    })

    expect(resolved.video).toMatchObject({
      state: "verified_exact",
      videoUrl: overrideUrl,
      matchedBy: "verified_override",
    })
    expect(() =>
      resolveGameVideoMatches({
        games: [game()],
        channelUrl: CHANNEL,
        teamAliases: ["Team 1"],
        videos: [],
        overrides: { "game-1": overrideUrl },
      })
    ).toThrow(/not published/)
  })
})
