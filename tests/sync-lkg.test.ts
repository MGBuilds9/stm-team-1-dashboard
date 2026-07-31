import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import configJson from "../config/team.json"
import receiptJson from "../data/receipt.json"
import snapshotJson from "../data/snapshot.json"
import { readPreviousSnapshot } from "../scripts/sync"
import { teamConfigSchema } from "../src/data/config"

const config = teamConfigSchema.parse(configJson)
const temporaryDirectories: string[] = []

async function temporaryPair(
  input: {
    snapshot?: unknown | string
    receipt?: unknown | string
  } = {}
): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-lkg-"))
  temporaryDirectories.push(directory)
  const snapshotFile = path.join(directory, "snapshot.json")
  const write = async (file: string, value: unknown | string) =>
    fs.writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value)
    )
  if (input.snapshot !== undefined) {
    await write(snapshotFile, input.snapshot)
  }
  if (input.receipt !== undefined) {
    await write(path.join(directory, "receipt.json"), input.receipt)
  }
  return snapshotFile
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("sync last-known-good boundary", () => {
  it("treats only a fully absent pair as an empty first sync", async () => {
    await expect(
      readPreviousSnapshot(await temporaryPair(), config)
    ).resolves.toBeNull()
  })

  it("rejects a snapshot without its receipt before source collection", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({ snapshot: snapshotJson }),
        config
      )
    ).rejects.toThrow(/must exist together/)
  })

  it("rejects an orphan receipt before source collection", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({ receipt: receiptJson }),
        config
      )
    ).rejects.toThrow(/must exist together/)
  })

  it("rejects malformed snapshot or receipt JSON instead of overwriting it", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: "{not-json",
          receipt: receiptJson,
        }),
        config
      )
    ).rejects.toThrow()
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: snapshotJson,
          receipt: "{not-json",
        }),
        config
      )
    ).rejects.toThrow()
  })

  it("rejects a stale receipt instead of returning UNCHANGED", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: snapshotJson,
          receipt: {
            ...receiptJson,
            contentHash: "f".repeat(64),
          },
        }),
        config
      )
    ).rejects.toThrow(/contentHash does not match/)
  })

  it("requires an explicit V2 pair migration", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: { ...snapshotJson, schemaVersion: 2 },
          receipt: { ...receiptJson, schemaVersion: 2 },
        }),
        config
      )
    ).rejects.toThrow(/migrate:snapshot/)
  })

  it("rejects a valid pair from a different configured identity", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: snapshotJson,
          receipt: receiptJson,
        }),
        {
          ...config,
          teamId: "different-team",
        }
      )
    ).rejects.toThrow(/identity teamId does not match/)
  })

  it("reuses a coherent matching V3 pair", async () => {
    await expect(
      readPreviousSnapshot(
        await temporaryPair({
          snapshot: snapshotJson,
          receipt: receiptJson,
        }),
        config
      )
    ).resolves.toMatchObject({
      schemaVersion: 3,
      contentHash: snapshotJson.contentHash,
    })
  })
})
