import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

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
  assertSnapshotIdentityMatchesConfig,
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
import {
  buildDataReceiptV3,
  dataSnapshotSemanticHash,
  readValidatedDataPair,
} from "./data-receipt"
import { readTeamConfig } from "./team-config"

const ROOT = process.cwd()
const DATA_DIRECTORY = process.env.DASHBOARD_DATA_DIR ?? path.join(ROOT, "data")
const SNAPSHOT_PATH = path.join(DATA_DIRECTORY, "snapshot.json")
const RECEIPT_PATH = path.join(DATA_DIRECTORY, "receipt.json")

interface SyncBuild {
  snapshot: TeamSnapshot
}

export async function readPreviousSnapshot(
  file: string,
  config: TeamConfig
): Promise<TeamSnapshot | null> {
  const pair = await readValidatedDataPair({
    snapshotFile: file,
    receiptFile: path.join(path.dirname(file), "receipt.json"),
    allowBothMissing: true,
  })
  if (!pair) return null
  const { snapshot } = pair
  assertSnapshotIdentityMatchesConfig(snapshot, config)
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
    contentHash: dataSnapshotSemanticHash(candidate),
  }
  return { snapshot }
}

async function main() {
  const checkedAt = new Date().toISOString()
  const configPath =
    process.env.TEAM_CONFIG_PATH ?? path.join(ROOT, "config", "team.json")
  const config = await readTeamConfig(configPath)
  const previousSnapshot = await readPreviousSnapshot(SNAPSHOT_PATH, config)
  const build =
    config.provider === "stm"
      ? await buildStmSnapshot(config, checkedAt, previousSnapshot)
      : await buildTeamLinktSnapshot(config, checkedAt, previousSnapshot)
  const { snapshot } = build
  const validated = teamSnapshotSchema.parse(snapshot)
  assertSnapshotIdentityMatchesConfig(validated, config)
  const previousHash = previousSnapshot?.contentHash ?? null
  const contentHash = validated.contentHash

  if (previousHash === contentHash) {
    process.stdout.write(`UNCHANGED ${contentHash}\n`)
    return
  }

  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true })
  await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(validated, null, 2)}\n`)
  const receipt = buildDataReceiptV3(validated, previousHash)
  await fs.writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
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
