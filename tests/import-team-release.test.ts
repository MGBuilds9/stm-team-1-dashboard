import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  canonicalJson,
  parseTeamSnapshotV3,
  type TeamSnapshotV3,
} from "@basketball-os/public-contracts"
import {
  buildAndSignTeamRelease,
  computeTeamReleaseDigest,
  computeTeamSnapshotContentHash,
  computeTeamSnapshotSourceSetHash,
  type SignedTeamRelease,
  type TeamReleaseAudience,
} from "@basketball-os/team-release"
import { afterEach, describe, expect, it } from "vitest"

import {
  importTeamRelease,
  type ImportTeamReleaseOptions,
} from "../scripts/import-team-release"

const issuedAt = "2026-07-31T02:30:00.000Z"
const now = "2026-07-31T02:31:00.000Z"
const teamId = "0dce2102-2b06-4750-b25d-8cbdba23d2c5"
const channelUrl = "https://www.youtube.com/@STMSports-t3z"
const keyId = "stm-release-test-01"
const derivedNames = [
  "team-release.json",
  "snapshot.json",
  "release-receipt.json",
] as const
const temporaryRoots: string[] = []

interface Harness {
  root: string
  outputDirectory: string
  teamConfigPath: string
  trustConfigPath: string
  candidatePath: string
  privateKey: KeyObject
  publicKeyPem: string
}

interface SignOptions {
  snapshot?: TeamSnapshotV3
  sequence?: number
  previousReleaseDigest?: string | null
  releaseId?: string
  audience?: TeamReleaseAudience
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

function snapshotWith(
  video:
    | {
        state: "verified_exact"
        channelUrl: string
        videoUrl: string
        videoTitle: string
        matchedBy:
          "date_and_teams" | "verified_override" | "previously_verified"
      }
    | {
        state: "channel_only"
        channelUrl: string
        reason: "not_found"
      } = {
    state: "verified_exact",
    channelUrl,
    videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
    videoTitle: "Semi-Uncs vs Team 2 — July 29 2026",
    matchedBy: "date_and_teams",
  },
  identityOverrides: Partial<TeamSnapshotV3["identity"]> = {}
): TeamSnapshotV3 {
  const resolvedTeamId = identityOverrides.teamId ?? teamId
  const raw = {
    schemaVersion: 3,
    generatedAt: "2026-07-31T02:29:00.000Z",
    contentHash: "0".repeat(64),
    identity: {
      provider: "stm",
      leagueId: "mens-basketball",
      seasonId: "summer-2026",
      teamId: resolvedTeamId,
      name: "Semi-Uncs",
      seasonName: "Summer 2026",
      leagueName: "STM Basketball",
      timezone: "America/Toronto",
      youtubeChannelUrl: channelUrl,
      ...identityOverrides,
    },
    capabilities: {
      roster: true,
      standings: "official",
      leagueLeaders: "official",
      boxScores: true,
      liveScores: false,
      gameVideos: true,
    },
    team: {
      id: resolvedTeamId,
      name: identityOverrides.name ?? "Semi-Uncs",
      season: "Summer 2026",
      wins: 1,
      losses: 0,
      pointsFor: 72,
      pointsAgainst: 64,
      differential: 8,
      standing: 1,
    },
    roster: [],
    games: [
      {
        id: "game-final",
        date: "2026-07-29",
        scheduledAt: "2026-07-29T20:00:00",
        displayTime: "20:00",
        state: "final",
        opponentId: "team-2",
        opponentName: "Team 2",
        venue: "VMSA Gym",
        isHome: true,
        teamScore: 72,
        opponentScore: 64,
        result: "W",
        officialUrl: "https://stmsports.ca/mens-basketball/game/game-final",
        hasBoxScore: false,
        video,
      },
    ],
    standings: [
      {
        rank: 1,
        teamId: resolvedTeamId,
        teamName: identityOverrides.name ?? "Semi-Uncs",
        wins: 1,
        losses: 0,
        gamesPlayed: 1,
        winPct: 1,
        pointsFor: 72,
        pointsAgainst: 64,
        differential: 8,
        streak: "W1",
        form: ["W"],
      },
    ],
    teamLeaders: [],
    leagueLeaders: [],
    teamStats: {
      gamesWithBoxScores: 0,
      pointsPerGame: 0,
      reboundsPerGame: 0,
      assistsPerGame: 0,
      stealsPerGame: 0,
      blocksPerGame: 0,
      fieldGoalPct: null,
      threePointPct: null,
      freeThrowPct: null,
    },
    boxScores: [],
    sources: [
      {
        label: "Team",
        url: `https://stmsports.ca/mens-basketball/teams/${resolvedTeamId}`,
        hash: "a".repeat(64),
        checkedAt: "2026-07-31T02:28:00.000Z",
      },
    ],
  }
  raw.contentHash = computeTeamSnapshotContentHash(
    raw as unknown as TeamSnapshotV3
  )
  return parseTeamSnapshotV3(raw)
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "team-release-import-"))
  temporaryRoots.push(root)
  const outputDirectory = path.join(root, "data")
  const teamConfigPath = path.join(root, "team.json")
  const trustConfigPath = path.join(root, "release-trust.json")
  const candidatePath = path.join(root, "candidate-release.json")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
  await fs.writeFile(
    teamConfigPath,
    JSON.stringify({
      provider: "stm",
      projectSlug: "stm-team-1-dashboard",
      leagueId: "mens-basketball",
      seasonId: "summer-2026",
      teamId,
      teamName: "Semi-Uncs",
      sourceTeamName: "Team 1",
      seasonName: "Summer 2026",
      leagueName: "STM Men’s Basketball",
      timezone: "America/Toronto",
      active: true,
      manualCloseoutAt: null,
      youtube: {
        channelUrl,
        teamAliases: ["Team 1", "Semi-Uncs"],
      },
      source: { leaguePath: "mens-basketball" },
      rules: { wednesdayStartTime: "20:00" },
    })
  )
  await writeTrustConfig(trustConfigPath, publicKeyPem)
  return {
    root,
    outputDirectory,
    teamConfigPath,
    trustConfigPath,
    candidatePath,
    privateKey,
    publicKeyPem,
  }
}

async function writeTrustConfig(
  trustConfigPath: string,
  publicKeyPem: string,
  overrides: {
    audiences?: TeamReleaseAudience[]
  } = {}
): Promise<void> {
  await fs.writeFile(
    trustConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      contract: "basketball-team-dashboard.release-trust.v1",
      keys: [
        {
          keyId,
          algorithm: "Ed25519",
          publicKeyPem,
          status: "active",
          audiences: overrides.audiences ?? ["public", "team"],
          identity: {
            providerId: "stm",
            leagueId: "mens-basketball",
            seasonId: "summer-2026",
            teamId,
          },
          validFrom: "2026-07-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      ],
    })
  )
}

function signRelease(
  harness: Harness,
  options: SignOptions = {}
): SignedTeamRelease {
  const snapshot = options.snapshot ?? snapshotWith()
  const sequence = options.sequence ?? 1
  return buildAndSignTeamRelease(
    {
      snapshot,
      releaseId:
        options.releaseId ??
        `stm-semi-uncs-${String(sequence).padStart(4, "0")}`,
      sequence,
      previousReleaseDigest: options.previousReleaseDigest ?? null,
      audience: options.audience ?? "public",
      signerKeyId: keyId,
      codeRevision: `code-${sequence}`,
      dataRevision: `data-${sequence}`,
      sourceSetHash: computeTeamSnapshotSourceSetHash(snapshot),
      verificationHash: `sha256:${"c".repeat(64)}`,
      compilerVersion: "0.1.0",
      issuedAt,
    },
    harness.privateKey
  )
}

async function writeCandidate(
  harness: Harness,
  release: SignedTeamRelease,
  destination = harness.candidatePath
): Promise<string> {
  await fs.writeFile(destination, canonicalJson(release))
  return destination
}

function options(
  harness: Harness,
  bundlePath = harness.candidatePath
): ImportTeamReleaseOptions {
  return {
    bundlePath,
    outputDirectory: harness.outputDirectory,
    teamConfigPath: harness.teamConfigPath,
    trustConfigPath: harness.trustConfigPath,
    now,
  }
}

async function importFirst(harness: Harness): Promise<SignedTeamRelease> {
  const release = signRelease(harness)
  await writeCandidate(harness, release)
  await expect(importTeamRelease(options(harness))).resolves.toMatchObject({
    state: "imported",
    receipt: { sequence: 1 },
  })
  return release
}

async function readDerived(
  harness: Harness
): Promise<Record<(typeof derivedNames)[number], Buffer | null>> {
  return Object.fromEntries(
    await Promise.all(
      derivedNames.map(async (name) => {
        try {
          return [
            name,
            await fs.readFile(path.join(harness.outputDirectory, name)),
          ]
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [name, null]
          }
          throw error
        }
      })
    )
  ) as Record<(typeof derivedNames)[number], Buffer | null>
}

async function expectFailurePreserves(
  harness: Harness,
  action: () => Promise<unknown>,
  message?: string | RegExp
): Promise<void> {
  const before = await readDerived(harness)
  const expectation = expect(action()).rejects
  if (message === undefined) {
    await expectation.toThrow()
  } else {
    await expectation.toThrow(message)
  }
  expect(await readDerived(harness)).toEqual(before)
}

function tamperSignature(release: SignedTeamRelease): SignedTeamRelease {
  const tampered = structuredClone(release)
  tampered.envelope.signatures[0].sig = Buffer.alloc(64, 7).toString("base64")
  return tampered
}

describe("signed team-release importer", () => {
  it("imports a valid genesis release as exact canonical LKG bytes", async () => {
    const harness = await makeHarness()
    const release = signRelease(harness)
    const candidateBytes = Buffer.from(canonicalJson(release))
    await writeCandidate(harness, release)

    const result = await importTeamRelease(options(harness))

    expect(result).toMatchObject({
      state: "imported",
      receipt: {
        sequence: 1,
        previousReleaseDigest: null,
        releaseDigest: computeTeamReleaseDigest(release),
        bundleSha256: createHash("sha256").update(candidateBytes).digest("hex"),
      },
    })
    const derived = await readDerived(harness)
    expect(derived["team-release.json"]).toEqual(candidateBytes)
    expect(derived["snapshot.json"]?.toString("utf8")).toBe(
      canonicalJson(snapshotWith())
    )
  })

  it("re-imports the exact stored release idempotently without rewriting LKG", async () => {
    const harness = await makeHarness()
    await importFirst(harness)
    const before = await readDerived(harness)

    await expect(importTeamRelease(options(harness))).resolves.toMatchObject({
      state: "unchanged",
      receipt: { sequence: 1 },
    })

    expect(await readDerived(harness)).toEqual(before)
    expect(before["team-release.json"]).toEqual(
      await fs.readFile(harness.candidatePath)
    )
  })

  it("rejects an idempotent candidate when stored team-release bytes drift", async () => {
    const harness = await makeHarness()
    await importFirst(harness)
    const storedPath = path.join(harness.outputDirectory, "team-release.json")
    await fs.writeFile(storedPath, canonicalJson({ corrupted: true }))

    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness)),
      /drift/
    )
  })

  it("rejects a tampered signature without changing LKG", async () => {
    const harness = await makeHarness()
    const first = await importFirst(harness)
    await writeCandidate(harness, tamperSignature(first))

    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness)),
      /signature/i
    )
  })

  it("rejects wrong identity, key scope, and audience without changing LKG", async () => {
    const wrongIdentityHarness = await makeHarness()
    const first = await importFirst(wrongIdentityHarness)
    const wrongIdentity = snapshotWith(undefined, {
      teamId: "other-team",
    })
    await writeCandidate(
      wrongIdentityHarness,
      signRelease(wrongIdentityHarness, {
        snapshot: wrongIdentity,
        sequence: 2,
        previousReleaseDigest: computeTeamReleaseDigest(first),
      })
    )
    await expectFailurePreserves(
      wrongIdentityHarness,
      () => importTeamRelease(options(wrongIdentityHarness)),
      /identity/i
    )

    const wrongScopeHarness = await makeHarness()
    const scopedFirst = await importFirst(wrongScopeHarness)
    await writeTrustConfig(
      wrongScopeHarness.trustConfigPath,
      wrongScopeHarness.publicKeyPem,
      { audiences: ["team"] }
    )
    await writeCandidate(
      wrongScopeHarness,
      signRelease(wrongScopeHarness, {
        sequence: 2,
        previousReleaseDigest: computeTeamReleaseDigest(scopedFirst),
      })
    )
    await expectFailurePreserves(
      wrongScopeHarness,
      () => importTeamRelease(options(wrongScopeHarness)),
      /not trusted/i
    )

    const wrongAudienceHarness = await makeHarness()
    const audienceFirst = await importFirst(wrongAudienceHarness)
    await writeCandidate(
      wrongAudienceHarness,
      signRelease(wrongAudienceHarness, {
        audience: "team",
        sequence: 2,
        previousReleaseDigest: computeTeamReleaseDigest(audienceFirst),
      })
    )
    await expectFailurePreserves(
      wrongAudienceHarness,
      () => importTeamRelease(options(wrongAudienceHarness)),
      /public-audience/
    )
  })

  it("rejects rollback and chain-break releases without changing LKG", async () => {
    const harness = await makeHarness()
    await importFirst(harness)
    await writeCandidate(
      harness,
      signRelease(harness, {
        releaseId: "stm-semi-uncs-rollback",
      })
    )
    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness)),
      /trusted head/i
    )

    await writeCandidate(
      harness,
      signRelease(harness, {
        sequence: 2,
        previousReleaseDigest: `sha256:${"f".repeat(64)}`,
      })
    )
    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness)),
      /trusted head/i
    )
  })

  it("rejects symlink and irregular candidate inputs without changing LKG", async () => {
    const harness = await makeHarness()
    const first = await importFirst(harness)
    const nextPath = path.join(harness.root, "next-release.json")
    await writeCandidate(
      harness,
      signRelease(harness, {
        sequence: 2,
        previousReleaseDigest: computeTeamReleaseDigest(first),
      }),
      nextPath
    )
    const symlinkPath = path.join(harness.root, "candidate-symlink.json")
    await fs.symlink(nextPath, symlinkPath)
    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness, symlinkPath)),
      /regular non-symlink file/
    )

    const irregularPath = path.join(harness.root, "candidate-directory")
    await fs.mkdir(irregularPath)
    await expectFailurePreserves(
      harness,
      () => importTeamRelease(options(harness, irregularPath)),
      /regular non-symlink file/
    )
  })

  it("requires review for exact-video removal and replacement without changing LKG", async () => {
    const harness = await makeHarness()
    const first = await importFirst(harness)
    const previousReleaseDigest = computeTeamReleaseDigest(first)
    const candidates = [
      snapshotWith({
        state: "channel_only",
        channelUrl,
        reason: "not_found",
      }),
      snapshotWith({
        state: "verified_exact",
        channelUrl,
        videoUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        videoTitle: "Replacement upload",
        matchedBy: "verified_override",
      }),
    ]

    for (const snapshot of candidates) {
      await writeCandidate(
        harness,
        signRelease(harness, {
          snapshot,
          sequence: 2,
          previousReleaseDigest,
        })
      )
      await expectFailurePreserves(
        harness,
        () => importTeamRelease(options(harness)),
        /VIDEO_REVIEW_REQUIRED: game-final/
      )
    }
  })

  it("fails closed on every corrupt existing derived file without repairing it", async () => {
    for (const name of derivedNames) {
      const harness = await makeHarness()
      const first = await importFirst(harness)
      const derivedPath = path.join(harness.outputDirectory, name)
      if (name === "snapshot.json") {
        const driftedSnapshot = JSON.parse(
          await fs.readFile(derivedPath, "utf8")
        ) as TeamSnapshotV3
        driftedSnapshot.generatedAt = "2026-07-31T02:29:01.000Z"
        await fs.writeFile(derivedPath, canonicalJson(driftedSnapshot))
      } else {
        await fs.writeFile(derivedPath, canonicalJson({ corrupted: name }))
      }
      await writeCandidate(
        harness,
        signRelease(harness, {
          sequence: 2,
          previousReleaseDigest: computeTeamReleaseDigest(first),
        })
      )

      await expectFailurePreserves(harness, () =>
        importTeamRelease(options(harness))
      )
    }
  })
})
