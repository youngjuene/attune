# Content format

attune loads one versioned JSON manifest before enabling the usable workflow. Runtime URLs are resolved from the final manifest response URL, never from the page URL. The committed fixture remains authoritative until the real-content gates close.

## Manifest envelope

The top level contains `schemaVersion: "1.0"`, `collection`, optional `map`, and `recordings`. Collection IDs use `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Titles and optional descriptions are trimmed. `defaultSpatialRadiusM` is limited to `1.5` through `8.0`. Map scale is `"log"` or `"linear"`; `maxDistanceM`, when present, is finite and positive.

Unknown envelope, collection, map, record, and location fields are stripped with deterministic warnings. An invalid envelope rejects the collection. Invalid records are reported independently at runtime, and accepted records preserve input order.

## Recording records

Each record requires a unique URL-safe `id`, nonempty `title`, `audioUrl`, finite latitude/longitude in their legal ranges, and `spatialFormat: "point-source"`. Supported optional fields are `mimeType`, `durationSec`, `recordedAt`, `description`, `tags`, `gainDb`, and `credit`.

String fields use JavaScript Unicode whitespace trimming except IDs, which are never trimmed or case-normalized. Limits are measured in Unicode code points: title 120, URL 2,048, MIME type 100, description 1,000, credit 200, each tag 40, and no more than 20 supplied tags. Empty and later exact duplicate tags are removed with warnings. Finite gain is clamped to `[-24, 6]` with a warning; a non-finite gain rejects the record.

Audio URLs may be HTTPS. Same-origin HTTP is limited to `localhost`, `::1`, or `127.0.0.0/8` development origins. Relative URLs are resolved from the manifest response, so the fixture manifest at `public/content/recordings.json` correctly refers to `../audio/test-tone.wav`.

## Validation commands

Run `npm run validate:content` to validate committed content. It writes `artifacts/content-validation.json` atomically with sorted keys, stable arrays, two-space LF JSON, a final newline, and no timestamp. It exits nonzero for envelope errors, rejected records, duplicates, missing/unsafe local files, a modified canonical WAV, or an empty accepted set. External HTTPS audio is not fetched and receives `EXTERNAL_AUDIO_NOT_FILE_CHECKED`.

`npm run adapt:content` is a dry-run by default; `npm run adapt:content -- --write` selects write mode. Both currently exit `2` with the G-01 gate message because no representative source metadata or approved mapping has been supplied. `adaptSourceMetadata` is nevertheless a concrete exported adapter boundary. Do not replace the fixture or infer source fields until that mapping is approved. G-02 separately requires the real audio codec, channel-layout, and point-source-suitability audit.
