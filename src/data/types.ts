export type {
  BoxScorePlayerLine,
  BoxScoreSide,
  GameBoxScore,
  GameRow,
  GameState,
  GameVideoAvailability,
  LeaderCategory,
  LeaderRow,
  PlayerRow,
  ProviderCapabilities,
  ProviderKind,
  Result,
  ShootingLine,
  SourceReference,
  StandingRow,
  TeamIdentity,
  TeamSnapshot,
  TeamSnapshotV3,
  TeamStats,
  TeamSummary,
  VerifiedVideoMatch,
} from "@basketball-os/public-contracts/types"

import type { TeamSnapshotV3 } from "@basketball-os/public-contracts/types"

/** @deprecated Use TeamSnapshotV3. Retained while child projects merge the base release. */
export type Team1Snapshot = TeamSnapshotV3
