import { z } from "zod"

import type { TeamSnapshotV3 } from "./types"

const baseConfig = {
  projectSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  leagueId: z.string().trim().min(1),
  seasonId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  teamName: z.string().trim().min(1).max(100),
  sourceTeamName: z.string().trim().min(1).max(100),
  seasonName: z.string().trim().min(1).max(100),
  leagueName: z.string().trim().min(1).max(100),
  timezone: z.literal("America/Toronto"),
  active: z.boolean(),
  manualCloseoutAt: z.string().datetime().nullable(),
  youtube: z.strictObject({
    channelUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === "https:" &&
          url.hostname === "www.youtube.com" &&
          url.pathname.startsWith("/@")
        )
      }, "YouTube channel must use its canonical https://www.youtube.com/@handle URL"),
    teamAliases: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  }),
}

const stmConfigSchema = z.strictObject({
  provider: z.literal("stm"),
  ...baseConfig,
  source: z.strictObject({
    leaguePath: z.literal("mens-basketball"),
  }),
  rules: z.strictObject({
    wednesdayStartTime: z.literal("20:00"),
  }),
})

const teamLinktConfigSchema = z.strictObject({
  provider: z.literal("teamlinkt"),
  ...baseConfig,
  source: z.strictObject({
    associationId: z.string().regex(/^\d+$/),
    teamId: z.string().regex(/^\d+$/),
    seasonId: z.string().regex(/^\d+$/),
  }),
})

export const teamConfigSchema = z.discriminatedUnion("provider", [
  stmConfigSchema,
  teamLinktConfigSchema,
])

export type TeamConfig = z.infer<typeof teamConfigSchema>
export type StmTeamConfig = z.infer<typeof stmConfigSchema>
export type TeamLinktTeamConfig = z.infer<typeof teamLinktConfigSchema>

function configuredIdentity(config: TeamConfig): TeamSnapshotV3["identity"] {
  return {
    provider: config.provider,
    leagueId: config.leagueId,
    seasonId: config.seasonId,
    teamId: config.teamId,
    name: config.teamName,
    seasonName: config.seasonName,
    leagueName: config.leagueName,
    timezone: config.timezone,
    youtubeChannelUrl: config.youtube.channelUrl,
  }
}

export function assertSnapshotIdentityMatchesConfig(
  snapshot: Pick<TeamSnapshotV3, "identity">,
  config: TeamConfig
): void {
  const expected = configuredIdentity(config)
  for (const identityField of Object.keys(expected) as Array<
    keyof typeof expected
  >) {
    if (snapshot.identity[identityField] !== expected[identityField]) {
      throw new Error(
        `Snapshot identity ${identityField} does not match config/team.json`
      )
    }
  }
}
