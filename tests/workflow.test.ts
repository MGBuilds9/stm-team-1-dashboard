import fs from "node:fs"

import { format } from "prettier"
import { describe, expect, it } from "vitest"

const ciWorkflow = fs.readFileSync(".github/workflows/ci.yml", "utf8")
const publishWorkflow = fs.readFileSync(".github/workflows/publish.yml", "utf8")
const syncWorkflow = fs.readFileSync(".github/workflows/sync.yml", "utf8")
const npmConfiguration = fs.readFileSync(".npmrc", "utf8")
const packageConfiguration = JSON.parse(
  fs.readFileSync("package.json", "utf8")
) as {
  scripts: Record<string, string>
}

function expectInOrder(workflow: string, markers: string[]): void {
  const positions = markers.map((marker) => {
    const position = workflow.indexOf(marker)
    expect(
      position,
      `Missing workflow marker: ${marker}`
    ).toBeGreaterThanOrEqual(0)
    return position
  })
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index - 1]).toBeLessThan(positions[index])
  }
}

describe("sync and exact-artifact publication workflow", () => {
  it("keeps all workflow files valid YAML", async () => {
    await expect(format(ciWorkflow, { parser: "yaml" })).resolves.toBeTypeOf(
      "string"
    )
    await expect(format(syncWorkflow, { parser: "yaml" })).resolves.toBeTypeOf(
      "string"
    )
    await expect(
      format(publishWorkflow, { parser: "yaml" })
    ).resolves.toBeTypeOf("string")
  })

  it("never runs dependency lifecycle scripts before vendor verification", () => {
    expect(npmConfiguration.trim()).toBe("ignore-scripts=true")
    for (const workflow of [ciWorkflow, publishWorkflow, syncWorkflow]) {
      expect(workflow).not.toMatch(/run:\s+npm ci\s*$/m)
      for (const install of workflow.matchAll(/run:\s+(npm ci[^\n]*)/g)) {
        expect(install[1]).toContain("--ignore-scripts")
      }
    }
  })

  it("uses the shared vendor-gated data-lineage verifier", () => {
    expect(packageConfiguration.scripts["verify:data-lineage"]).toBe(
      "npm run verify:vendor && tsx scripts/verify-data-lineage.ts"
    )
  })

  it("verifies depth-two data checkouts before copying, probing, or building", () => {
    for (const workflow of [ciWorkflow, publishWorkflow, syncWorkflow]) {
      expect(
        workflow.match(/path: data-source\n\s+fetch-depth: 2/g)
      ).toHaveLength(1)
    }

    expectInOrder(ciWorkflow, [
      "Check out latest validated data",
      "Install dependencies",
      "Verify checked-out data lineage",
      "Prepare validated snapshot",
      "Verify application",
    ])
    expectInOrder(syncWorkflow, [
      "Check out last-known-good data",
      "Install dependencies",
      "Verify last-known-good data lineage",
      "Restore last-known-good snapshot",
      "Probe and validate configured league",
    ])
    expectInOrder(publishWorkflow, [
      "Check out latest validated data",
      "Install dependencies",
      "Verify exact data lineage",
      "Prepare verified snapshot",
      "Run the complete release gate",
    ])

    expect(
      ciWorkflow.match(/npm run verify:data-lineage -- data-source/g)
    ).toHaveLength(1)
    expect(
      publishWorkflow.match(/npm run verify:data-lineage -- data-source/g)
    ).toHaveLength(1)
  })

  it("verifies a new data commit before the sync workflow pushes it", () => {
    expectInOrder(syncWorkflow, [
      "Commit one validated snapshot revision",
      "Verify new data lineage before push",
      "Push verified data revision",
      "Reconcile the expected release with live Pages",
    ])
    expect(
      syncWorkflow.match(/npm run verify:data-lineage -- data-source/g)
    ).toHaveLength(2)
    const commitStart = syncWorkflow.indexOf(
      "Commit one validated snapshot revision"
    )
    const verifyStart = syncWorkflow.indexOf(
      "Verify new data lineage before push"
    )
    expect(syncWorkflow.slice(commitStart, verifyStart)).not.toContain(
      "git push"
    )
  })

  it("serializes data sync runs without canceling an in-flight update", () => {
    expect(syncWorkflow).toContain(
      "group: basketball-data-sync-${{ github.repository }}"
    )
    expect(syncWorkflow).toContain("cancel-in-progress: false")
  })

  it("reconciles the exact code, data, and snapshot revisions against live Pages", () => {
    expect(syncWorkflow).toContain("publish_required:")
    expect(syncWorkflow).toContain("release.json")
    expect(syncWorkflow).toContain("release-manifest.ts matches")
    expect(syncWorkflow).toContain("connect-timeout 5")
    expect(syncWorkflow).toContain("max-time 20")
    expect(syncWorkflow).toContain("max-filesize 65536")
    expect(syncWorkflow).toContain("git rev-parse HEAD")
    expect(syncWorkflow).toContain("git -C data-source rev-parse HEAD")
    expect(syncWorkflow).toContain(
      'require("./data/snapshot.json").contentHash'
    )
    expect(syncWorkflow).toContain("run_id=${GITHUB_RUN_ID}")
    expect(syncWorkflow).toContain('echo "publish_required=false"')
    expect(syncWorkflow).toContain('echo "publish_required=true"')
  })

  it("publishes on a live mismatch even when source content is unchanged", () => {
    expect(syncWorkflow).toContain(
      '[[ "$CHANGED" == "true" || "$live_matches" != "true" ]]'
    )
    expect(syncWorkflow).toContain(
      "needs.sync.outputs.publish_required == 'true'"
    )
    expect(syncWorkflow).not.toContain(
      "if: needs.sync.outputs.changed == 'true'"
    )
  })

  it("only accepts a skipped publish when reconciliation said it was unnecessary", () => {
    expect(syncWorkflow).toContain(
      "PUBLISH_REQUIRED: ${{ needs.sync.outputs.publish_required }}"
    )
    expect(syncWorkflow).toContain('? publishResult !== "success"')
    expect(syncWorkflow).toContain(
      '!["success", "skipped"].includes(publishResult)'
    )
  })

  it("always re-fetches with the one bounded manifest verifier before closing an issue", () => {
    expect(syncWorkflow).toContain("Prove the expected release is live")
    expect(syncWorkflow).toContain(
      "LIVE_RELEASE_MATCHES: ${{ steps.live.outputs.matches }}"
    )
    expect(syncWorkflow.match(/release-manifest\.ts matches/g)).toHaveLength(2)
    expect(syncWorkflow.match(/--max-filesize 65536/g)).toHaveLength(2)
    expect(syncWorkflow).not.toContain("--location")
    expect(syncWorkflow).not.toContain("fetch(")
    expect(syncWorkflow).not.toContain('core.setOutput("matches", "true")')
    expect(syncWorkflow).toContain(
      '[[ "$PUBLISH_REQUIRED" == "true" && "$PUBLISH_RESULT" == "success" ]]'
    )
    expect(syncWorkflow).toContain("max_attempts=6")
    expect(syncWorkflow).toContain(
      "Open, update, or close the sanitized sync issue\n        if: always()"
    )
    expect(syncWorkflow).toContain("!liveReleaseMatches")
  })

  it("pins both expected revisions through the reusable publisher", () => {
    expect(syncWorkflow).toContain(
      "expected_code_revision: ${{ needs.sync.outputs.code_revision }}"
    )
    expect(syncWorkflow).toContain(
      "expected_data_revision: ${{ needs.sync.outputs.data_revision }}"
    )
    expect(publishWorkflow).toContain("expected_code_revision:")
    expect(publishWorkflow).toContain(
      "EXPECTED_CODE_REVISION: ${{ inputs.expected_code_revision }}"
    )
    expect(publishWorkflow).toContain(
      '"$code_revision" != "$EXPECTED_CODE_REVISION"'
    )
    expect(publishWorkflow).toContain(
      "Expected code and data revisions must be provided together."
    )
  })
})
