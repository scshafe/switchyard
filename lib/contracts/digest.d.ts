export declare function canonicalJson(value: unknown): string;
/**
 * INTERNAL object-canonical digest. `digest(value)` ALWAYS hashes the canonical
 * JSON of `value` — including a bare `string`, which is hashed as its JSON-quoted
 * form (`"…"`), NOT as its raw UTF-8 bytes.
 *
 * A3 (reconciliation H-1): the earlier Phase-1 raw-string exception
 * (`typeof value === "string" ? value : …`) is REVERTED. Inbox never recomputes a
 * raw-body digest across the cross-repo boundary through `digest()`, so the
 * exception bought no cross-repo benefit; meanwhile it silently CHURNED persisted
 * LIVE ingest content digests (`contentDigest = digest(sourceText)` etc.), because
 * every such value moved from `sha256("\"…\"")` to `sha256("…")`. Reverting keeps
 * `digest()` a single, stable object-canonical rule.
 *
 * For any cross-repo raw-string / raw-body digest, use {@link rawBodyDigest} — it
 * is the ONE function that implements the package raw-string rule (bytes, no JSON
 * quoting). Do NOT reach for `digest(someString)` to match a raw-body hash.
 */
export declare function digest(value: unknown): string;
/**
 * The ONLY function to use for a cross-repo raw-string / raw-body digest:
 * `sha256(utf8(s))` — the bytes of `s`, with NO JSON quoting or escaping. This
 * matches the shared execution-contracts raw-string rule and JobTrack's raw-body
 * hashing exactly, so a body/string digested here is byte-identical across repos.
 *
 * This is deliberately SEPARATE from {@link digest}: `digest()` is the internal
 * object-canonical rule (a bare string is JSON-quoted); `rawBodyDigest()` is the
 * raw-bytes rule. Keeping them distinct means the raw-string behavior is explicit
 * at every call site and can never silently leak into object digests.
 */
export declare function rawBodyDigest(s: string): string;
