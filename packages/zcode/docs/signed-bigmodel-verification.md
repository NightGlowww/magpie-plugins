# Signed BigModel transport verification

Verified on 2026-10-22. Current fork version: `0.1.20+zcode.signed.1`.
Upstream base: `7fdc07f15097ad06d8d03076b4f653ab42c687f9`.

The original `0.1.20-zcode-signed.1` label sorted below Magpie's `0.1.20`
migration minimum. It was corrected to build metadata (`+zcode.signed.1`)
without changing the transport. Model-call success alone does not verify
Magpie's migration state; deployment must also confirm that native migration
finishes and the UI's pending-migration warning disappears.

The fork's plugin entry point was loaded directly in a separate Node process
with an existing ZCode BigModel account. This exercised the plugin's own
plan selection, credential loader, new signing transport and real upstream
API. It did not replace the plugin in the running Magpie app.

## Automated checks

```sh
bun run test:zcode
bun scripts/check.mjs zcode
node --check packages/zcode/signed-bigmodel.mjs
git diff --check
```

The ZCode suite passed **117 tests with 680 assertions**. The runner mocks
`node:os`'s `homedir()` to a new temporary directory and blocks external
network requests. It leaves the real `HOME` environment variable unchanged
and removes its temporary directory afterwards.

Coverage includes independent Ed25519 verification and PoW checks; encrypted
signing-key decoding; account isolation; concurrent preparation; TTLs;
401 invalidation without replay; cancellation; endpoint and redirect
restrictions; JWT destination restrictions; malformed-credential error
redaction; byte-preserving bodies and unbuffered streams. Existing login,
model, usage, team, gift and Start Plan tests also pass. A Messages mapping
does not invent an ultra `count_tokens` endpoint: count-token requests keep
the original BigModel endpoint and never receive a ZCode JWT.

## Real upstream checks

Every request below reached:

`https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`

The isolated fetch boundary confirmed the presence of the client signature,
PoW and this account's JWT, client version `3.16.2`, and `redirect: manual`.
No credential values, signatures, request bodies or model replies were
retained in this record.

| Model | Check | HTTP | Terminal reason | Seconds |
|---|---|---|---|---|
| GLM-5.3-Flash | Initial streaming smoke check | 200 | end_turn | 4.420 |
| GLM-5.3 | Streaming tool call | 200 | tool_use | 4.333 |
| GLM-5.3 | Replay with synthetic tool result | 200 | end_turn | 3.389 |
| GLM-5.3-Flash | Streaming tool call | 200 | tool_use | 5.200 |
| GLM-5.3-Flash | Replay with synthetic tool result | 200 | end_turn | 4.029 |
| GLM-5.3-Flash | Final non-streaming check after entry-point error hardening | 200 | end_turn | 3.424 |

All streams reached `message_stop`. Both tool calls had the expected tool
name and argument, and both continuation replies returned the randomly
generated verification code from their tool result. Each pair retained
the caller's session ID. Request bodies at the outbound fetch boundary
matched the bytes passed into the plugin.

The live tool replies emitted no thinking blocks, so this run does not
claim a positive live thinking-replay check. The transport preserves stream
bytes in its automated tests. Images, long context, parallel tool calls,
real team accounts, pure API-key accounts without a JWT, and live
`count_tokens` requests were not tested. Z.ai and free/trial paths have
regression coverage but were not exercised against live accounts here.

These results establish that the fork's signed BigModel model transport is
usable. They do not prove billing discounts, extra allowance, or full ZCode
Agent equivalence. Production Magpie adoption is a separate deployment
step; the running app still uses its previously installed plugin.
