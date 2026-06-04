# melk-architecture icon pack

A small starter pack (32 icons) for architecture diagrams. Curated from
[Lucide](https://lucide.dev/) (ISC) with three hand-authored additions
where Lucide doesn't ship the exact glyph.

All icons are 24×24 viewBox, line-art, `fill="none"`, `stroke="currentColor"`,
2px stroke. They re-tint to the active melk theme automatically.

## Use it

In your `.melk` file:

```melk
icons: arch from "./icons/melk-architecture/"

api      { shape: icon(arch/compute/server), label: "API" }
queue    { shape: icon(arch/messaging/message-square), label: "Job queue" }
users    { shape: icon(arch/actors/users) }
```

The path inside the `icon(...)` call mirrors the directory structure —
`arch/compute/server` resolves to `icons/melk-architecture/compute/server.svg`.

## Contents (32 icons)

### Actors (3)
`actors/user`, `actors/users`, `actors/c4-person`

### Compute (5)
`compute/server`, `compute/cpu`, `compute/container`,
`compute/function` (λ), `compute/uml-node` (3-D box)

### Storage (5)
`storage/database`, `storage/hard-drive`, `storage/file`,
`storage/folder`, `storage/archive`

### Messaging (4)
`messaging/message-square` (queue), `messaging/radio` (topic / pub-sub),
`messaging/zap` (event / stream), `messaging/webhook`

### Networking (5)
`networking/globe`, `networking/cloud`, `networking/router` (LB / gateway),
`networking/shield` (firewall / security), `networking/network` (mesh)

### Clients (3)
`clients/monitor`, `clients/smartphone`, `clients/laptop`

### Ops (4)
`ops/activity` (monitoring), `ops/key` (auth / secrets),
`ops/bell` (notifications), `ops/clock` (scheduler / cron)

### Structural (3)
`structural/puzzle` (component), `structural/box` (artifact),
`structural/layers` (boundary / grouping)

## What's hand-authored vs from Lucide

| Icon | Source |
|------|--------|
| `actors/c4-person` | Hand-authored (C4-style head-and-shoulders silhouette) |
| `compute/function` | Hand-authored (λ glyph; Lucide doesn't ship a function icon) |
| `compute/uml-node` | Hand-authored (UML's 3-D cube; Lucide's `box` is 2-D) |
| Everything else | Lucide (downloaded from `lucide.dev`) |

## License

Lucide icons are ISC-licensed. The hand-authored additions
(`c4-person`, `function`, `uml-node`) are released under the same ISC
license for consistency. See [LICENSE.txt](./LICENSE.txt).

Some Lucide icons are themselves derived from the
[Feather](https://feathericons.com/) project, also under a permissive
MIT license. The combined license file reproduces both notices.

## Style: outlined-by-default

melk's built-in themes default to `icon-style: outlined`. These Lucide
icons already use `fill="none"` and `stroke="currentColor"`, so they
render as line-art under either theme setting. The line weight you see
is `theme.strokes.outline` (1px in the default `document-light`).

## Categories that aren't covered

If you need vendor logos (AWS S3, Azure Functions, GCP Cloud Run, etc.),
those packs aren't redistributable with melk. Register a second pack
pointed at a locally-downloaded copy:

```melk
icons: aws from "/path/to/your-aws-icons/"
icons: arch from "./icons/melk-architecture/"

bucket   { shape: icon(aws/s3), label: "Uploads" }
worker   { shape: icon(arch/compute/function), label: "Resize" }
```

[simple-icons](https://simpleicons.org/) (CC0) covers brand silhouettes
and is freely redistributable if you want tech-stack logos.
