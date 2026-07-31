import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { canonicalSnapshotContentV1 } from "@basketball-os/public-contracts"

import {
  assembleSnapshot,
  parseBoxScore,
  parseLeaguePlayers,
  parseRoster,
  parseSchedule,
  parseStandings,
  SOURCE_URLS,
} from "../src/data/parser"
import {
  teamConfigSchema,
  type StmTeamConfig,
  type TeamConfig,
} from "../src/data/config"
import { teamSnapshotSchema } from "../src/data/schema"
import type {
  GameBoxScore,
  SourceReference,
  TeamSnapshot,
} from "../src/data/types"
import { fetchText, sha256 } from "./source"
import { resolveGameVideos } from "./youtube"
import { buildTeamLinktSnapshot } from "./providers/teamlinkt"

const ROOT = process.cwd()
const DATA_DIRECTORY = process.env.DASHBOARD_DATA_DIR ?? path.join(ROOT, "data")
const SNAPSHOT_PATH = path.join(DATA_DIRECTORY, "snapshot.json")
const RECEIPT_PATH = path.join(DATA_DIRECTORY, "receipt.json")

interface SyncBuild {
  snapshot: TeamSnapshot
  sourceCount: number
  gameCount: number
  boxScoreCount: number
  matchedVideoCount: number
}

export async function readPreviousSnapshot(
  file: string,
  config: TeamConfig
): Promise<TeamSnapshot | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    raw.schemaVersion === 2
  ) {
    throw new Error(
      "Existing TeamSnapshotV2 must be upgraded with npm run migrate:snapshot before synchronization"
    )
  }
  const snapshot = teamSnapshotSchema.parse(raw)
  if (
    snapshot.identity.provider !== config.provider ||
    snapshot.identity.leagueId !== config.leagueId ||
    snapshot.identity.seasonId !== config.seasonId ||
    snapshot.identity.teamId !== config.teamId ||
    snapshot.identity.name !== config.teamName ||
    snapshot.identity.seasonName !== config.seasonName ||
    snapshot.identity.leagueName !== config.leagueName ||
    snapshot.identity.timezone !== config.timezone ||
    snapshot.identity.youtubeChannelUrl !== config.youtube.channelUrl
  ) {
    throw new Error(
      "Existing snapshot identity does not match the configured team"
    )
  }
  return snapshot
}

async function buildStmSnapshot(
  config: StmTeamConfig,
  checkedAt: string,
  previousSnapshot: TeamSnapshot | null
): Promise<SyncBuild> {
  const entries = await Promise.all(
    Object.entries(SOURCE_URLS).map(async ([label, url]) => {
      const html = await fetchText(url)
      return { label, url, html }
    })
  )
  const source = Object.fromEntries(
    entries.map((entry) => [entry.label, entry.html])
  )
  const parsedGames = parseSchedule(source.schedule, config.youtube.channelUrl)
  const videoResolution = await resolveGameVideos({
    games: parsedGames,
    previousGames: previousSnapshot?.games,
    channelUrl: config.youtube.channelUrl,
    teamAliases: config.youtube.teamAliases,
  })
  const games = videoResolution.games
  const matchedVideoCount = videoResolution.matchedCount
  const videoSource: SourceReference | null =
    videoResolution.channelHtml === null
      ? (previousSnapshot?.sources.find(
          (source) =>
            source.label === "youtube-channel" &&
            source.url === config.youtube.channelUrl
        ) ?? null)
      : {
          label: "youtube-channel",
          url: config.youtube.channelUrl,
          checkedAt,
          hash: sha256(videoResolution.channelHtml),
        }
  if (videoResolution.channelHtml === null) {
    process.stderr.write(
      "YouTube source unavailable; preserving previously verified exact game links.\n"
    )
  }
  const finalGames = games.filter((game) => game.state === "final")
  const gamePages = await Promise.all(
    finalGames.map(async (game) => ({
      game,
      html: await fetchText(game.officialUrl),
    }))
  )
  const boxScores = gamePages
    .map(({ game, html }) =>
      parseBoxScore(html, game, {
        id: config.teamId,
        name: config.teamName,
      })
    )
    .filter((boxScore): boxScore is GameBoxScore => boxScore !== null)

  const sources: SourceReference[] = [
    ...entries.map((entry) => ({
      label: entry.label,
      url: entry.url,
      checkedAt,
      hash: sha256(entry.html),
    })),
    ...(videoSource ? [videoSource] : []),
    ...gamePages.map(({ game, html }) => ({
      label: `box-score-${game.id}`,
      url: game.officialUrl,
      checkedAt,
      hash: sha256(html),
    })),
  ]

  const core = {
    standings: parseStandings(source.standings),
    roster: parseRoster(source.team),
    games,
    leaguePlayers: parseLeaguePlayers(source.stats),
    boxScores,
  }
  const candidate = assembleSnapshot({
    generatedAt: checkedAt,
    ...core,
    sources,
    identity: {
      provider: config.provider,
      leagueId: config.leagueId,
      seasonId: config.seasonId,
      teamId: config.teamId,
      name: config.teamName,
      seasonName: config.seasonName,
      leagueName: config.leagueName,
      timezone: config.timezone,
      youtubeChannelUrl: config.youtube.channelUrl,
    },
    sourceTeamName: config.sourceTeamName,
  })
  const snapshot: TeamSnapshot = {
    ...candidate,
    contentHash: sha256(canonicalSnapshotContentV1(candidate)),
  }
  return {
    snapshot,
    sourceCount: sources.length,
    gameCount: games.length,
    boxScoreCount: boxScores.length,
    matchedVideoCount,
  }
}

async function main() {
  const checkedAt = new Date().toISOString()
  const configPath =
    process.env.TEAM_CONFIG_PATH ?? path.join(ROOT, "config", "team.json")
  const config = teamConfigSchema.parse(
    JSON.parse(await fs.readFile(configPath, "utf8"))
  )
  const previousSnapshot = await readPreviousSnapshot(SNAPSHOT_PATH, config)
  const build =
    config.provider === "stm"
      ? await buildStmSnapshot(config, checkedAt, previousSnapshot)
      : await buildTeamLinktSnapshot(config, checkedAt, previousSnapshot)
  const { snapshot } = build
  const validated = teamSnapshotSchema.parse(snapshot)
  const previousHash = previousSnapshot?.contentHash ?? null
  const contentHash = validated.contentHash

  if (previousHash === contentHash) {
    process.stdout.write(`UNCHANGED ${contentHash}\n`)
    return
  }

  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true })
  await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(validated, null, 2)}\n`)
  await fs.writeFile(
    RECEIPT_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        generatedAt: checkedAt,
        contentHash,
        previousHash,
        provider: config.provider,
        teamId: config.teamId,
        sourceCount: build.sourceCount,
        gameCount: build.gameCount,
        boxScoreCount: build.boxScoreCount,
        matchedVideoCount: build.matchedVideoCount,
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(`CHANGED ${contentHash}\n`)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
