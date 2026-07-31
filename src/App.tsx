import * as React from "react"
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"
import {
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  CirclePlay,
  CircleDot,
  Clock3,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Medal,
  Moon,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Sun,
  Trophy,
  Users,
} from "lucide-react"

import snapshotJson from "../data/snapshot.json" with { type: "json" }
import { useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  BoxScoreSide,
  GameRow,
  LeaderRow,
  TeamSnapshot,
} from "@/data/types"

const snapshot = snapshotJson as TeamSnapshot
const providerLabel =
  snapshot.identity.provider === "stm" ? "STM Sports" : "TeamLinkt"
const teamMark =
  snapshot.team.name.match(/\d+/)?.[0] ??
  snapshot.team.name
    .split(/\s+/)
    .filter((word) => !/^the$/i.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase()

type ViewKey =
  | "overview"
  | "schedule"
  | "standings"
  | "roster"
  | "leaders"
  | "team-stats"
  | "box-scores"

interface Route {
  view: ViewKey
  gameId: string | null
}

const NAV_ITEMS: Array<{
  view: ViewKey
  label: string
  icon: React.ComponentType<{ className?: string }>
  mobilePrimary?: boolean
}> = [
  {
    view: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    mobilePrimary: true,
  },
  {
    view: "schedule",
    label: "Schedule",
    icon: CalendarDays,
    mobilePrimary: true,
  },
  { view: "standings", label: "Standings", icon: Trophy, mobilePrimary: true },
  { view: "roster", label: "Roster", icon: Users, mobilePrimary: true },
  { view: "leaders", label: "Leaders", icon: Medal },
  { view: "team-stats", label: "Team Stats", icon: ChartNoAxesCombined },
  { view: "box-scores", label: "Box Scores", icon: FileText },
]

const VIEW_COPY: Record<ViewKey, { title: string; description: string }> = {
  overview: {
    title: `${snapshot.team.name} Command Center`,
    description: "Your next game, record, form, and leaders at a glance.",
  },
  schedule: {
    title: "Schedule & Results",
    description: `Every ${snapshot.team.name} game with verified local start times.`,
  },
  standings: {
    title: "Standings",
    description: `The league table and recent form with ${snapshot.team.name} held in focus.`,
  },
  roster: {
    title: "Roster",
    description: `Player production published for ${snapshot.team.name}.`,
  },
  leaders: {
    title: "Leaders",
    description: `${snapshot.team.name}’s best alongside the wider league context.`,
  },
  "team-stats": {
    title: "Team Stats",
    description: "Derived only from completed games with published box scores.",
  },
  "box-scores": {
    title: "Box Scores",
    description: "Local, readable game books for both teams.",
  },
}

function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "")
  const [candidate = "overview", gameId] = raw.split("/")
  const view = NAV_ITEMS.some((item) => item.view === candidate)
    ? (candidate as ViewKey)
    : "overview"
  return { view, gameId: view === "box-scores" ? (gameId ?? null) : null }
}

function useHashRoute(): Route {
  const [route, setRoute] = React.useState<Route>(() => parseRoute())
  React.useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#/overview")
    }
    const update = () => setRoute(parseRoute())
    window.addEventListener("hashchange", update)
    return () => window.removeEventListener("hashchange", update)
  }, [])
  return route
}

function localDate(date: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: snapshot.identity.timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(`${date}T12:00:00Z`))
}

function localTime(time: string | null) {
  if (!time) return "TBD"
  const [hour, minute] = time.split(":").map(Number)
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2026, 0, 1, hour, minute))
}

function formatValue(value: number, suffix = "") {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`
}

function resultBadge(game: GameRow) {
  if (game.result === "W") return <Badge className="badge-positive">Win</Badge>
  if (game.result === "L") return <Badge variant="destructive">Loss</Badge>
  if (game.state === "scheduled")
    return <Badge variant="secondary">Upcoming</Badge>
  if (game.state === "unreported")
    return <Badge variant="outline">Awaiting result</Badge>
  if (game.state === "bye") return <Badge variant="outline">Bye week</Badge>
  return (
    <Badge variant="outline">
      {game.state.charAt(0).toUpperCase() + game.state.slice(1)}
    </Badge>
  )
}

const CHANNEL_ONLY_COPY = {
  not_found: {
    badge: "Not uploaded yet",
    description: "No verified game video is uploaded yet",
  },
  ambiguous: {
    badge: "Upload needs review",
    description: "The possible game video match needs review",
  },
  source_unavailable: {
    badge: "Upload status unavailable",
    description: "Game video availability could not be checked",
  },
} as const

export function GameVideoAction({
  game,
  size = "sm",
}: {
  game: GameRow
  size?: "sm" | "default"
}) {
  const matchup = `${snapshot.team.name} ${
    game.isHome ? "versus" : "at"
  } ${game.opponentName}`

  if (game.video.state === "verified_exact") {
    return (
      <Button asChild size={size} className="video-ready-button min-h-11">
        <a
          href={game.video.videoUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Watch ${matchup} on YouTube`}
          title={game.video.videoTitle}
        >
          <CirclePlay data-icon="inline-start" />
          Watch game
        </a>
      </Button>
    )
  }

  if (game.video.state === "not_expected") return null

  const copy = CHANNEL_ONLY_COPY[game.video.reason]

  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-2"
      data-video-state="channel_only"
    >
      <Badge variant="outline">{copy.badge}</Badge>
      <Button
        asChild
        size={size}
        variant="secondary"
        className="video-pending-button min-h-11"
      >
        <a
          href={game.video.channelUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${copy.description} for ${matchup}; open the ${providerLabel} YouTube channel`}
        >
          <CirclePlay data-icon="inline-start" />
          Check channel
        </a>
      </Button>
    </div>
  )
}

function TeamMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="team-mark" aria-hidden="true">
        {teamMark}
      </div>
      {!compact && (
        <div className="min-w-0">
          <p className="font-display line-clamp-2 text-[0.95rem] leading-tight uppercase">
            {snapshot.team.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {snapshot.team.season}
          </p>
        </div>
      )}
    </div>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
          onClick={() => setTheme(dark ? "light" : "dark")}
        >
          {dark ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Theme <kbd>D</kbd>
      </TooltipContent>
    </Tooltip>
  )
}

function DesktopSidebar({ active }: { active: ViewKey }) {
  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-sidebar-border"
      role="navigation"
      aria-label="Desktop navigation"
    >
      <SidebarHeader className="h-20 justify-center px-4">
        <TeamMark />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{snapshot.team.name}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.view}>
                  <SidebarMenuButton
                    asChild
                    isActive={active === item.view}
                    tooltip={item.label}
                    className="min-h-11"
                  >
                    <a href={`#/${item.view}`}>
                      <item.icon />
                      <span>{item.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-3">
        <div className="rounded-lg border bg-background/40 p-3 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck className="size-4 text-positive" />
            Validated snapshot
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {new Date(snapshot.generatedAt).toLocaleString("en-CA", {
              timeZone: snapshot.identity.timezone,
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function MobileRail({ active }: { active: ViewKey }) {
  const primary = NAV_ITEMS.filter((item) => item.mobilePrimary)
  const secondary = NAV_ITEMS.filter((item) => !item.mobilePrimary)
  return (
    <nav className="mobile-rail" aria-label="Primary navigation">
      {primary.map((item) => (
        <a
          key={item.view}
          href={`#/${item.view}`}
          className={cn(
            "mobile-rail-item",
            active === item.view && "is-active"
          )}
          aria-current={active === item.view ? "page" : undefined}
        >
          <item.icon />
          <span>{item.label}</span>
        </a>
      ))}
      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className={cn(
              "mobile-rail-item",
              secondary.some((item) => item.view === active) && "is-active"
            )}
          >
            <MoreHorizontal />
            <span>More</span>
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader>
            <SheetTitle>More {snapshot.team.name} views</SheetTitle>
            <SheetDescription>
              Leaders, team stats, and full game books.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-2 px-4 pb-4">
            {secondary.map((item) => (
              <SheetClose asChild key={item.view}>
                <a
                  href={`#/${item.view}`}
                  className="flex min-h-12 items-center gap-3 rounded-xl border bg-card px-4 font-semibold"
                >
                  <item.icon className="size-5 text-primary" />
                  {item.label}
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </a>
              </SheetClose>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  )
}

function MetricCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string
  value: React.ReactNode
  detail: string
  accent?: boolean
}) {
  return (
    <Card className={cn("metric-card", accent && "metric-card-accent")}>
      <CardContent className="p-5">
        <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground uppercase">
          {label}
        </p>
        <div className="font-display mt-3 text-3xl leading-none">{value}</div>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function RecentFormCard() {
  const games = snapshot.games
    .filter(
      (game) =>
        game.teamScore !== null &&
        game.opponentScore !== null &&
        game.result !== null
    )
    .slice(-5)
  const maxMargin = Math.max(
    ...games.map((game) => Math.abs(game.teamScore! - game.opponentScore!)),
    10
  )
  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between">
        <div>
          <CardTitle>Recent form</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Margin of victory across the latest scored games
          </p>
        </div>
        <Badge variant="outline">{games.length} games</Badge>
      </CardHeader>
      <CardContent>
        <div
          className="recent-form-chart"
          role="img"
          aria-label={`Recent scoring margins: ${games
            .map((game) => {
              const margin = game.teamScore! - game.opponentScore!
              return `${game.result} ${margin > 0 ? "+" : ""}${margin} against ${game.opponentName}`
            })
            .join(", ")}`}
        >
          <div className="recent-form-zero" aria-hidden="true" />
          {games.map((game) => {
            const margin = game.teamScore! - game.opponentScore!
            const position = 50 - (margin / maxMargin) * 40
            const stemTop = Math.min(position, 50)
            const stemHeight = Math.max(Math.abs(position - 50), 1)
            return (
              <div className="recent-form-game" key={game.id}>
                <div className="recent-form-plot" aria-hidden="true">
                  <span
                    className={cn(
                      "recent-form-stem",
                      margin >= 0 ? "is-win" : "is-loss"
                    )}
                    style={{ top: `${stemTop}%`, height: `${stemHeight}%` }}
                  />
                  <span
                    className={cn(
                      "recent-form-dot",
                      margin >= 0 ? "is-win" : "is-loss"
                    )}
                    style={{ top: `${position}%` }}
                  />
                  <strong
                    className={cn(
                      "recent-form-value",
                      margin >= 0 ? "is-win" : "is-loss"
                    )}
                    style={{
                      top: `${Math.max(3, Math.min(position - 16, 78))}%`,
                    }}
                  >
                    {margin > 0 ? "+" : ""}
                    {margin}
                  </strong>
                </div>
                <p className="truncate text-center text-xs font-bold">
                  {game.opponentName}
                </p>
                <p className="text-center text-[0.68rem] text-muted-foreground">
                  {localDate(game.date, { month: "short", day: "numeric" })}
                </p>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function GameSummary({
  game,
  compact = false,
}: {
  game: GameRow
  compact?: boolean
}) {
  return (
    <article
      className={cn(
        "game-row group rounded-xl border bg-card transition-colors hover:border-primary/50",
        compact ? "p-4" : "p-5"
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {resultBadge(game)}
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {localDate(game.date, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
          <h2 className="mt-3 text-lg font-bold">
            {game.isHome ? "vs" : "at"} {game.opponentName}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Clock3 className="size-4" />
            {localTime(game.displayTime)}
            <span aria-hidden="true">·</span>
            {game.isHome ? "Home" : "Away"}
          </div>
        </div>
        {game.teamScore !== null && game.opponentScore !== null && (
          <div className="text-right">
            <div className="font-display text-2xl">
              {game.teamScore}
              <span className="mx-1 text-muted-foreground">–</span>
              {game.opponentScore}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {snapshot.team.name} first
            </p>
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <GameVideoAction game={game} />
        {game.hasBoxScore && (
          <Button asChild size="sm">
            <a href={`#/box-scores/${game.id}`}>
              View box score <ChevronRight />
            </a>
          </Button>
        )}
        <Button asChild size="sm" variant="outline">
          <a href={game.officialUrl} target="_blank" rel="noreferrer">
            Official {providerLabel} <ExternalLink />
          </a>
        </Button>
      </div>
    </article>
  )
}

function OverviewView() {
  const nextGame = snapshot.games.find((game) => game.state === "scheduled")
  const latestResult = snapshot.games.filter((game) => game.result).at(-1)
  const recent = snapshot.games
    .filter((game) => game.result)
    .slice(-3)
    .reverse()
  const bestTeamLeaders = snapshot.teamLeaders.slice(0, 3)
  return (
    <div className="view-stack">
      {nextGame && (
        <Card className="hero-card overflow-hidden">
          <CardContent className="grid gap-6 p-6 lg:grid-cols-[1.15fr_0.85fr] lg:p-8">
            <div>
              <Badge className="badge-source">
                <CircleDot /> Next game
              </Badge>
              <p className="mt-5 text-sm font-bold tracking-[0.16em] text-muted-foreground uppercase">
                {localDate(nextGame.date, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <h2 className="font-display mt-2 text-4xl leading-[0.95] uppercase sm:text-5xl">
                {snapshot.team.name} <span className="text-primary">vs</span>{" "}
                {nextGame.opponentName}
              </h2>
              <div className="mt-5 flex flex-wrap items-center gap-4 text-sm">
                <span className="flex items-center gap-2 font-bold">
                  <Clock3 className="size-4 text-primary" />
                  {localTime(nextGame.displayTime)}
                </span>
                <span className="text-muted-foreground">
                  {nextGame.isHome ? "Home" : "Away"} · Toronto time
                </span>
              </div>
            </div>
            <div className="flex items-end lg:justify-end">
              <div className="w-full rounded-2xl border bg-background/55 p-5 lg:max-w-sm">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground uppercase">
                  Current position
                </p>
                <div className="mt-3 flex items-end justify-between gap-4">
                  <span className="font-display text-5xl">
                    #{snapshot.team.standing}
                  </span>
                  <span className="pb-1 text-right text-sm text-muted-foreground">
                    {snapshot.team.wins}–{snapshot.team.losses}
                    <br />+{snapshot.team.differential} differential
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {!nextGame && latestResult && (
        <Card className="hero-card overflow-hidden">
          <CardContent className="grid gap-6 p-6 lg:grid-cols-[1.15fr_0.85fr] lg:p-8">
            <div>
              <Badge className="badge-source">
                <CalendarDays /> Season status
              </Badge>
              <p className="mt-5 text-sm font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Schedule checked {localDate(snapshot.generatedAt.slice(0, 10))}
              </p>
              <h2 className="font-display mt-2 text-4xl leading-[0.95] uppercase sm:text-5xl">
                No upcoming game <span className="text-primary">published</span>
              </h2>
              <p className="mt-4 max-w-xl text-sm text-muted-foreground">
                The dashboard will add the next matchup as soon as{" "}
                {providerLabel} publishes it.
              </p>
            </div>
            <div className="flex items-end lg:justify-end">
              <div className="w-full rounded-2xl border bg-background/55 p-5 lg:max-w-sm">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground uppercase">
                  Latest result
                </p>
                <div className="mt-3 flex items-end justify-between gap-4">
                  <span className="font-display text-4xl">
                    {latestResult.teamScore}–{latestResult.opponentScore}
                  </span>
                  <span className="pb-1 text-right text-sm text-muted-foreground">
                    {latestResult.result === "W" ? "Win" : "Loss"}
                    <br />
                    {latestResult.isHome ? "vs" : "at"}{" "}
                    {latestResult.opponentName}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <section className="metric-grid" aria-label="Season snapshot">
        <MetricCard
          label="Record"
          value={`${snapshot.team.wins}–${snapshot.team.losses}`}
          detail={`${snapshot.team.wins + snapshot.team.losses} games played`}
          accent
        />
        <MetricCard
          label="Standing"
          value={`#${snapshot.team.standing}`}
          detail={`of ${snapshot.standings.length} teams`}
        />
        <MetricCard
          label="Point diff"
          value={`${snapshot.team.differential >= 0 ? "+" : ""}${snapshot.team.differential}`}
          detail={`${snapshot.team.pointsFor} PF · ${snapshot.team.pointsAgainst} PA`}
        />
      </section>

      <RecentFormCard />

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader>
            <CardTitle>Recent results</CardTitle>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <a href="#/schedule">
                  Full schedule <ChevronRight />
                </a>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-3">
            {recent.map((game) => (
              <GameSummary key={game.id} game={game} compact />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Team leaders</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {bestTeamLeaders.map((leader, index) => (
              <div key={leader.category} className="leader-strip">
                <span className="font-display text-xl text-primary">
                  0{index + 1}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-bold">{leader.playerName}</p>
                  <p className="text-xs text-muted-foreground">
                    {leader.label}
                  </p>
                </div>
                <span className="ml-auto font-bold">
                  {formatValue(leader.value)} <small>{leader.unit}</small>
                </span>
              </div>
            ))}
            <Button asChild variant="outline">
              <a href="#/leaders">See every leader</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ScheduleView() {
  const upcoming = snapshot.games.filter((game) => game.state === "scheduled")
  const results = snapshot.games.filter((game) => game.result)
  const gameList = (games: GameRow[]) => (
    <div className="grid gap-4 lg:grid-cols-2">
      {games.map((game) => (
        <GameSummary key={game.id} game={game} />
      ))}
    </div>
  )
  return (
    <Tabs defaultValue="all">
      <TabsList className="mb-6">
        <TabsTrigger value="all">All ({snapshot.games.length})</TabsTrigger>
        <TabsTrigger value="upcoming">Upcoming ({upcoming.length})</TabsTrigger>
        <TabsTrigger value="results">Results ({results.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="all">{gameList(snapshot.games)}</TabsContent>
      <TabsContent value="upcoming">{gameList(upcoming)}</TabsContent>
      <TabsContent value="results">{gameList(results)}</TabsContent>
    </Tabs>
  )
}

function StandingsView() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{snapshot.team.season} standings</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">#</TableHead>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">W</TableHead>
                <TableHead className="text-right">L</TableHead>
                <TableHead className="text-right">GP</TableHead>
                <TableHead className="text-right">PF</TableHead>
                <TableHead className="text-right">PA</TableHead>
                <TableHead>Recent</TableHead>
                <TableHead className="pr-6 text-right">Diff</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.standings.map((row) => (
                <TableRow
                  key={row.teamId}
                  className={cn(
                    row.teamId === snapshot.team.id && "team-one-row"
                  )}
                >
                  <TableCell className="pl-6 font-bold">{row.rank}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 font-bold">
                      {row.teamName}
                      {row.teamId === snapshot.team.id && <Badge>YOU</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{row.wins}</TableCell>
                  <TableCell className="text-right">{row.losses}</TableCell>
                  <TableCell className="text-right">
                    {row.gamesPlayed}
                  </TableCell>
                  <TableCell className="text-right">{row.pointsFor}</TableCell>
                  <TableCell className="text-right">
                    {row.pointsAgainst}
                  </TableCell>
                  <TableCell>
                    {row.form?.length ? (
                      <div
                        className="flex min-w-24 gap-1"
                        aria-label={`Recent form ${row.form.join(", ")}`}
                      >
                        {row.form.map((result, index) => (
                          <Badge
                            key={`${row.teamId}-${index}`}
                            variant={result === "W" ? "default" : "destructive"}
                            className="size-6 justify-center p-0"
                          >
                            {result}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {row.streak}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="pr-6 text-right font-bold">
                    {row.differential > 0 ? "+" : ""}
                    {row.differential}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

type RosterSort = "ppg" | "rpg" | "apg" | "spg" | "bpg"

function RosterView() {
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<RosterSort>("ppg")
  const players = React.useMemo(
    () =>
      [...snapshot.roster]
        .filter((player) =>
          player.name.toLowerCase().includes(query.toLowerCase())
        )
        .sort((a, b) => b[sort] - a[sort]),
    [query, sort]
  )
  return (
    <Card>
      <CardHeader className="gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <CardTitle>{snapshot.team.name} roster</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Search players or rank the active roster by a key statistic.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative">
            <span className="sr-only">Search roster</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search players"
              className="pl-9 sm:w-56"
            />
          </label>
          <label>
            <span className="sr-only">Sort roster</span>
            <select
              className="h-10 min-w-36 rounded-lg border bg-background px-3 text-sm font-semibold"
              value={sort}
              onChange={(event) => setSort(event.target.value as RosterSort)}
            >
              <option value="ppg">Points</option>
              <option value="rpg">Rebounds</option>
              <option value="apg">Assists</option>
              <option value="spg">Steals</option>
              <option value="bpg">Blocks</option>
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {players.length ? (
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Player</TableHead>
                  <TableHead className="text-right">GP</TableHead>
                  <TableHead className="text-right">PPG</TableHead>
                  <TableHead className="text-right">RPG</TableHead>
                  <TableHead className="text-right">APG</TableHead>
                  <TableHead className="text-right">SPG</TableHead>
                  <TableHead className="pr-6 text-right">BPG</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {players.map((player) => (
                  <TableRow key={player.id}>
                    <TableCell className="pl-6">
                      <div className="flex items-center gap-3">
                        <span className="player-number">
                          {player.jersey ?? "—"}
                        </span>
                        <span className="font-bold">{player.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {player.gamesPlayed}
                    </TableCell>
                    <TableCell className="text-right font-bold">
                      {player.ppg.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {player.rpg.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {player.apg.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {player.spg.toFixed(1)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {player.bpg.toFixed(1)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        ) : (
          <Empty className="mx-6 min-h-60">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>No roster match</EmptyTitle>
              <EmptyDescription>Try another player name.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

function LeaderGrid({ leaders }: { leaders: LeaderRow[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {leaders.map((leader, index) => (
        <Card
          key={leader.category}
          className={cn(index === 0 && "metric-card-accent")}
        >
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <Badge variant="outline">{leader.label}</Badge>
              <span className="font-display text-xl text-primary">
                0{index + 1}
              </span>
            </div>
            <p className="font-display mt-8 text-3xl">
              {formatValue(leader.value)}
              <small className="ml-1 text-xs text-muted-foreground">
                {leader.unit}
              </small>
            </p>
            <p className="mt-3 font-bold">{leader.playerName}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {leader.teamName}
            </p>
            {leader.tied && (
              <Badge variant="secondary" className="mt-3">
                Tied
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function LeadersView() {
  return (
    <Tabs defaultValue="team">
      <TabsList className="mb-6">
        <TabsTrigger value="team">{snapshot.team.name}</TabsTrigger>
        <TabsTrigger value="league">League</TabsTrigger>
      </TabsList>
      <TabsContent value="team">
        <LeaderGrid leaders={snapshot.teamLeaders} />
      </TabsContent>
      <TabsContent value="league">
        <LeaderGrid leaders={snapshot.leagueLeaders} />
      </TabsContent>
    </Tabs>
  )
}

function TeamStatsView() {
  const data = [
    { label: "PTS", value: snapshot.teamStats.pointsPerGame },
    { label: "REB", value: snapshot.teamStats.reboundsPerGame },
    { label: "AST", value: snapshot.teamStats.assistsPerGame },
    { label: "STL", value: snapshot.teamStats.stealsPerGame },
    { label: "BLK", value: snapshot.teamStats.blocksPerGame },
  ]
  const shooting = [
    { label: "Field goals", value: snapshot.teamStats.fieldGoalPct },
    { label: "Three-pointers", value: snapshot.teamStats.threePointPct },
    { label: "Free throws", value: snapshot.teamStats.freeThrowPct },
  ]
  return (
    <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
      <Card>
        <CardHeader>
          <CardTitle>Per-game production</CardTitle>
          <p className="text-sm text-muted-foreground">
            {snapshot.teamStats.gamesWithBoxScores} published game books
            included
          </p>
        </CardHeader>
        <CardContent>
          <ChartContainer
            className="min-h-72 w-full"
            config={{ value: { label: "Per game", color: "var(--primary)" } }}
          >
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} width={28} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {data.map((entry, index) => (
                  <Cell
                    key={entry.label}
                    fill={index === 0 ? "var(--source)" : "var(--primary)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Shooting profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {shooting.map((item) => (
            <div key={item.label}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{item.label}</span>
                <span className="font-display text-xl">
                  {item.value === null ? "—" : `${item.value.toFixed(1)}%`}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(item.value ?? 0, 100)}%` }}
                />
              </div>
            </div>
          ))}
          <Separator />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Team Stats intentionally exclude forfeits and games without a
            published player box-score table.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function SideTable({ side }: { side: BoxScoreSide }) {
  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between">
        <div>
          <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground uppercase">
            Final
          </p>
          <CardTitle className="mt-1">{side.teamName}</CardTitle>
        </div>
        <span className="font-display text-4xl">{side.score}</span>
      </CardHeader>
      <CardContent className="px-0">
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Player</TableHead>
                <TableHead className="text-right">PTS</TableHead>
                <TableHead className="text-right">REB</TableHead>
                <TableHead className="text-right">AST</TableHead>
                <TableHead className="text-right">STL</TableHead>
                <TableHead className="text-right">BLK</TableHead>
                <TableHead className="pr-6 text-right">FG</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {side.players.map((player) => (
                <TableRow key={player.playerId}>
                  <TableCell className="pl-6">
                    <span className="font-bold">{player.playerName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      #{player.jersey ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-bold">
                    {player.points}
                  </TableCell>
                  <TableCell className="text-right">
                    {player.rebounds}
                  </TableCell>
                  <TableCell className="text-right">{player.assists}</TableCell>
                  <TableCell className="text-right">{player.steals}</TableCell>
                  <TableCell className="text-right">{player.blocks}</TableCell>
                  <TableCell className="pr-6 text-right">
                    {player.fieldGoals.made}/{player.fieldGoals.attempted}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/50 font-bold">
                <TableCell className="pl-6">Totals</TableCell>
                <TableCell className="text-right">
                  {side.totals.points}
                </TableCell>
                <TableCell className="text-right">
                  {side.totals.rebounds}
                </TableCell>
                <TableCell className="text-right">
                  {side.totals.assists}
                </TableCell>
                <TableCell className="text-right">
                  {side.totals.steals}
                </TableCell>
                <TableCell className="text-right">
                  {side.totals.blocks}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {side.totals.fieldGoals.made}/
                  {side.totals.fieldGoals.attempted}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function BoxScoresView({ gameId }: { gameId: string | null }) {
  const selected = gameId
    ? snapshot.boxScores.find((boxScore) => boxScore.gameId === gameId)
    : null
  if (gameId && !selected) {
    return (
      <Empty className="min-h-96 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyTitle>Box score unavailable</EmptyTitle>
          <EmptyDescription>
            {providerLabel} has not published a complete player table for this
            game.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <a href="#/box-scores">All box scores</a>
        </Button>
      </Empty>
    )
  }
  if (selected) {
    const game = snapshot.games.find(
      (candidate) => candidate.id === selected.gameId
    )!
    return (
      <div className="view-stack">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="outline">
            <a href="#/box-scores">← All games</a>
          </Button>
          <div className="flex flex-wrap gap-2">
            <GameVideoAction game={game} size="default" />
            <Button asChild variant="ghost">
              <a href={selected.officialUrl} target="_blank" rel="noreferrer">
                Official {providerLabel} game <ExternalLink />
              </a>
            </Button>
          </div>
        </div>
        <Card className="scoreboard-card">
          <CardContent className="grid items-center gap-6 p-6 text-center sm:grid-cols-[1fr_auto_1fr]">
            <div>
              <p className="font-display text-2xl">{selected.home.teamName}</p>
              <p className="font-display mt-2 text-5xl">
                {selected.home.score}
              </p>
            </div>
            <div>
              <Badge variant="outline">FINAL</Badge>
              <p className="mt-2 text-sm text-muted-foreground">
                {localDate(game.date)}
              </p>
            </div>
            <div>
              <p className="font-display text-2xl">{selected.away.teamName}</p>
              <p className="font-display mt-2 text-5xl">
                {selected.away.score}
              </p>
            </div>
          </CardContent>
        </Card>
        <SideTable side={selected.home} />
        <SideTable side={selected.away} />
      </div>
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {snapshot.games
        .filter((game) => game.result)
        .slice()
        .reverse()
        .map((game) => (
          <GameSummary key={game.id} game={game} />
        ))}
    </div>
  )
}

function ActiveView({ route }: { route: Route }) {
  switch (route.view) {
    case "overview":
      return <OverviewView />
    case "schedule":
      return <ScheduleView />
    case "standings":
      return <StandingsView />
    case "roster":
      return <RosterView />
    case "leaders":
      return <LeadersView />
    case "team-stats":
      return <TeamStatsView />
    case "box-scores":
      return <BoxScoresView gameId={route.gameId} />
  }
}

export default function App() {
  const route = useHashRoute()
  const copy = VIEW_COPY[route.view]
  React.useEffect(() => {
    document.title = `${snapshot.team.name} Command Center · ${snapshot.team.season}`
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]'
    )
    description?.setAttribute(
      "content",
      `${snapshot.team.name} schedule, standings, leaders, statistics, box scores, and game videos.`
    )
  }, [])
  return (
    <TooltipProvider>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <SidebarProvider>
        <DesktopSidebar active={route.view} />
        <SidebarInset className="min-w-0">
          <header className="app-header">
            <div className="md:hidden">
              <TeamMark compact />
            </div>
            <div className="min-w-0">
              <p className="hidden text-xs font-bold tracking-[0.14em] text-muted-foreground uppercase md:block">
                {snapshot.identity.leagueName} · {snapshot.team.season}
              </p>
              <h1 className="font-display truncate text-xl uppercase md:mt-1 md:text-2xl">
                <span className="md:hidden">
                  {route.gameId
                    ? "Game Book"
                    : NAV_ITEMS.find((item) => item.view === route.view)?.label}
                </span>
                <span className="hidden md:inline">
                  {route.gameId ? "Game Book" : copy.title}
                </span>
              </h1>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Badge variant="outline" className="hidden lg:inline-flex">
                <ShieldCheck /> Validated snapshot
              </Badge>
              <ThemeToggle />
            </div>
          </header>
          <main id="main-content" className="app-main" tabIndex={-1}>
            <div className="page-intro">
              <p>{copy.description}</p>
            </div>
            <ActiveView route={route} />
            <footer className="app-footer">
              <div>
                <p className="font-bold">{snapshot.team.name} Command Center</p>
                <p>
                  Operational data from {providerLabel}. Unlisted and noindexed.
                </p>
              </div>
              <div className="text-right">
                <p>Data {snapshot.contentHash.slice(0, 8)}</p>
                <p>
                  Code {__CODE_REVISION__.slice(0, 8)} · Revision{" "}
                  {__DATA_REVISION__.slice(0, 8)}
                </p>
              </div>
            </footer>
          </main>
          <MobileRail active={route.view} />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
