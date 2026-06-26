# Codex vs Claude Build Usage Comparison

This document records the MindMonk build usage comparison between **Codex gpt-5.5** and
**Claude Code Opus 4.8**. The Claude numbers are **dev-only** and exclude the separate
public-repositories engineering audit. The Codex numbers are from the local Codex session
logs for this project.

_Last updated: 2026-06-26._

## Summary

| View | Codex gpt-5.5 | Claude Opus 4.8 Dev-Only | Claude / Codex |
|---|--:|--:|--:|
| Earlier snapshot cost | ~$59.46 | ~$141.33 | 2.38x |
| Current snapshot cost | ~$87.78 | ~$220.91 | 2.52x |
| Earlier snapshot tokens | 73.2M | 150.8M | 2.06x |
| Current snapshot tokens | 109.6M | 224.5M | 2.05x |
| Earlier main-thread runtime | ~2h 39m | ~2h 40m | ~1.0x |
| Current main-thread runtime | ~4h 11m | ~4h 22m | ~1.04x |
| Earlier blended cost / 1M tokens | ~$0.81 | ~$0.94 | 1.16x |
| Current blended cost / 1M tokens | ~$0.80 | ~$0.98 | 1.23x |

**Clean read:** at matched snapshots, Claude is about **2.4x earlier** and **2.5x current**
cost versus Codex. The difference is roughly **~2x more tokens × ~1.2x higher blended cost
per token**.

## Earlier Snapshot

| Metric | Codex gpt-5.5 | Claude Opus 4.8 Dev-Only | Claude / Codex |
|---|--:|--:|--:|
| Input tokens | 72,957,804 | 150,089,298 | 2.06x |
| Cached input tokens | 69,659,776 | 141,454,857 | 2.03x |
| Uncached input tokens | 3,298,028 | 8,634,441 | 2.62x |
| Output tokens | 271,464 | 693,536 | 2.55x |
| Total tokens | 73,229,268 | 150,782,834 | 2.06x |
| API-equivalent cost | ~$59.46 | ~$141.33 | 2.38x |
| Blended cost / 1M tokens | ~$0.81 | ~$0.94 | 1.16x |

At the earlier cutoff, Claude Thread B hardening dev had not started yet, so Claude
dev-only is essentially Thread A build/transcription/docs work.

## Current Snapshot

| Metric | Codex gpt-5.5 | Claude Opus 4.8 Dev-Only | Claude / Codex |
|---|--:|--:|--:|
| Input tokens | 109,200,611 | 223,307,503 | 2.04x |
| Cached input tokens | 104,683,776 | 209,343,549 | 2.00x |
| Uncached input tokens | 4,516,835 | 13,963,954 | 3.09x |
| Output tokens | 428,527 | 1,203,110 | 2.81x |
| Total tokens | 109,629,138 | 224,510,613 | 2.05x |
| API-equivalent cost | ~$87.78 | ~$220.91 | 2.52x |
| Blended cost / 1M tokens | ~$0.80 | ~$0.98 | 1.23x |

## Snapshot Delta

| Metric | Codex Delta | Claude Dev-Only Delta |
|---|--:|--:|
| Total token increase | +36,399,870 | +73,727,779 |
| Cost increase | +$28.32 | +$79.58 |
| Main reason | Continued implementation in Codex | Spec/doc workflows plus hardening and multi-tenant dev |

## Runtime Comparison

The **main-thread runtime** is the most honest like-for-like comparison: one agent turn
stream from trigger to reply, excluding Claude's parallel subagent fan-out. Claude's
main-thread value is end-to-end (includes network/streaming overhead); Codex's value is
parsed from model/runtime logs and is closer to pure model response runtime.

| Runtime Metric | Earlier Snapshot | Current Snapshot |
|---|--:|--:|
| Codex model runtime | ~2h 39m | ~4h 11m |
| Claude main-thread runtime | ~2h 40m | ~4h 22m |
| Difference (Claude − Codex) | ~+1m | ~+11m |
| Claude subagent runs, summed | ~1h 05m / 43 runs | ~2h 44m / 69 runs |
| Claude total agent runtime (main + subagents) | ~3h 45m | ~7h 06m |

**Readout:** main-thread runtime is very close between the two systems. Claude's extra
runtime is mostly parallel subagent work from spec/doc/hardening workflows. The subagent
row is summed agent-seconds; because those agents run concurrently, it is **not** the
same as wall-clock waiting time.

## Codebase Size Comparison

Codex codebase size was computed from tracked Git files in the gpt-5.5 repository. Claude
codebase size uses the `mindmonk-digest-claude4.8opus` metrics. LOC is raw line count, so
it includes comments and blank lines.

### Codex — `mindmonk-digest-gpt5.5`

| Metric | Earlier (`e88d8a8`) | Current (`c07a4ea`) | Delta |
|---|--:|--:|--:|
| TypeScript source files | 46 | 50 | +4 |
| TypeScript source LOC | 5,284 | 6,476 | +1,192 |
| Test files | 0 | 0 | 0 |
| Test LOC | 0 | 0 | 0 |
| DB tables | 6 | 12 | +6 |
| Docs (.md) files | 1 | 6 | +5 |
| Docs LOC | 170 | 2,283 | +2,113 |
| Runtime dependencies | 10 | 10 | 0 |
| Total files in repo | 52 | 61 | +9 |

### Claude — `mindmonk-digest-claude4.8opus`

| Metric | Earlier (`8c91e8b`) | Current (working tree) | Delta |
|---|--:|--:|--:|
| TypeScript source files | 29 | 39 | +10 |
| TypeScript source LOC | 1,609 | 2,486 | +877 |
| Test files | 0 | 7 | +7 |
| Test LOC | 0 | 304 | +304 |
| DB tables | 6 | 12 | +6 |
| Docs (.md) files | 1 | 8 | +7 |
| Docs LOC | 96 | 2,924 | +2,828 |
| Runtime dependencies | 8 | 8 | 0 |
| Total files in repo | 38 | 63 | +25 |

### Current snapshot — side by side

| Metric | Codex Current | Claude Current | Readout |
|---|--:|--:|---|
| TypeScript source files | 50 | 39 | Codex has more app source files |
| TypeScript source LOC | 6,476 | 2,486 | Codex has more source LOC in this snapshot |
| Test files | 0 | 7 | Claude added tests; Codex has not yet |
| Test LOC | 0 | 304 | Claude has test coverage started |
| DB tables | 12 | 12 | Same table count at current snapshot |
| Docs (.md) files | 6 | 8 | Claude has two more docs files |
| Docs LOC | 2,283 | 2,924 | Claude has more planning/docs LOC |
| Runtime dependencies | 10 | 8 | Codex has two more runtime dependencies |
| Total files in repo | 61 | 63 | Similar total file count |

**Readout:** Claude's largest codebase delta came from docs, tests, and
multi-tenant/hardening files. Codex's current repo is larger in TypeScript LOC, but Claude
has more test files and docs LOC at the compared current snapshot.

## Claude Dev-Only Breakdown

| Claude Scope | Earlier Snapshot | Current Snapshot |
|---|--:|--:|
| Thread A: build + transcription + SPEC/PHASES/ARCH docs | 150,782,834 tokens / ~$141.33 | 188,182,701 tokens / ~$181.97 |
| Thread B: hardening + multi-tenant dev only | 0 tokens / $0.00 | 36,327,912 tokens / ~$38.94 |
| **Claude dev-only total** | **150,782,834 tokens / ~$141.33** | **224,510,613 tokens / ~$220.91** |

Excluded from Claude dev-only:

| Excluded Scope | Tokens | Cost |
|---|--:|--:|
| Public repositories engineering audit | ~33.3M | ~$44.76 |

## Codex Snapshot Detail

| Metric | Earlier Snapshot | Current Snapshot | Delta |
|---|--:|--:|--:|
| Input tokens | 72,957,804 | 109,200,611 | +36,242,807 |
| Cached input tokens | 69,659,776 | 104,683,776 | +35,024,000 |
| Uncached input tokens | 3,298,028 | 4,516,835 | +1,218,807 |
| Output tokens | 271,464 | 428,527 | +157,063 |
| Total tokens | 73,229,268 | 109,629,138 | +36,399,870 |
| Estimated Codex credits | 1,486.6 | 2,194.5 | +707.9 |
| API-equivalent cost | ~$59.46 | ~$87.78 | +$28.32 |

## Time And Work

| Metric | Earlier Codex Snapshot | Current Codex Snapshot |
|---|---|---|
| First session event | Jun 25, 2026, 12:20 CEST | Jun 25, 2026, 12:20 CEST |
| Last session event | Jun 25, 2026, 19:27 CEST | Jun 26, 2026, 10:34 CEST |
| Wall-clock span | ~7h 07m | ~22h 14m |
| Git commit span | ~6h 38m | ~13h 13m |
| Model runtime from logs | ~2h 39m | ~4h 11m |
| Commits created | 17 | 24 |

## Cost Formulas

Codex credits:

```
((input - cached_input) * 125
 + cached_input * 12.5
 + output * 750) / 1,000,000
```

Codex API-equivalent cost shown here uses `credits * $0.04`, matching the prior project
accounting. Claude cost uses Opus 4.8 standard rates from the reconciliation: fresh input
$5/M, output $25/M, with cache-write ($6.25/M) and cache-read ($0.50/M) included in the
source Claude calculation.

## Caveats

- Claude dev-only excludes the public-repositories engineering audit.
- Claude Thread B audit/dev split is time-based, so treat the split as approximate near
  the boundary.
- The two systems did overlapping but not identical work. Claude included large spec/doc
  workflows and hardening/multi-tenant dev; Codex included the build and later production
  implementation phases in its repo.
- Current snapshots can drift if more work is done in either thread after this document.
