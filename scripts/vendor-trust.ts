type TrustedVendorIdentity =
  | {
      name: "@basketball-os/public-contracts"
      file: "basketball-os-public-contracts-0.1.0.tgz"
    }
  | {
      name: "@basketball-os/team-release"
      file: "basketball-os-team-release-0.1.0.tgz"
    }

export type TrustedVendorPackage = TrustedVendorIdentity & {
  version: "0.1.0"
  sha256: string
  exports: Record<string, unknown>
  members: readonly string[]
  schemas: Readonly<Record<string, string>>
}

/**
 * Reviewed, source-controlled trust roots for the exact Basketball OS release
 * consumed by this dashboard. Updating a vendored package requires updating
 * this policy in the same deliberate code review as the vendor payload.
 */
const TRUSTED_VENDOR_PACKAGES: readonly TrustedVendorPackage[] = [
  {
    name: "@basketball-os/public-contracts",
    version: "0.1.0",
    file: "basketball-os-public-contracts-0.1.0.tgz",
    sha256: "9107dee849791427c10ef512786e30e95b8c8d7b9b8fabc21b93cff77113d43a",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./types": {
        types: "./dist/types.d.ts",
        import: "./dist/types.js",
      },
      "./fixtures/team-snapshot-v3.json": "./fixtures/team-snapshot-v3.json",
      "./schemas/team-snapshot-v3.schema.json":
        "./schemas/team-snapshot-v3.schema.json",
      "./schemas/game-video-availability-v3.schema.json":
        "./schemas/game-video-availability-v3.schema.json",
    },
    members: [
      "package/README.md",
      "package/dist/canonical-json.d.ts",
      "package/dist/canonical-json.d.ts.map",
      "package/dist/canonical-json.js",
      "package/dist/index.d.ts",
      "package/dist/index.d.ts.map",
      "package/dist/index.js",
      "package/dist/json-schema.d.ts",
      "package/dist/json-schema.d.ts.map",
      "package/dist/json-schema.js",
      "package/dist/schemas.d.ts",
      "package/dist/schemas.d.ts.map",
      "package/dist/schemas.js",
      "package/dist/snapshot-content.d.ts",
      "package/dist/snapshot-content.d.ts.map",
      "package/dist/snapshot-content.js",
      "package/dist/source-set.d.ts",
      "package/dist/source-set.d.ts.map",
      "package/dist/source-set.js",
      "package/dist/types.d.ts",
      "package/dist/types.d.ts.map",
      "package/dist/types.js",
      "package/dist/validation.d.ts",
      "package/dist/validation.d.ts.map",
      "package/dist/validation.js",
      "package/fixtures/team-snapshot-v3.json",
      "package/package.json",
      "package/schemas/game-video-availability-v3.schema.json",
      "package/schemas/team-snapshot-v3.schema.json",
    ],
    schemas: {
      "package/schemas/game-video-availability-v3.schema.json":
        "db13f4e92977f8aa85d9af602cfeb9ceaa108e37cb72157cf673299131498c04",
      "package/schemas/team-snapshot-v3.schema.json":
        "bae5ff682e7d30259db9263044eea13e8780b61ce55185f99e7b9733ce4b34cb",
    },
  },
  {
    name: "@basketball-os/team-release",
    version: "0.1.0",
    file: "basketball-os-team-release-0.1.0.tgz",
    sha256: "1b4ca2f86c28811078ad22e9a0844b13a4ffe548e9db571ed459977973fe34f5",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    members: [
      "package/README.md",
      "package/dist/index.d.ts",
      "package/dist/index.d.ts.map",
      "package/dist/index.js",
      "package/package.json",
    ],
    schemas: {},
  },
]

export const TRUSTED_VENDOR_POLICY = {
  sourceRevision: "550c356b3e42c4f3b50d7201eeccfc3fc97e7c79",
  packages: TRUSTED_VENDOR_PACKAGES,
} as const
