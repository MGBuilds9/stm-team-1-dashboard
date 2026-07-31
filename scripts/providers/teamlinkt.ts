import { load } from "cheerio"
import { canonicalSnapshotContentV1 } from "@basketball-os/public-contracts"

import type { TeamLinktTeamConfig } from "../../src/data/config"
import {
  compareUnicodeCodePointStringsV1,
  stableStringify,
} from "../../src/data/hash"
import {
  assembleSnapshot,
  type ParsedLeaguePlayer,
} from "../../src/data/parser"
import type {
  BoxScorePlayerLine,
  BoxScoreSide,
  GameBoxScore,
  GameRow,
  PlayerRow,
  ShootingLine,
  SourceReference,
  StandingRow,
  TeamSnapshot,
} from "../../src/data/types"
import { fetchJson, fetchText, postFormJson, sha256 } from "../source"
import { resolveGameVideos } from "../youtube"

interface TeamLinktEventRow {
  "0": string
  "1": string
  "2": string
  "3": string
  "4": string
  "5": string
  "6": number
  home_association_team_id: number
  away_assocation_team_id: number
}

interface NormalizedEvent {
  id: string
  date: string
  scheduledAt: string
  displayTime: string
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  homeScore: number | null
  awayScore: number | null
  venue: string | null
  officialUrl: string
  epochSeconds: number
}

interface RosterMember {
  id: string
  name: string
  jersey: number | null
}

interface BuildResult {
  snapshot: TeamSnapshot
  sourceCount: number
  gameCount: number
  boxScoreCount: number
  matchedVideoCount: number
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as UnknownRecord
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function numberValue(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function extractPayload(value: unknown): UnknownRecord {
  const root = record(value)
  return record(root.payload)
}

function parseCell(value: string): { name: string; score: number | null } {
  const $ = load(`<body>${value}</body>`)
  const name = $("span").first().text().replace(/\s+/g, " ").trim()
  const scoreMatch = $.root()
    .text()
    .match(/\((\d+)\)\s*$/)
  return {
    name,
    score: scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null,
  }
}

function publishedDateTime(
  dateLabel: string,
  timeLabel: string
): {
  date: string
  scheduledAt: string
  displayTime: string
  epochSeconds: number
} {
  const dateMatch = dateLabel.match(
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/
  )
  const timeMatch = timeLabel.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)\b/)
  const months: Record<string, string> = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  }
  if (!dateMatch || !timeMatch || !months[dateMatch[1]]) {
    throw new Error("TeamLinkt schedule row has an invalid published date/time")
  }
  const date = `${dateMatch[3]}-${months[dateMatch[1]]}-${dateMatch[2].padStart(2, "0")}`
  let hour = Number.parseInt(timeMatch[1], 10) % 12
  if (timeMatch[3] === "PM") hour += 12
  const displayTime = `${String(hour).padStart(2, "0")}:${timeMatch[2]}`
  const scheduledAt = `${date}T${displayTime}:00`
  return {
    date,
    displayTime,
    scheduledAt,
    epochSeconds: new Date(`${scheduledAt}-04:00`).getTime() / 1000,
  }
}

function normalizeEvent(
  raw: TeamLinktEventRow,
  associationId: string
): NormalizedEvent {
  const id = raw["2"].match(/\/event\/\d+\/(\d+)/i)?.[1]
  if (!id) throw new Error("TeamLinkt schedule row is missing an event ID")
  const home = parseCell(raw["3"])
  const away = parseCell(raw["4"])
  if (!home.name || !away.name) {
    throw new Error(`TeamLinkt event ${id} is missing a team identity`)
  }
  const timing = publishedDateTime(raw["0"], raw["1"])
  const venueText = load(`<body>${raw["5"]}</body>`)("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
  return {
    id,
    ...timing,
    homeTeamId: String(raw.home_association_team_id),
    awayTeamId: String(raw.away_assocation_team_id),
    homeTeamName: home.name,
    awayTeamName: away.name,
    homeScore: home.score,
    awayScore: away.score,
    venue: venueText || null,
    officialUrl: `https://leagues.teamlinkt.com/Leagues/event/${associationId}/${id}`,
  }
}

export function selectTeamLinktGames(
  events: NormalizedEvent[],
  selectedTeamId: string,
  checkedAt: string,
  channelUrl: string
): GameRow[] {
  const checkedEpoch = new Date(checkedAt).getTime() / 1000
  return events
    .filter(
      (event) =>
        event.homeTeamId === selectedTeamId ||
        event.awayTeamId === selectedTeamId
    )
    .map((event): GameRow => {
      const isHome = event.homeTeamId === selectedTeamId
      const opponentName = isHome ? event.awayTeamName : event.homeTeamName
      const opponentId = isHome ? event.awayTeamId : event.homeTeamId
      const isBye = opponentName.toLowerCase() === "bye"
      const scored =
        event.homeScore !== null && event.awayScore !== null && !isBye
      const state: GameRow["state"] = isBye
        ? "bye"
        : scored
          ? "final"
          : event.epochSeconds < checkedEpoch
            ? "unreported"
            : "scheduled"
      const teamScore = scored
        ? isHome
          ? event.homeScore
          : event.awayScore
        : null
      const opponentScore = scored
        ? isHome
          ? event.awayScore
          : event.homeScore
        : null
      return {
        id: event.id,
        date: event.date,
        scheduledAt: event.scheduledAt,
        displayTime: event.displayTime,
        state,
        opponentId,
        opponentName,
        venue: event.venue,
        isHome,
        teamScore,
        opponentScore,
        result:
          teamScore === null || opponentScore === null
            ? null
            : teamScore > opponentScore
              ? "W"
              : "L",
        officialUrl: event.officialUrl,
        hasBoxScore: false,
        video:
          state === "bye"
            ? { state: "not_expected", reason: "bye" }
            : { state: "channel_only", channelUrl, reason: "not_found" },
      }
    })
    .sort((a, b) =>
      compareUnicodeCodePointStringsV1(a.scheduledAt ?? "", b.scheduledAt ?? "")
    )
}

export function deriveTeamLinktStandings(
  events: NormalizedEvent[]
): StandingRow[] {
  const teams = new Map<string, string>()
  for (const event of events) {
    if (event.homeTeamName.toLowerCase() !== "bye") {
      teams.set(event.homeTeamId, event.homeTeamName)
    }
    if (event.awayTeamName.toLowerCase() !== "bye") {
      teams.set(event.awayTeamId, event.awayTeamName)
    }
  }
  const rows = [...teams].map(([teamId, teamName]) => {
    const finals = events
      .filter(
        (event) =>
          (event.homeTeamId === teamId || event.awayTeamId === teamId) &&
          event.homeScore !== null &&
          event.awayScore !== null &&
          event.homeTeamName.toLowerCase() !== "bye" &&
          event.awayTeamName.toLowerCase() !== "bye"
      )
      .sort((a, b) => a.epochSeconds - b.epochSeconds)
    let wins = 0
    let losses = 0
    let pointsFor = 0
    let pointsAgainst = 0
    const form: Array<"W" | "L"> = []
    for (const event of finals) {
      const isHome = event.homeTeamId === teamId
      const scored = isHome ? event.homeScore! : event.awayScore!
      const allowed = isHome ? event.awayScore! : event.homeScore!
      const result = scored > allowed ? "W" : "L"
      if (result === "W") wins += 1
      else losses += 1
      pointsFor += scored
      pointsAgainst += allowed
      form.push(result)
    }
    const last = form.at(-1)
    let streakCount = 0
    if (last) {
      for (let index = form.length - 1; index >= 0; index -= 1) {
        if (form[index] !== last) break
        streakCount += 1
      }
    }
    return {
      rank: 0,
      teamId,
      teamName,
      wins,
      losses,
      gamesPlayed: wins + losses,
      winPct: wins + losses === 0 ? 0 : wins / (wins + losses),
      pointsFor,
      pointsAgainst,
      differential: pointsFor - pointsAgainst,
      streak: last ? `${last}${streakCount}` : "—",
      form: form.slice(-5),
    }
  })
  rows.sort(
    (a, b) =>
      b.winPct - a.winPct ||
      b.differential - a.differential ||
      b.pointsFor - a.pointsFor ||
      compareUnicodeCodePointStringsV1(a.teamName, b.teamName)
  )
  return rows.map((row, index) => ({ ...row, rank: index + 1 }))
}

function collectStatDefinitions(
  value: unknown,
  target = new Map<string, string>()
): Map<string, string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectStatDefinitions(entry, target)
    return target
  }
  const item = record(value)
  const statistic =
    Object.keys(record(item.Statistic)).length > 0
      ? record(item.Statistic)
      : item
  const id = stringValue(statistic.id)
  const abbreviation = stringValue(statistic.abbreviation)
  if (id && abbreviation) target.set(id, abbreviation)
  for (const child of Object.values(item)) {
    if (child !== item.Statistic) collectStatDefinitions(child, target)
  }
  return target
}

function shooting(made: number, attempted: number): ShootingLine {
  return {
    made,
    attempted,
    percentage:
      attempted === 0 ? null : Math.round((made / attempted) * 1000) / 10,
  }
}

function sumPlayerLines(players: BoxScorePlayerLine[]) {
  const sum = (pick: (player: BoxScorePlayerLine) => number): number =>
    players.reduce((total, player) => total + pick(player), 0)
  return {
    points: sum((player) => player.points),
    rebounds: sum((player) => player.rebounds),
    assists: sum((player) => player.assists),
    steals: sum((player) => player.steals),
    blocks: sum((player) => player.blocks),
    turnovers: sum((player) => player.turnovers),
    fouls: sum((player) => player.fouls),
    fieldGoals: shooting(
      sum((player) => player.fieldGoals.made),
      sum((player) => player.fieldGoals.attempted)
    ),
    threePointers: shooting(
      sum((player) => player.threePointers.made),
      sum((player) => player.threePointers.attempted)
    ),
    freeThrows: shooting(
      sum((player) => player.freeThrows.made),
      sum((player) => player.freeThrows.attempted)
    ),
  }
}

function parseStatsSide(
  payload: UnknownRecord,
  teamId: string,
  teamName: string,
  score: number
): BoxScoreSide | null {
  const statsRoot = record(payload.stats)
  const block = record(statsRoot[teamId])
  const playerStats = record(block.statistic)
  const playersById = record(block.players)
  const statTypes = record(payload.stat_types)
  const definitions = collectStatDefinitions(statTypes[teamId])
  const players = Object.entries(playerStats).map(
    ([playerId, rawStatistics]): BoxScorePlayerLine => {
      const byAbbreviation = new Map<string, number>()
      for (const [statisticId, rawStatistic] of Object.entries(
        record(rawStatistics)
      )) {
        const abbreviation = definitions.get(statisticId)
        if (!abbreviation) continue
        byAbbreviation.set(
          abbreviation,
          numberValue(record(rawStatistic).value)
        )
      }
      const player = record(playersById[playerId])
      const twoMade = byAbbreviation.get("2PM") ?? 0
      const twoAttempted = byAbbreviation.get("2PA") ?? 0
      const threeMade = byAbbreviation.get("3PM") ?? 0
      const threeAttempted = byAbbreviation.get("3PA") ?? 0
      const freeMade = byAbbreviation.get("FTM") ?? 0
      const freeAttempted = byAbbreviation.get("FTA") ?? 0
      const computedPoints = twoMade * 2 + threeMade * 3 + freeMade
      const publishedPoints = byAbbreviation.get("TP")
      if (publishedPoints !== undefined && publishedPoints !== computedPoints) {
        throw new Error(
          `TeamLinkt player ${playerId} has inconsistent point totals`
        )
      }
      const jerseyText = stringValue(player.jersey_number)
      return {
        playerId,
        playerName: stringValue(player.name) || `Player ${playerId}`,
        jersey: /^\d+$/.test(jerseyText)
          ? Number.parseInt(jerseyText, 10)
          : null,
        points: computedPoints,
        rebounds: byAbbreviation.get("TOTRB") ?? 0,
        assists: byAbbreviation.get("AST") ?? 0,
        steals: byAbbreviation.get("STL") ?? 0,
        blocks: byAbbreviation.get("BLK") ?? 0,
        turnovers: 0,
        fouls: 0,
        fieldGoals: shooting(
          twoMade + threeMade,
          twoAttempted + threeAttempted
        ),
        threePointers: shooting(threeMade, threeAttempted),
        freeThrows: shooting(freeMade, freeAttempted),
      }
    }
  )
  if (players.length === 0) return null
  const totals = sumPlayerLines(players)
  if (totals.points !== score) return null
  return { teamId, teamName, score, players, totals }
}

function parseStatsBoxScore(
  event: NormalizedEvent,
  payload: UnknownRecord
): GameBoxScore | null {
  if (event.homeScore === null || event.awayScore === null) return null
  const home = parseStatsSide(
    payload,
    event.homeTeamId,
    event.homeTeamName,
    event.homeScore
  )
  const away = parseStatsSide(
    payload,
    event.awayTeamId,
    event.awayTeamName,
    event.awayScore
  )
  if (!home || !away) return null
  return {
    gameId: event.id,
    date: event.date,
    officialUrl: event.officialUrl,
    home,
    away,
  }
}

function aggregatePlayers(input: {
  boxScores: GameBoxScore[]
  roster?: RosterMember[]
  selectedTeamId?: string
}): PlayerRow[] {
  interface Totals {
    id: string
    name: string
    jersey: number | null
    games: number
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    fgMade: number
    fgAttempted: number
    threeMade: number
    threeAttempted: number
    freeMade: number
    freeAttempted: number
  }
  const totals = new Map<string, Totals>()
  for (const member of input.roster ?? []) {
    totals.set(member.id, {
      id: member.id,
      name: member.name,
      jersey: member.jersey,
      games: 0,
      points: 0,
      rebounds: 0,
      assists: 0,
      steals: 0,
      blocks: 0,
      fgMade: 0,
      fgAttempted: 0,
      threeMade: 0,
      threeAttempted: 0,
      freeMade: 0,
      freeAttempted: 0,
    })
  }
  for (const boxScore of input.boxScores) {
    const sides = input.selectedTeamId
      ? [
          boxScore.home.teamId === input.selectedTeamId
            ? boxScore.home
            : boxScore.away,
        ]
      : [boxScore.home, boxScore.away]
    for (const side of sides) {
      for (const line of side.players) {
        const current = totals.get(line.playerId) ?? {
          id: line.playerId,
          name: line.playerName,
          jersey: line.jersey,
          games: 0,
          points: 0,
          rebounds: 0,
          assists: 0,
          steals: 0,
          blocks: 0,
          fgMade: 0,
          fgAttempted: 0,
          threeMade: 0,
          threeAttempted: 0,
          freeMade: 0,
          freeAttempted: 0,
        }
        current.games += 1
        current.points += line.points
        current.rebounds += line.rebounds
        current.assists += line.assists
        current.steals += line.steals
        current.blocks += line.blocks
        current.fgMade += line.fieldGoals.made
        current.fgAttempted += line.fieldGoals.attempted
        current.threeMade += line.threePointers.made
        current.threeAttempted += line.threePointers.attempted
        current.freeMade += line.freeThrows.made
        current.freeAttempted += line.freeThrows.attempted
        totals.set(line.playerId, current)
      }
    }
  }
  const average = (value: number, games: number) =>
    games === 0 ? 0 : Math.round((value / games) * 10) / 10
  const pct = (made: number, attempted: number) =>
    attempted === 0 ? null : Math.round((made / attempted) * 1000) / 10
  return [...totals.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      jersey: player.jersey,
      gamesPlayed: player.games,
      ppg: average(player.points, player.games),
      rpg: average(player.rebounds, player.games),
      apg: average(player.assists, player.games),
      spg: average(player.steals, player.games),
      bpg: average(player.blocks, player.games),
      fgPct: pct(player.fgMade, player.fgAttempted),
      threePct: pct(player.threeMade, player.threeAttempted),
      ftPct: pct(player.freeMade, player.freeAttempted),
    }))
    .sort(
      (a, b) =>
        (a.jersey ?? Number.MAX_SAFE_INTEGER) -
          (b.jersey ?? Number.MAX_SAFE_INTEGER) ||
        compareUnicodeCodePointStringsV1(a.name, b.name)
    )
}

function aggregateLeaguePlayers(
  boxScores: GameBoxScore[]
): ParsedLeaguePlayer[] {
  const byPlayer = new Map<
    string,
    {
      name: string
      teamName: string
      games: number
      points: number
      rebounds: number
      assists: number
      steals: number
      blocks: number
    }
  >()
  for (const boxScore of boxScores) {
    for (const side of [boxScore.home, boxScore.away]) {
      for (const player of side.players) {
        const key = `${side.teamId}:${player.playerId}`
        const current = byPlayer.get(key) ?? {
          name: player.playerName,
          teamName: side.teamName,
          games: 0,
          points: 0,
          rebounds: 0,
          assists: 0,
          steals: 0,
          blocks: 0,
        }
        current.games += 1
        current.points += player.points
        current.rebounds += player.rebounds
        current.assists += player.assists
        current.steals += player.steals
        current.blocks += player.blocks
        byPlayer.set(key, current)
      }
    }
  }
  const average = (value: number, games: number) =>
    games === 0 ? 0 : Math.round((value / games) * 10) / 10
  return [...byPlayer.values()].map((player) => ({
    name: player.name,
    teamName: player.teamName,
    ppg: average(player.points, player.games),
    rpg: average(player.rebounds, player.games),
    apg: average(player.assists, player.games),
    spg: average(player.steals, player.games),
    bpg: average(player.blocks, player.games),
  }))
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await task(values[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

function parseRoster(value: unknown): RosterMember[] {
  const data = record(value).data
  if (!Array.isArray(data)) {
    throw new Error("TeamLinkt roster response is missing its data rows")
  }
  return data.map((entry) => {
    const item = record(entry)
    const id = stringValue(item.id)
    const name = stringValue(item.name)
    if (!id || !name) throw new Error("TeamLinkt roster row is incomplete")
    const jersey = stringValue(item.jersey_number)
    return {
      id,
      name,
      jersey: /^\d+$/.test(jersey) ? Number.parseInt(jersey, 10) : null,
    }
  })
}

export function parseTeamLinktEvents(
  value: unknown,
  associationId: string
): NormalizedEvent[] {
  const data = record(value).data
  if (!Array.isArray(data)) {
    throw new Error("TeamLinkt schedule response is missing its data rows")
  }
  return data.map((entry) =>
    normalizeEvent(entry as TeamLinktEventRow, associationId)
  )
}

function publicStatsKey(eventHtml: string): string {
  const key = eventHtml.match(/["']X-Api-Key["']\s*:\s*["']([^"']+)["']/i)?.[1]
  if (!key) {
    throw new Error("TeamLinkt public event statistics marker is unavailable")
  }
  return key
}

function validateTeamIdentity(
  value: unknown,
  config: TeamLinktTeamConfig
): void {
  const team = record(extractPayload(value).Team)
  if (
    stringValue(team.id) !== config.teamId ||
    stringValue(team.name) !== config.sourceTeamName ||
    stringValue(team.season_id) !== config.seasonId ||
    stringValue(team.timezone) !== config.timezone
  ) {
    throw new Error("TeamLinkt selected team identity changed unexpectedly")
  }
}

function validatePublishedRecord(
  value: unknown,
  standings: StandingRow[],
  selectedTeamId: string
): void {
  const lastGame = record(extractPayload(value).last_game)
  if (Object.keys(lastGame).length === 0) return
  const teams = record(lastGame.teams)
  let published = ""
  for (const side of ["home", "away"]) {
    const opponent = record(record(teams[side]).Opponent)
    if (stringValue(opponent.association_team_id) === selectedTeamId) {
      published = stringValue(lastGame[`${side}_record`])
    }
  }
  if (!published) return
  const match = published.match(/^(\d+)-(\d+)-\d+$/)
  const derived = standings.find((row) => row.teamId === selectedTeamId)
  if (
    !match ||
    !derived ||
    derived.wins !== Number.parseInt(match[1], 10) ||
    derived.losses !== Number.parseInt(match[2], 10)
  ) {
    throw new Error("TeamLinkt published record disagrees with season scores")
  }
}

export async function buildTeamLinktSnapshot(
  config: TeamLinktTeamConfig,
  checkedAt: string,
  previousSnapshot: TeamSnapshot | null = null
): Promise<BuildResult> {
  const associationId = config.source.associationId
  const teamId = config.source.teamId
  const teamUrl = `https://leagues.teamlinkt.com/leagues/getTeam/${associationId}/${teamId}`
  const teamHomeUrl = `https://leagues.teamlinkt.com/leagues/getTeamHomePage/${teamId}`
  const rosterUrl = `https://leagues.teamlinkt.com/leagues/getTeamRosterForDatatable/${associationId}/${teamId}/1`
  const scheduleUrl = `https://leagues.teamlinkt.com/leagues/getAllEvents/${associationId}`
  const [teamResponse, homeResponse, rosterResponse, scheduleResponse] =
    await Promise.all([
      fetchJson<unknown>(teamUrl),
      fetchJson<unknown>(teamHomeUrl),
      fetchJson<unknown>(rosterUrl),
      postFormJson<unknown>(scheduleUrl, {
        status: "all",
        length: "1000",
        start: "0",
        type: "schedule",
        season_id: config.source.seasonId,
        is_league_site: "1",
      }),
    ])
  validateTeamIdentity(teamResponse, config)
  const rosterMembers = parseRoster(rosterResponse)
  const events = parseTeamLinktEvents(scheduleResponse, associationId)
  const standings = deriveTeamLinktStandings(events)
  validatePublishedRecord(homeResponse, standings, teamId)
  let games = selectTeamLinktGames(
    events,
    teamId,
    checkedAt,
    config.youtube.channelUrl
  )
  const videoResolution = await resolveGameVideos({
    games,
    previousGames: previousSnapshot?.games,
    channelUrl: config.youtube.channelUrl,
    teamAliases: config.youtube.teamAliases,
  })
  games = videoResolution.games

  const finalEvents = events.filter(
    (event) =>
      event.homeScore !== null &&
      event.awayScore !== null &&
      event.homeTeamName.toLowerCase() !== "bye" &&
      event.awayTeamName.toLowerCase() !== "bye"
  )
  const bootstrapEvent = finalEvents.at(-1)
  if (!bootstrapEvent) {
    throw new Error("TeamLinkt season has no completed games")
  }
  const bootstrapHtml = await fetchText(bootstrapEvent.officialUrl)
  const apiKey = publicStatsKey(bootstrapHtml)
  const statsPayloads = await mapWithConcurrency(
    finalEvents,
    6,
    async (event) => {
      const response = await postFormJson<unknown>(
        `https://leagues.teamlinkt.com/leagues/getPlayerStatsForEvent/${associationId}`,
        { association_event_id: event.id },
        { "X-Api-Key": apiKey }
      )
      return {
        event,
        payload: extractPayload(response),
      }
    }
  )
  const leagueBoxScores = statsPayloads
    .map(({ event, payload }) => parseStatsBoxScore(event, payload))
    .filter((score): score is GameBoxScore => score !== null)
  const selectedBoxScores = leagueBoxScores.filter(
    (score) => score.home.teamId === teamId || score.away.teamId === teamId
  )
  const roster = aggregatePlayers({
    boxScores: selectedBoxScores,
    roster: rosterMembers,
    selectedTeamId: teamId,
  })
  const leaguePlayers = aggregateLeaguePlayers(leagueBoxScores)

  const sources: SourceReference[] = [
    {
      label: "team",
      url: teamUrl,
      checkedAt,
      hash: sha256(
        stableStringify({
          teamId,
          teamName: config.sourceTeamName,
          seasonId: config.source.seasonId,
        })
      ),
    },
    {
      label: "team-home",
      url: teamHomeUrl,
      checkedAt,
      hash: sha256(
        stableStringify(standings.find((row) => row.teamId === teamId))
      ),
    },
    {
      label: "roster",
      url: rosterUrl,
      checkedAt,
      hash: sha256(stableStringify(rosterMembers)),
    },
    {
      label: "schedule",
      url: scheduleUrl,
      checkedAt,
      hash: sha256(stableStringify(events)),
    },
    ...(videoResolution.channelHtml !== null
      ? [
          {
            label: "youtube-channel",
            url: config.youtube.channelUrl,
            checkedAt,
            hash: sha256(videoResolution.channelHtml),
          },
        ]
      : (previousSnapshot?.sources.filter(
          (source) =>
            source.label === "youtube-channel" &&
            source.url === config.youtube.channelUrl
        ) ?? [])),
    ...events
      .filter(
        (event) => event.homeTeamId === teamId || event.awayTeamId === teamId
      )
      .map((event) => ({
        label: `game-${event.id}`,
        url: event.officialUrl,
        checkedAt,
        hash: sha256(
          stableStringify({
            event,
            hasBoxScore: selectedBoxScores.some(
              (score) => score.gameId === event.id
            ),
          })
        ),
      })),
  ]
  const core = {
    standings,
    roster,
    games,
    leaguePlayers,
    boxScores: selectedBoxScores,
  }
  const candidate = assembleSnapshot({
    generatedAt: checkedAt,
    ...core,
    sources,
    identity: {
      provider: "teamlinkt",
      leagueId: config.leagueId,
      seasonId: config.seasonId,
      teamId: config.teamId,
      name: config.teamName,
      seasonName: config.seasonName,
      leagueName: config.leagueName,
      timezone: config.timezone,
      youtubeChannelUrl: config.youtube.channelUrl,
    },
    capabilities: {
      roster: true,
      standings: "derived",
      leagueLeaders: "derived",
      boxScores: true,
      liveScores: false,
      gameVideos: true,
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
    boxScoreCount: selectedBoxScores.length,
    matchedVideoCount: videoResolution.matchedCount,
  }
}
