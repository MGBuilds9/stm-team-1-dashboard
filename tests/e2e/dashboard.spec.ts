import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

import type { GameRow, TeamSnapshot } from "../../src/data/types"

const snapshot = JSON.parse(
  fs.readFileSync(new URL("../../data/snapshot.json", import.meta.url), "utf8")
) as TeamSnapshot
const providerLabel =
  snapshot.identity.provider === "stm" ? "STM Sports" : "TeamLinkt"
const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const renderVideoActionScript = `
  import { renderToStaticMarkup } from "react-dom/server";
  import { GameVideoAction } from "./src/App.tsx";
  const game = JSON.parse(process.argv[1]);
  process.stdout.write(renderToStaticMarkup(GameVideoAction({ game })));
`

const views = [
  "overview",
  "schedule",
  "standings",
  "roster",
  "leaders",
  "team-stats",
  "box-scores",
] as const

function gameWithVideo(video: GameRow["video"]): GameRow {
  return {
    ...snapshot.games[0],
    id: `video-${video.state}`,
    opponentName: "Test Opponent",
    isHome: true,
    video,
  }
}

function renderVideoActionMarkup(game: GameRow): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      renderVideoActionScript,
      JSON.stringify(game),
    ],
    { cwd: projectRoot, encoding: "utf8" }
  )
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${viewport.name} ${theme}`, () => {
      for (const view of views) {
        test(`${view} renders without browser or accessibility errors`, async ({
          page,
        }) => {
          const errors: string[] = []
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text())
          })
          await page.setViewportSize(viewport)
          await page.addInitScript((selectedTheme) => {
            localStorage.setItem("basketball-dashboard-theme", selectedTheme)
          }, theme)
          await page.goto(`/#/${view}`)
          await expect(page.locator("h1")).toBeVisible()
          await expect(page.locator("html")).toHaveClass(theme)
          expect(errors).toEqual([])
          const results = await new AxeBuilder({ page })
            .disableRules(["color-contrast"])
            .analyze()
          expect(results.violations).toEqual([])
        })
      }
    })
  }
}

test("schedule publishes Wednesday games at 8 p.m. and never 10 p.m.", async ({
  page,
}) => {
  test.skip(snapshot.identity.provider !== "stm")
  await page.goto("/#/schedule")
  await expect(page.getByText("WED, JUL 29, 2026")).toBeVisible()
  await expect(
    page
      .locator("article", { hasText: "WED, JUL 29, 2026" })
      .getByText("8:00 p.m.")
  ).toBeVisible()
  await expect(page.getByText("10:00 p.m.")).toHaveCount(0)
})

test("mobile More sheet exposes all secondary views", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/#/overview")
  await page.getByRole("button", { name: "More" }).click()
  await expect(
    page.getByRole("heading", { name: `More ${snapshot.team.name} views` })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: "Leaders" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Team Stats" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Box Scores" })).toBeVisible()
})

test("game books include both teams and retain the official link", async ({
  page,
}) => {
  const boxScore = snapshot.boxScores[0]
  await page.goto(`/#/box-scores/${boxScore.gameId}`)
  await expect(page.getByRole("table")).toHaveCount(2)
  await expect(page.locator(".scoreboard-card")).toContainText(
    snapshot.team.name
  )
  const opponent =
    boxScore.home.teamId === snapshot.team.id ? boxScore.away : boxScore.home
  await expect(page.locator(".scoreboard-card")).toContainText(
    opponent.teamName
  )
  await expect(
    page.getByRole("link", { name: `Official ${providerLabel} game` })
  ).toHaveAttribute("href", boxScore.officialUrl)
})

test("verified uploads use the direct Watch game action", async ({ page }) => {
  const ready = gameWithVideo({
    state: "verified_exact",
    channelUrl: snapshot.identity.youtubeChannelUrl,
    videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
    videoTitle: "Semi-Uncs vs Test Opponent",
    matchedBy: "date_and_teams",
  })
  await page.setContent(renderVideoActionMarkup(ready))

  const action = page.getByRole("link", {
    name: `Watch ${snapshot.team.name} ${
      ready.isHome ? "versus" : "at"
    } ${ready.opponentName} on YouTube`,
  })
  await expect(action).toHaveAttribute("href", ready.video.videoUrl)
  await expect(action).toHaveAttribute("title", ready.video.videoTitle)
})

for (const [reason, visibleStatus, accessibleStatus] of [
  ["not_found", "Not uploaded yet", "No verified game video is uploaded yet"],
  [
    "ambiguous",
    "Upload needs review",
    "The possible game video match needs review",
  ],
  [
    "source_unavailable",
    "Upload status unavailable",
    "Game video availability could not be checked",
  ],
] as const) {
  test(`channel-only ${reason} is visibly and accessibly distinct`, async ({
    page,
  }) => {
    const pending = gameWithVideo({
      state: "channel_only",
      channelUrl: snapshot.identity.youtubeChannelUrl,
      reason,
    })
    await page.setContent(renderVideoActionMarkup(pending))

    await expect(page.getByText(visibleStatus)).toBeVisible()
    const action = page.getByRole("link", {
      name: `${accessibleStatus} for ${snapshot.team.name} versus Test Opponent; open the ${providerLabel} YouTube channel`,
    })
    await expect(action).toHaveAttribute("href", pending.video.channelUrl)
    await expect(action).toHaveClass(/video-pending-button/)
    await expect(page.getByRole("link", { name: /Watch game/i })).toHaveCount(0)
  })
}

for (const reason of ["bye", "canceled"] as const) {
  test(`video action is absent when ${reason} means no upload is expected`, async ({
    page,
  }) => {
    const game = gameWithVideo({ state: "not_expected", reason })
    await page.setContent(renderVideoActionMarkup(game))

    await expect(page.getByRole("link")).toHaveCount(0)
    await expect(page.locator("body")).toBeEmpty()
  })
}

test("schedule renders its V3 video actions", async ({ page }) => {
  await page.goto("/#/schedule")
  const exact = snapshot.games.find(
    (game) => game.video.state === "verified_exact"
  )
  if (exact) {
    await expect(
      page.getByRole("link", {
        name: `Watch ${snapshot.team.name} ${
          exact.isHome ? "versus" : "at"
        } ${exact.opponentName} on YouTube`,
      })
    ).toHaveAttribute("href", exact.video.videoUrl)
  }

  const channelOnly = snapshot.games.find(
    (game) => game.video.state === "channel_only"
  )
  if (channelOnly) {
    await expect(
      page
        .locator('[data-video-state="channel_only"]')
        .filter({ hasText: "Check channel" })
        .first()
    ).toBeVisible()
  }
})

test("hash navigation remains functional after the network goes offline", async ({
  context,
  page,
}) => {
  await page.goto("/#/overview")
  await context.setOffline(true)
  await page.getByRole("link", { name: "Schedule" }).first().click()
  await expect(page).toHaveURL(/#\/schedule$/)
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible()
})

test("reduced motion removes meaningful transition duration", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/#/overview")
  const duration = await page
    .locator("article")
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration)
  expect(["0s", "0.00001s", "1e-05s"]).toContain(duration)
})
