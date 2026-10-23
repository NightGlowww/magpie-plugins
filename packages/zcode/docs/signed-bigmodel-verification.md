# Signed BigModel transport verification

Paid transport verified on 2026-10-22 with `0.1.20+zcode.signed.1`.
Current fork version: `0.1.22+zcode.signed.2`; the paid signing transport
is unchanged. This version also incorporates upstream's Start Plan fixes
`44036e2` and `57ec655` (system blocks, header isolation and query removal).
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
Agent equivalence. The signed fork was subsequently deployed to Magpie on
2026-10-22. The checks above do not establish Start Plan acceptance.

## Start Plan compatibility, 2026-10-24

The old fork reproduced HTTP 405 / code 3012 for a real
`GLM-5.3-Flash-Trial` request with a caller system prompt. Its outbound
request had four system blocks, caller-specific headers and `?beta=true`.
Upstream [issue #343](https://github.com/magpie-community/plugins/issues/343)
and commits [44036e2](https://github.com/magpie-community/plugins/commit/44036e2fccc3c8c9884214ced96a51e47a2a880a)
and [57ec655](https://github.com/magpie-community/plugins/commit/57ec655a24c1342435cd343795ce2783f466a595)
provide the fixes incorporated here. Caller system texts now remain in the
third system block, and the Start Plan request gets a fresh header set and
no URL query. No paid signing changes or paid fallback were added.

The isolated updated plugin passed real streaming text, tool call and
tool-result continuation checks for **both GLM-5.3-Trial and
GLM-5.3-Flash-Trial**. All six successful requests reached the actual
`/api/v1/zcode-plan/anthropic/v1/messages` path, had three system blocks,
and completed their streams. Tool arguments and the returned synthetic
verification tokens matched. Flash emitted thinking in the tool-call
turn, which was replayed; GLM-5.3 emitted no thinking in that check.

One initial Flash probe incorrectly disabled thinking and received 400 /
1210: this model requires thinking. The final probes enabled thinking;
this probe correction is not a plugin code change. A 512-token GLM-5.3
probe reached the model but ended at its output cap; successful acceptance
used a 4096-token cap and required `end_turn` and the expected output.

The isolated suite passed **120 tests / 754 assertions**, including the
new upstream system-block and caller-header regressions and all existing
signed transport tests. Production gateway and desktop verification are
recorded separately by the deployment workspace; isolated API success
does not establish client acceptance or any billing entitlement.
