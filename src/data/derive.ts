import type {
  BoxScorePlayerLine,
  GameBoxScore,
  LeaderCategory,
  LeaderRow,
  PlayerRow,
  ShootingLine,
  TeamStats,
} from "./types"
import { compareUnicodeCodePointStringsV1 } from "./hash"

const CATEGORIES: Array<{
  category: LeaderCategory
  label: string
  unit: string
}> = [
  { category: "ppg", label: "Points", unit: "PPG" },
  { category: "rpg", label: "Rebounds", unit: "RPG" },
  { category: "apg", label: "Assists", unit: "APG" },
  { category: "spg", label: "Steals", unit: "SPG" },
  { category: "bpg", label: "Blocks", unit: "BPG" },
]

export function deriveLeaders(
  rows: Array<
    Pick<PlayerRow, "name" | "ppg" | "rpg" | "apg" | "spg" | "bpg"> & {
      teamName?: string
    }
  >,
  fallbackTeam: string
): LeaderRow[] {
  return CATEGORIES.map(({ category, label, unit }) => {
    const max = Math.max(...rows.map((row) => row[category]), 0)
    const tiedRows = rows.filter((row) => row[category] === max)
    const winner = [...tiedRows].sort((a, b) =>
      compareUnicodeCodePointStringsV1(a.name, b.name)
    )[0]
    return {
      category,
      label,
      playerName: winner?.name ?? "Not published",
      teamName: winner?.teamName ?? fallbackTeam,
      value: max,
      unit,
      tied: tiedRows.length > 1,
    }
  })
}

function sumShooting(
  lines: Array<
    Pick<BoxScorePlayerLine, "fieldGoals" | "threePointers" | "freeThrows">
  >,
  key: "fieldGoals" | "threePointers" | "freeThrows"
): ShootingLine {
  const made = lines.reduce((sum, line) => sum + line[key].made, 0)
  const attempted = lines.reduce((sum, line) => sum + line[key].attempted, 0)
  return {
    made,
    attempted,
    percentage:
      attempted === 0 ? null : Math.round((made / attempted) * 1000) / 10,
  }
}

export function deriveTeamStats(
  boxScores: GameBoxScore[],
  selectedTeamId: string
): TeamStats {
  const sides = boxScores.map((boxScore) =>
    boxScore.home.teamId === selectedTeamId ? boxScore.home : boxScore.away
  )
  const games = sides.length
  const average = (
    key: "points" | "rebounds" | "assists" | "steals" | "blocks"
  ) =>
    games === 0
      ? 0
      : Math.round(
          (sides.reduce((sum, side) => sum + side.totals[key], 0) / games) * 10
        ) / 10
  const lines = sides.map((side) => side.totals)
  const fieldGoals = sumShooting(lines, "fieldGoals")
  const threePointers = sumShooting(lines, "threePointers")
  const freeThrows = sumShooting(lines, "freeThrows")

  return {
    gamesWithBoxScores: games,
    pointsPerGame: average("points"),
    reboundsPerGame: average("rebounds"),
    assistsPerGame: average("assists"),
    stealsPerGame: average("steals"),
    blocksPerGame: average("blocks"),
    fieldGoalPct: fieldGoals.percentage,
    threePointPct: threePointers.percentage,
    freeThrowPct: freeThrows.percentage,
  }
}
