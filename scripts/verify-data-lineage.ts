import { execFile } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import {
  teamSnapshotV2CompatibilitySchema,
  type TeamSnapshotV2Compatibility,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"

import { assertSnapshotIdentityMatchesConfig } from "../src/data/config"
import { validateDataPairV3, verifyDataSnapshotV3 } from "./data-receipt"
import { readTeamConfig } from "./team-config"

const execFileAsync = promisify(execFile)
const COMMIT_OUTPUT_LIMIT = 64 * 1024
const GIT_STATUS_OUTPUT_LIMIT = 16 * 1024
const RECEIPT_OUTPUT_LIMIT = 64 * 1024
const SNAPSHOT_OUTPUT_LIMIT = 3 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const commitIdPattern = /^[a-f0-9]{40}$/

export interface VerifyGitDataLineageInput {
  repository: string
  configFile: string
  revision?: string
}

export interface VerifiedGitDataLineage {
  revision: string
  parentRevision: string | null
  contentHash: string
}

async function git(
  repository: string,
  args: string[],
  maximumBytes: number
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: maximumBytes,
    timeout: GIT_TIMEOUT_MS,
  })
  return stdout
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function resolveCommit(
  repository: string,
  revision: string
): Promise<string> {
  const output = (
    await git(
      repository,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      COMMIT_OUTPUT_LIMIT
    )
  ).trim()
  if (!commitIdPattern.test(output)) {
    throw new Error(`Git revision did not resolve to one commit: ${revision}`)
  }
  return output
}

async function assertDataWorktreeClean(repository: string): Promise<void> {
  const status = await git(
    repository,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      "snapshot.json",
      "receipt.json",
    ],
    GIT_STATUS_OUTPUT_LIMIT
  )
  if (status.trim()) {
    throw new Error(
      "Data repository has dirty snapshot.json or receipt.json worktree state"
    )
  }
}

async function readCommit(
  repository: string,
  revision: string
): Promise<string> {
  return git(repository, ["cat-file", "commit", revision], COMMIT_OUTPUT_LIMIT)
}

function commitParents(rawCommit: string): string[] {
  const headerEnd = rawCommit.indexOf("\n\n")
  if (headerEnd < 0) throw new Error("Git commit object has no bounded header")
  const parents: string[] = []
  for (const line of rawCommit.slice(0, headerEnd).split("\n")) {
    if (!line.startsWith("parent ")) continue
    const parent = line.slice("parent ".length)
    if (!commitIdPattern.test(parent)) {
      throw new Error("Git commit object contains an invalid parent")
    }
    parents.push(parent)
  }
  return parents
}

async function readBlob(
  repository: string,
  revision: string,
  file: "snapshot.json" | "receipt.json",
  maximumBytes: number
): Promise<string> {
  try {
    return await git(
      repository,
      ["cat-file", "blob", `${revision}:${file}`],
      maximumBytes
    )
  } catch (error) {
    throw new Error(
      `Git data revision ${revision} cannot provide bounded ${file}: ${errorMessage(error)}`,
      { cause: error }
    )
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

function validateParentSnapshot(
  input: unknown
): TeamSnapshotV2Compatibility | TeamSnapshotV3 {
  if (input !== null && typeof input === "object" && "schemaVersion" in input) {
    if (input.schemaVersion === 3) return verifyDataSnapshotV3(input)
    if (input.schemaVersion === 2) {
      return teamSnapshotV2CompatibilitySchema.parse(input)
    }
  }
  throw new Error("Parent snapshot must be strict TeamSnapshot V2 or V3")
}

export async function verifyGitDataLineage(
  input: VerifyGitDataLineageInput
): Promise<VerifiedGitDataLineage> {
  const repository = path.resolve(input.repository)
  const revision = await resolveCommit(repository, input.revision ?? "HEAD")
  await assertDataWorktreeClean(repository)

  const [rawCommit, snapshotText, receiptText, config] = await Promise.all([
    readCommit(repository, revision),
    readBlob(repository, revision, "snapshot.json", SNAPSHOT_OUTPUT_LIMIT),
    readBlob(repository, revision, "receipt.json", RECEIPT_OUTPUT_LIMIT),
    readTeamConfig(path.resolve(input.configFile)),
  ])
  const pair = validateDataPairV3(
    parseJson(snapshotText, "snapshot.json"),
    parseJson(receiptText, "receipt.json")
  )
  assertSnapshotIdentityMatchesConfig(pair.snapshot, config)

  const parents = commitParents(rawCommit)
  if (parents.length > 1) {
    throw new Error(
      "Data history is non-linear: the current commit has multiple parents"
    )
  }
  if (parents.length === 0) {
    if (pair.receipt.previousHash !== null) {
      throw new Error("Data genesis must have receipt.previousHash set to null")
    }
    return {
      revision,
      parentRevision: null,
      contentHash: pair.snapshot.contentHash,
    }
  }

  const parentRevision = parents[0]
  let parentText: string
  try {
    parentText = await readBlob(
      repository,
      parentRevision,
      "snapshot.json",
      SNAPSHOT_OUTPUT_LIMIT
    )
  } catch (error) {
    throw new Error(
      `Parent commit ${parentRevision} is unavailable; fetch depth 2 is required: ${errorMessage(error)}`,
      { cause: error }
    )
  }
  const parent = validateParentSnapshot(
    parseJson(parentText, "parent snapshot.json")
  )
  if (pair.receipt.previousHash !== parent.contentHash) {
    throw new Error(
      "receipt.json previousHash does not match the exact parent snapshot.json content hash"
    )
  }
  return {
    revision,
    parentRevision,
    contentHash: pair.snapshot.contentHash,
  }
}

async function main(): Promise<void> {
  const [
    repository = "data-source",
    configFile = "config/team.json",
    revision = "HEAD",
  ] = process.argv.slice(2)
  const verified = await verifyGitDataLineage({
    repository,
    configFile,
    revision,
  })
  process.stdout.write(
    `VERIFIED ${verified.revision} ${verified.contentHash}\n`
  )
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
