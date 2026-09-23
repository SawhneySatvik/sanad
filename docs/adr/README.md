# Architecture decision records

Short records of the decisions that shape this codebase. Each one covers the context, the decision
and its consequences, including the gaps it deliberately accepts. The code is the final authority.
Each record links to the files that implement it.

| # | Decision | Area |
|---|---|---|
| [0001](0001-branded-verify-result.md) | Only `verify()` can issue a verification result, and each result is bound to its quote and document | Verification |
| [0002](0002-token-boundary-matching.md) | `verified` requires an exact match on token boundaries, under a small fixed normalization set | Verification |
| [0003](0003-reverify-on-every-read.md) | Stored statuses are audit fields; every read re-verifies against the live canonical text | Verification |
| [0004](0004-native-document-cap.md) | Scanned documents can never reach `verified` | Verification |
| [0005](0005-three-tier-rate-limiting.md) | Three rate-limit tiers: per principal per LLM call, per IP, and global per provider | Abuse and cost |
| [0006](0006-provider-schema-sanitization.md) | The model schema carries no status, providers see a sanitized schema, and over-long output is trimmed | LLM layer |
| [0007](0007-flat-fallback-chain.md) | One flat fallback chain under one deadline, with a circuit breaker per tier | LLM layer |
| [0008](0008-hybrid-compare.md) | Compare is hybrid: deterministic clause alignment, one LLM call to explain | Features |
| [0009](0009-identity-and-authorization.md) | Identity comes only from a signed cookie; every access goes through one chokepoint; foreign resources are 404 | Security |
| [0010](0010-guest-data-lifecycle-and-claim.md) | Guest data expires on a TTL, guest threads stay client-side, and claim locks in the sweep's order | Data lifecycle |
| [0011](0011-test-architecture.md) | Tests live in a dedicated tree, fakes sit only at the SDK boundary, and live validation is separate | Testing |

The system-level view is in [the architecture document](../ARCHITECTURE.md). It includes the One
Guarantee and the table of channels it holds across.
