import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import App, { GameVideoAction } from "@/App"
import { ThemeProvider } from "@/components/theme-provider"
import snapshotJson from "../data/snapshot.json"
import type { GameRow, TeamSnapshot } from "@/data/types"

const snapshot = snapshotJson as TeamSnapshot
const providerLabel =
  snapshot.identity.provider === "stm" ? "STM Sports" : "TeamLinkt"

function renderApp(hash: string) {
  window.location.hash = hash
  return render(
    <ThemeProvider defaultTheme="dark" storageKey="test-theme">
      <App />
    </ThemeProvider>
  )
}

function gameWithVideo(video: GameRow["video"]): GameRow {
  return {
    ...snapshot.games[0],
    id: `video-${video.state}`,
    opponentName: "Test Opponent",
    isHome: true,
    video,
  }
}

describe("selected-team interface", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.location.hash = ""
  })

  it("renders the operational overview from the current schedule", () => {
    renderApp("#/overview")
    expect(
      screen.getByRole("heading", {
        name: new RegExp(
          `${snapshot.team.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Command Center`
        ),
      })
    ).toBeInTheDocument()
    const nextGame = snapshot.games.find((game) =>
      ["scheduled", "rescheduled", "tbd"].includes(game.state)
    )
    if (nextGame) {
      const dateLabel = new Intl.DateTimeFormat("en-CA", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${nextGame.date}T12:00:00Z`))
      expect(screen.getByText(dateLabel)).toBeInTheDocument()
      if (
        snapshot.identity.provider === "stm" &&
        new Date(`${nextGame.date}T12:00:00Z`).getUTCDay() === 3
      ) {
        expect(nextGame.displayTime).toBe("20:00")
        expect(screen.getByText("8:00 p.m.")).toBeInTheDocument()
      }
    }
  })

  it("uses the verified direct game video as the primary action", () => {
    const ready = gameWithVideo({
      state: "verified_exact",
      channelUrl: snapshot.identity.youtubeChannelUrl,
      videoUrl: "https://www.youtube.com/watch?v=6mEdC0PTWgA",
      videoTitle: "Semi-Uncs vs Test Opponent",
      matchedBy: "date_and_teams",
    })
    render(<GameVideoAction game={ready} />)

    expect(
      screen.getByRole("link", {
        name: `Watch ${snapshot.team.name} ${
          ready.isHome ? "versus" : "at"
        } ${ready.opponentName} on YouTube`,
      })
    )
      .toHaveAttribute("href", ready.video.videoUrl)
      .toHaveAttribute("title", ready.video.videoTitle)
    expect(screen.getByRole("link", { name: /Watch/ })).toHaveClass(
      "video-ready-button"
    )
  })

  it.each([
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
  ] as const)(
    "renders the %s channel-only state as a reason-aware pending action",
    (reason, visibleStatus, accessibleStatus) => {
      const pending = gameWithVideo({
        state: "channel_only",
        channelUrl: snapshot.identity.youtubeChannelUrl,
        reason,
      })
      render(<GameVideoAction game={pending} />)

      expect(screen.getByText(visibleStatus)).toBeInTheDocument()
      expect(
        screen.getByRole("link", {
          name: `${accessibleStatus} for ${snapshot.team.name} versus Test Opponent; open the ${providerLabel} YouTube channel`,
        })
      )
        .toHaveAttribute("href", pending.video.channelUrl)
        .toHaveClass("video-pending-button")
      expect(screen.queryByRole("link", { name: /Watch game/i })).toBeNull()
    }
  )

  it.each(["bye", "canceled"] as const)(
    "renders no YouTube action when video is not expected for a %s",
    (reason) => {
      const game = gameWithVideo({ state: "not_expected", reason })
      const { container } = render(<GameVideoAction game={game} />)

      expect(container).toBeEmptyDOMElement()
      expect(screen.queryByRole("link")).toBeNull()
    }
  )

  it("renders V3 video actions in the schedule without runtime data requests", () => {
    renderApp("#/schedule")

    expect(
      screen.getAllByRole("link", { name: /YouTube/ }).length
    ).toBeGreaterThan(0)
  })

  it("navigates hash routes without a data request", () => {
    renderApp("#/standings")
    expect(
      screen.getByRole("heading", { name: /Standings/ })
    ).toBeInTheDocument()
    window.location.hash = "#/roster"
    fireEvent(window, new HashChangeEvent("hashchange"))
    expect(screen.getByRole("heading", { name: /Roster/ })).toBeInTheDocument()
  })

  it("filters the roster locally", () => {
    renderApp("#/roster")
    const selected = snapshot.roster[0]
    const excluded = snapshot.roster[1]
    fireEvent.change(screen.getByRole("textbox", { name: "Search roster" }), {
      target: { value: selected.name },
    })
    expect(screen.getByText(selected.name)).toBeInTheDocument()
    expect(screen.queryByText(excluded.name)).not.toBeInTheDocument()
  })

  it("does not infer source failure from the age of unchanged content", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"))

    renderApp("#/overview")

    expect(screen.queryByText("Source check is stale")).not.toBeInTheDocument()
  })

  it("describes the rendered data as a validated snapshot", () => {
    renderApp("#/overview")

    expect(screen.getAllByText("Validated snapshot").length).toBeGreaterThan(0)
    expect(screen.queryByText("Live source validated")).not.toBeInTheDocument()
  })
})
