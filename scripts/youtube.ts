import fs from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import type { GameRow, GameVideoAvailability } from "../src/data/types"
import { fetchText } from "./source"

const youtubeVideoUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      ((url.hostname === "www.youtube.com" &&
        url.pathname === "/watch" &&
        /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
        (url.hostname === "youtu.be" &&
          /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)))
    )
  })

const overridesSchema = z.object({
  gameVideos: z.record(z.string().min(1), youtubeVideoUrlSchema),
})

export interface YouTubeVideo {
  id: string
  title: string
  authorUrl: string
}

export interface VideoResolution {
  games: GameRow[]
  channelHtml: string | null
  matchedCount: number
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function videoIdFromUrl(value: string): string | null {
  const url = new URL(value)
  if (url.hostname === "youtu.be") return url.pathname.slice(1) || null
  return url.searchParams.get("v")
}

export function extractYouTubeVideoIds(html: string, limit = 80): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= limit) break
  }
  return ids
}

function dateTokens(date: string): string[] {
  const value = new Date(`${date}T12:00:00Z`)
  const month = new Intl.DateTimeFormat("en-CA", {
    month: "long",
    timeZone: "UTC",
  }).format(value)
  const day = value.getUTCDate()
  const year = value.getUTCFullYear()
  return [
    normalized(`${month} ${day} ${year}`),
    normalized(`${month} ${day}th ${year}`),
    normalized(`${month} ${day}st ${year}`),
    normalized(`${month} ${day}nd ${year}`),
    normalized(`${month} ${day}rd ${year}`),
  ]
}

function containsName(title: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const needle = normalized(alias)
    return needle.length > 0 && title.includes(needle)
  })
}

function hasPublishedDate(title: string): boolean {
  return (
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
      title
    ) && /\b20\d{2}\b/.test(title)
  )
}

function canonicalChannel(value: string): string {
  return value.replace(/^http:/, "https:").replace(/\/+$/, "")
}

function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

function priorExactVideo(
  game: GameRow,
  previousGames: GameRow[],
  channelUrl: string
): GameVideoAvailability | null {
  const previous = previousGames.find((candidate) => candidate.id === game.id)
  if (
    previous?.video.state !== "verified_exact" ||
    canonicalChannel(previous.video.channelUrl) !== channelUrl
  ) {
    return null
  }
  return {
    ...previous.video,
    channelUrl,
    matchedBy: "previously_verified",
  }
}

function fallbackVideo(
  game: GameRow,
  previousGames: GameRow[],
  channelUrl: string,
  reason: "not_found" | "ambiguous" | "source_unavailable"
): GameVideoAvailability {
  if (game.state === "bye" || game.state === "canceled") {
    return { state: "not_expected", reason: game.state }
  }
  return (
    priorExactVideo(game, previousGames, channelUrl) ?? {
      state: "channel_only",
      channelUrl,
      reason,
    }
  )
}

export function markVideoSourceUnavailable(input: {
  games: GameRow[]
  previousGames?: GameRow[]
  channelUrl: string
}): GameRow[] {
  const channelUrl = canonicalChannel(input.channelUrl)
  const previousGames = input.previousGames ?? []
  return input.games.map((game) => ({
    ...game,
    video: fallbackVideo(game, previousGames, channelUrl, "source_unavailable"),
  }))
}

export function resolveGameVideoMatches(input: {
  games: GameRow[]
  previousGames?: GameRow[]
  channelUrl: string
  teamAliases: string[]
  videos: YouTubeVideo[]
  overrides?: Record<string, string>
}): GameRow[] {
  const channelUrl = canonicalChannel(input.channelUrl)
  const previousGames = input.previousGames ?? []
  const overrides = input.overrides ?? {}
  const videos = input.videos.filter(
    (video) => canonicalChannel(video.authorUrl) === channelUrl
  )
  const gamesByOpponent = new Map<string, GameRow[]>()
  for (const game of input.games) {
    const key = normalized(game.opponentName)
    gamesByOpponent.set(key, [...(gamesByOpponent.get(key) ?? []), game])
  }

  return input.games.map((game) => {
    if (game.state === "bye" || game.state === "canceled") {
      if (overrides[game.id]) {
        throw new Error(
          `Video override for ${game.id} targets a ${game.state} game`
        )
      }
      return {
        ...game,
        video: { state: "not_expected", reason: game.state },
      }
    }

    const override = overrides[game.id]
    if (override) {
      const overrideId = videoIdFromUrl(override)
      const video = videos.find((candidate) => candidate.id === overrideId)
      if (!video) {
        throw new Error(
          `Video override for ${game.id} is not published by ${channelUrl}`
        )
      }
      return {
        ...game,
        video: {
          state: "verified_exact",
          channelUrl,
          videoUrl: videoUrl(video.id),
          videoTitle: video.title,
          matchedBy: "verified_override",
        },
      }
    }

    const candidates = videos.filter((video) => {
      const title = normalized(video.title)
      if (
        !containsName(title, input.teamAliases) ||
        !containsName(title, [game.opponentName])
      ) {
        return false
      }
      return (
        !hasPublishedDate(title) ||
        dateTokens(game.date).some((date) => title.includes(date))
      )
    })
    const exact = candidates.filter((video) =>
      dateTokens(game.date).some((date) =>
        normalized(video.title).includes(date)
      )
    )
    const gamesAgainstOpponent =
      gamesByOpponent.get(normalized(game.opponentName)) ?? []
    const matched =
      exact.length === 1
        ? { video: exact[0], matchedBy: "date_and_teams" as const }
        : exact.length === 0 &&
            candidates.length === 1 &&
            gamesAgainstOpponent.length === 1
          ? { video: candidates[0], matchedBy: "unique_opponent" as const }
          : null
    const previous = priorExactVideo(game, previousGames, channelUrl)
    if (!matched) {
      const reason = candidates.length === 0 ? "not_found" : "ambiguous"
      return {
        ...game,
        video: fallbackVideo(game, previousGames, channelUrl, reason),
      }
    }

    const matchedUrl = videoUrl(matched.video.id)
    if (
      previous?.state === "verified_exact" &&
      previous.videoUrl !== matchedUrl
    ) {
      return { ...game, video: previous }
    }
    return {
      ...game,
      video: {
        state: "verified_exact",
        channelUrl,
        videoUrl: matchedUrl,
        videoTitle: matched.video.title,
        matchedBy: matched.matchedBy,
      },
    }
  })
}

async function fetchVideo(id: string): Promise<YouTubeVideo | null> {
  let response: Response
  try {
    response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        videoUrl(id)
      )}&format=json`,
      {
        headers: {
          accept: "application/json",
          "user-agent":
            "Basketball-Team-Dashboard/1.0 (+https://github.com/MGBuilds9)",
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`YouTube oEmbed returned HTTP ${response.status}`)
  }
  if (!response.ok) return null
  const payload = (await response.json()) as {
    title?: unknown
    author_url?: unknown
  }
  if (
    typeof payload.title !== "string" ||
    typeof payload.author_url !== "string"
  ) {
    return null
  }
  return {
    id,
    title: payload.title,
    authorUrl: canonicalChannel(payload.author_url),
  }
}

async function readOverrides(): Promise<Record<string, string>> {
  const file = path.join(process.cwd(), "config", "video-overrides.json")
  const parsed = overridesSchema.parse(
    JSON.parse(await fs.readFile(file, "utf8"))
  )
  return parsed.gameVideos
}

export async function resolveGameVideos(input: {
  games: GameRow[]
  previousGames?: GameRow[]
  channelUrl: string
  teamAliases: string[]
}): Promise<VideoResolution> {
  const channelUrl = canonicalChannel(input.channelUrl)
  const overrides = await readOverrides()
  let channelHtml: string
  let videos: YouTubeVideo[]
  try {
    channelHtml = await fetchText(`${channelUrl}/videos`)
    const overrideIds = Object.values(overrides)
      .map(videoIdFromUrl)
      .filter((id): id is string => id !== null)
    const ids = [
      ...new Set([...overrideIds, ...extractYouTubeVideoIds(channelHtml)]),
    ]
    videos = (await Promise.all(ids.map(fetchVideo))).filter(
      (video): video is YouTubeVideo => video !== null
    )
  } catch {
    const games = markVideoSourceUnavailable({
      games: input.games,
      previousGames: input.previousGames,
      channelUrl,
    })
    return {
      games,
      channelHtml: null,
      matchedCount: games.filter(
        (game) => game.video.state === "verified_exact"
      ).length,
    }
  }

  const games = resolveGameVideoMatches({
    ...input,
    channelUrl,
    videos,
    overrides,
  })
  return {
    games,
    channelHtml,
    matchedCount: games.filter((game) => game.video.state === "verified_exact")
      .length,
  }
}
