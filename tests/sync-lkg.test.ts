import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import snapshotJson from "../data/snapshot.json"
import { readPreviousSnapshot } from "../scripts/sync"
import configJson from "../config/team.json"
import { teamConfigSchema } from "@/data/config"

const config = teamConfigSchema.parse(configJson)
const temporaryDirectories: string[] = []

async function temporaryFile(value?: unknown): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-lkg-"))
  temporaryDirectories.push(directory)
  const file = path.join(directory, "snapshot.json")
  if (value !== undefined) {
    await fs.writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value)
    )
  }
  return file
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("sync last-known-good boundary", () => {
  it("treats only a missing snapshot as an empty first sync", async () => {
    await expect(
      readPreviousSnapshot(await temporaryFile(), config)
    ).resolves.toBeNull()
  })

  it("rejects corrupt snapshot JSON instead of overwriting it", async () => {
    await expect(
      readPreviousSnapshot(await temporaryFile("{not-json"), config)
    ).rejects.toThrow()
  })

  it("requires an explicit V2 migration", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryFile({ ...snapshotJson, schemaVersion: 2 }),
        config
      )
    ).rejects.toThrow(/migrate:snapshot/)
  })

  it("rejects a valid snapshot from a different configured identity", async () => {
    await expect(
      readPreviousSnapshot(await temporaryFile(snapshotJson), {
        ...config,
        teamId: "different-team",
      })
    ).rejects.toThrow(/identity does not match/)
  })

  it("reuses a valid matching V3 snapshot", async () => {
    await expect(
      readPreviousSnapshot(await temporaryFile(snapshotJson), config)
    ).resolves.toMatchObject({
      schemaVersion: 3,
      contentHash: snapshotJson.contentHash,
    })
  })
})
