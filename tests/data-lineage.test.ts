import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  teamSnapshotV2CompatibilitySchema,
  type TeamSnapshotV2Compatibility,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"
import { afterEach, describe, expect, it } from "vitest"

import configJson from "../config/team.json"
import receiptJson from "../data/receipt.json"
import snapshotJson from "../data/snapshot.json"
import {
  buildDataReceiptV3,
  dataSnapshotSemanticHash,
  verifyDataSnapshotV3,
} from "../scripts/data-receipt"
import { verifyGitDataLineage } from "../scripts/verify-data-lineage"

const execFileAsync = promisify(execFile)
const baseSnapshot = verifyDataSnapshotV3(snapshotJson)
const temporaryDirectories: string[] = []

interface TestWorkspace {
  root: string
  repository: string
  configFile: string
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function createWorkspace(): Promise<TestWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-lineage-"))
  temporaryDirectories.push(root)
  const repository = path.join(root, "data-source")
  const configDirectory = path.join(root, "config")
  const configFile = path.join(configDirectory, "team.json")
  await fs.mkdir(repository)
  await fs.mkdir(configDirectory)
  await writeJson(configFile, configJson)
  await git(repository, ["init", "--initial-branch=data"])
  await git(repository, ["config", "user.name", "lineage-test"])
  await git(repository, ["config", "user.email", "lineage@example.test"])
  return { root, repository, configFile }
}

async function replacePair(
  repository: string,
  snapshot?: unknown,
  receipt?: unknown
): Promise<void> {
  const snapshotFile = path.join(repository, "snapshot.json")
  const receiptFile = path.join(repository, "receipt.json")
  await Promise.all([
    fs.rm(snapshotFile, { force: true }),
    fs.rm(receiptFile, { force: true }),
  ])
  if (snapshot !== undefined) await writeJson(snapshotFile, snapshot)
  if (receipt !== undefined) await writeJson(receiptFile, receipt)
}

async function commitPair(
  repository: string,
  snapshot: unknown,
  receipt: unknown,
  message: string
): Promise<string> {
  await replacePair(repository, snapshot, receipt)
  await git(repository, ["add", "--all"])
  await git(repository, ["commit", "-m", message])
  return git(repository, ["rev-parse", "HEAD"])
}

function v2Snapshot(contentHash = "1".repeat(64)): TeamSnapshotV2Compatibility {
  return teamSnapshotV2CompatibilitySchema.parse({
    ...baseSnapshot,
    schemaVersion: 2,
    contentHash,
    games: baseSnapshot.games.map(({ video, ...game }) => ({
      ...game,
      videoUrl: video.state === "verified_exact" ? video.videoUrl : null,
      videoTitle: video.state === "verified_exact" ? video.videoTitle : null,
      ...(video.state === "verified_exact"
        ? {
            videoChannelUrl: video.channelUrl,
            videoMatchedBy: video.matchedBy,
          }
        : {}),
    })),
  })
}

function v2Receipt(snapshot: TeamSnapshotV2Compatibility) {
  return {
    schemaVersion: 2,
    generatedAt: snapshot.generatedAt,
    contentHash: snapshot.contentHash,
    previousHash: null,
    provider: snapshot.identity.provider,
    teamId: snapshot.identity.teamId,
    sourceCount: snapshot.sources.length,
    gameCount: snapshot.games.length,
    boxScoreCount: snapshot.boxScores.length,
    matchedVideoCount: snapshot.games.filter(
      (game) => game.videoUrl !== null && game.videoTitle !== null
    ).length,
  }
}

function changedV3Snapshot(): TeamSnapshotV3 {
  const changed = structuredClone(baseSnapshot)
  changed.capabilities.liveScores = !changed.capabilities.liveScores
  return verifyDataSnapshotV3({
    ...changed,
    contentHash: dataSnapshotSemanticHash(changed),
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("Git-backed data lineage", () => {
  it("accepts a valid V3 genesis commit with a null previous hash", async () => {
    const workspace = await createWorkspace()
    const receipt = buildDataReceiptV3(baseSnapshot, null)
    const revision = await commitPair(
      workspace.repository,
      baseSnapshot,
      receipt,
      "data genesis"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).resolves.toEqual({
      revision,
      parentRevision: null,
      contentHash: baseSnapshot.contentHash,
    })
  })

  it("accepts an exact V2 parent followed by a coherent V3 child", async () => {
    const workspace = await createWorkspace()
    const parent = v2Snapshot()
    const parentRevision = await commitPair(
      workspace.repository,
      parent,
      v2Receipt(parent),
      "V2 parent"
    )
    const childReceipt = buildDataReceiptV3(baseSnapshot, parent.contentHash)
    const revision = await commitPair(
      workspace.repository,
      baseSnapshot,
      childReceipt,
      "V3 migration"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).resolves.toEqual({
      revision,
      parentRevision,
      contentHash: baseSnapshot.contentHash,
    })
  })

  it("accepts a semantically verified V3 parent and child", async () => {
    const workspace = await createWorkspace()
    const parentRevision = await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, null),
      "V3 parent"
    )
    const child = changedV3Snapshot()
    const revision = await commitPair(
      workspace.repository,
      child,
      buildDataReceiptV3(child, baseSnapshot.contentHash),
      "V3 child"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).resolves.toEqual({
      revision,
      parentRevision,
      contentHash: child.contentHash,
    })
  })

  it("allows configured identity changes across an exact parent edge", async () => {
    const workspace = await createWorkspace()
    const previous = structuredClone(baseSnapshot)
    previous.identity.leagueName = "Former League Name"
    const parent = verifyDataSnapshotV3({
      ...previous,
      contentHash: dataSnapshotSemanticHash(previous),
    })
    const parentRevision = await commitPair(
      workspace.repository,
      parent,
      buildDataReceiptV3(parent, null),
      "previous team identity"
    )
    const revision = await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, parent.contentHash),
      "configured team identity"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).resolves.toEqual({
      revision,
      parentRevision,
      contentHash: baseSnapshot.contentHash,
    })
  })

  it("rejects an invented parent content hash", async () => {
    const workspace = await createWorkspace()
    const parent = v2Snapshot()
    await commitPair(
      workspace.repository,
      parent,
      v2Receipt(parent),
      "V2 parent"
    )
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, "f".repeat(64)),
      "invented lineage"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/previousHash does not match/)
  })

  it("rejects semantic tampering in the current V3 snapshot", async () => {
    const workspace = await createWorkspace()
    const tampered = structuredClone(baseSnapshot)
    tampered.capabilities.liveScores = !tampered.capabilities.liveScores
    await commitPair(
      workspace.repository,
      tampered,
      receiptJson,
      "tampered current snapshot"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/semantic content hash/)
  })

  it("rejects semantic tampering in a V3 parent", async () => {
    const workspace = await createWorkspace()
    const tamperedParent = structuredClone(baseSnapshot)
    tamperedParent.capabilities.liveScores =
      !tamperedParent.capabilities.liveScores
    await commitPair(
      workspace.repository,
      tamperedParent,
      receiptJson,
      "tampered V3 parent"
    )
    const child = changedV3Snapshot()
    await commitPair(
      workspace.repository,
      child,
      buildDataReceiptV3(child, tamperedParent.contentHash),
      "valid child"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/semantic content hash/)
  })

  it("strictly rejects a malformed V2 parent", async () => {
    const workspace = await createWorkspace()
    const parent = v2Snapshot()
    await commitPair(
      workspace.repository,
      { ...parent, injected: true },
      v2Receipt(parent),
      "malformed V2 parent"
    )
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, parent.contentHash),
      "V3 child"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/Unrecognized key/)
  })

  it("rejects a coherent pair for the wrong configured identity", async () => {
    const workspace = await createWorkspace()
    await writeJson(workspace.configFile, {
      ...configJson,
      teamId: "different-team",
    })
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, null),
      "wrong team"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/identity teamId does not match/)
  })

  it("rejects a commit with a missing receipt", async () => {
    const workspace = await createWorkspace()
    await replacePair(workspace.repository, baseSnapshot)
    await git(workspace.repository, ["add", "--all"])
    await git(workspace.repository, ["commit", "-m", "missing receipt"])

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/receipt\.json/)
  })

  it("rejects a commit with an orphan receipt", async () => {
    const workspace = await createWorkspace()
    await replacePair(
      workspace.repository,
      undefined,
      buildDataReceiptV3(baseSnapshot, null)
    )
    await git(workspace.repository, ["add", "--all"])
    await git(workspace.repository, ["commit", "-m", "orphan receipt"])

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/snapshot\.json/)
  })

  it("rejects a stale receipt", async () => {
    const workspace = await createWorkspace()
    await commitPair(
      workspace.repository,
      baseSnapshot,
      {
        ...buildDataReceiptV3(baseSnapshot, null),
        contentHash: "f".repeat(64),
      },
      "stale receipt"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/contentHash does not match/)
  })

  it("rejects a non-null previous hash on genesis", async () => {
    const workspace = await createWorkspace()
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, "f".repeat(64)),
      "invalid genesis"
    )

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/genesis.*previousHash/i)
  })

  it("rejects a merge at the data-branch head", async () => {
    const workspace = await createWorkspace()
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, null),
      "data genesis"
    )
    await git(workspace.repository, ["branch", "side"])
    await fs.writeFile(path.join(workspace.repository, "main-marker"), "main\n")
    await git(workspace.repository, ["add", "main-marker"])
    await git(workspace.repository, ["commit", "-m", "main side"])
    await git(workspace.repository, ["checkout", "side"])
    await fs.writeFile(path.join(workspace.repository, "side-marker"), "side\n")
    await git(workspace.repository, ["add", "side-marker"])
    await git(workspace.repository, ["commit", "-m", "branch side"])
    await git(workspace.repository, ["checkout", "data"])
    await git(workspace.repository, [
      "merge",
      "--no-ff",
      "side",
      "-m",
      "merge data histories",
    ])

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/non-linear|multiple parents|merge/i)
  })

  it("passes at depth two and fails closed at depth one", async () => {
    const workspace = await createWorkspace()
    const parent = v2Snapshot()
    await commitPair(
      workspace.repository,
      parent,
      v2Receipt(parent),
      "V2 parent"
    )
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, parent.contentHash),
      "V3 child"
    )
    const depthTwo = path.join(workspace.root, "depth-two")
    const depthOne = path.join(workspace.root, "depth-one")
    await git(workspace.root, [
      "clone",
      "--quiet",
      "--no-local",
      "--depth",
      "2",
      workspace.repository,
      depthTwo,
    ])
    await git(workspace.root, [
      "clone",
      "--quiet",
      "--no-local",
      "--depth",
      "1",
      workspace.repository,
      depthOne,
    ])

    await expect(
      verifyGitDataLineage({
        repository: depthTwo,
        configFile: workspace.configFile,
      })
    ).resolves.toMatchObject({
      contentHash: baseSnapshot.contentHash,
    })
    await expect(
      verifyGitDataLineage({
        repository: depthOne,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/parent commit.*unavailable|fetch depth 2/i)
  })

  it("rejects dirty snapshot or receipt worktree state", async () => {
    const workspace = await createWorkspace()
    await commitPair(
      workspace.repository,
      baseSnapshot,
      buildDataReceiptV3(baseSnapshot, null),
      "data genesis"
    )
    await fs.appendFile(path.join(workspace.repository, "receipt.json"), "\n")

    await expect(
      verifyGitDataLineage({
        repository: workspace.repository,
        configFile: workspace.configFile,
      })
    ).rejects.toThrow(/dirty/)
  })
})
