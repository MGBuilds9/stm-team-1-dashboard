import fs from "node:fs/promises"
import path from "node:path"

import { teamConfigSchema, type TeamConfig } from "../src/data/config"

const MAX_TEAM_CONFIG_BYTES = 64 * 1024

export async function readTeamConfig(file: string): Promise<TeamConfig> {
  const metadata = await fs.lstat(file)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_TEAM_CONFIG_BYTES
  ) {
    throw new Error(
      `${path.basename(file)} must be a bounded regular non-symlink file`
    )
  }
  return teamConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
}
