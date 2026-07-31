import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseTeamSnapshotV3 } from "@basketball-os/public-contracts"
import { afterEach, describe, expect, it } from "vitest"

import configJson from "../config/team.json"
import snapshotJson from "../data/snapshot.json"
import { readTeamConfig } from "../scripts/team-config"
import {
  assertSnapshotIdentityMatchesConfig,
  teamConfigSchema,
} from "../src/data/config"

const config = teamConfigSchema.parse(configJson)
const snapshot = parseTeamSnapshotV3(snapshotJson)
const temporaryDirectories: string[] = []

const mismatches = [
  ["provider", "teamlinkt"],
  ["leagueId", "different-league"],
  ["seasonId", "different-season"],
  ["teamId", "different-team"],
  ["name", "Different Team"],
  ["seasonName", "Different Season"],
  ["leagueName", "Different League"],
  ["timezone", "UTC"],
  ["youtubeChannelUrl", "https://www.youtube.com/@DifferentChannel"],
] as const

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("configured snapshot identity", () => {
  it("accepts the exact configured identity", () => {
    expect(() =>
      assertSnapshotIdentityMatchesConfig(snapshot, config)
    ).not.toThrow()
  })

  it.each(mismatches)("rejects a mismatched %s", (field, value) => {
    expect(() =>
      assertSnapshotIdentityMatchesConfig(
        {
          identity: {
            ...snapshot.identity,
            [field]: value,
          },
        },
        config
      )
    ).toThrow(`Snapshot identity ${field} does not match`)
  })
})

describe("team config input boundary", () => {
  it("reads a bounded regular config file", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "dashboard-config-")
    )
    temporaryDirectories.push(directory)
    const file = path.join(directory, "team.json")
    await fs.writeFile(file, JSON.stringify(configJson))

    await expect(readTeamConfig(file)).resolves.toEqual(config)
  })

  it("rejects symlinked and oversized config files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "dashboard-config-")
    )
    temporaryDirectories.push(directory)
    const target = path.join(directory, "target.json")
    const symlink = path.join(directory, "symlink.json")
    const oversized = path.join(directory, "oversized.json")
    await fs.writeFile(target, JSON.stringify(configJson))
    await fs.symlink(target, symlink)
    await fs.writeFile(oversized, " ".repeat(64 * 1024 + 1))

    await expect(readTeamConfig(symlink)).rejects.toThrow(/non-symlink/)
    await expect(readTeamConfig(oversized)).rejects.toThrow(/bounded/)
  })

  it.each([
    ["top-level", { ...configJson, teamNmae: configJson.teamName }],
    [
      "YouTube",
      {
        ...configJson,
        youtube: {
          ...configJson.youtube,
          channelURL: configJson.youtube.channelUrl,
        },
      },
    ],
    [
      "source",
      {
        ...configJson,
        source: { ...configJson.source, league: "mens-basketball" },
      },
    ],
    [
      "rules",
      {
        ...configJson,
        rules: { ...configJson.rules, wednesdayTime: "20:00" },
      },
    ],
  ])("rejects unknown %s config keys", (_scope, input) => {
    expect(() => teamConfigSchema.parse(input)).toThrow(/Unrecognized key/)
  })
})
