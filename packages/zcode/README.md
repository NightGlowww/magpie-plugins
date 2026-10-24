# @magpie-community/opencode-zcode-auth

Signs in to Z.ai's GLM Coding Plan, or BigModel's (智谱). It does this the
way [ZCode](https://zcode.z.ai) does, and serves the plan's GLM models
over Anthropic's Messages API. Provider id: `zcode`.

## This fork: signed BigModel Coding Plan requests

This fork adds the ZCode client signing and endpoint routing used by our
validated LiteLLM adapter, with the routing header behavior checked against
ZCode 3.16.2. It applies to **paid BigModel requests**, including a personal
key or a team key. It also includes upstream ZCode 0.1.26: Start Plan
compatibility, Claude Code tool search, clearer gift allowance cards and
recovery of Trial entries after transient catalog or balance failures.
No LiteLLM service or Python runtime is needed.

The fork version is `0.1.26+zcode.signed.3`. The `+` suffix is build metadata,
so Magpie's migration check treats it as compatible with the upstream
`0.1.26` release. A `-zcode-signed.1` suffix would instead mark a pre-release
and incorrectly leave migration blocked even when model calls work.

Before sending a paid BigModel request, the plugin:

- Reads ZCode's endpoint policy using the key ID, without sending the
  complete API key to that configuration endpoint. An absent mapping keeps
  BigModel's original endpoint; a matching mapping can select only ZCode's
  `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages` endpoint.
- Gets an encrypted temporary Ed25519 signing key using the Coding Plan
  credential, then sends ZCode's version, session, nonce, signature and PoW
  headers. The signing identity is pinned to the verified version 3.16.2.
- Adds `X-ZCode-Authorization` only to the recognized ultra endpoint when
  the mapping requests it and this account already has a ZCode JWT. Like
  ZCode, a pure API-key account without a JWT still sends the signed
  request; no other account's token is borrowed.

The signing transport preserves the body it receives. Before signing,
the plugin applies the ToolSearch compatibility mapping described below;
other request bodies and streamed responses are preserved. A caller's
`X-Session-Id` is kept; without one, a fresh ID is generated for that
request. Successful endpoint policies are cached for five minutes and
signing keys for thirty minutes, separately for each credential. A 401
invalidates that credential's signing key for the **next** request. The
current response is returned without replaying the model call.

Signing and routing fail closed: an unrecognized endpoint, malformed
policy or failed handshake stops the request. Redirects are not followed.
There is no unsigned retry or automatic switch to another plan. The
official client's optional unsigned fallback is intentionally not ported.
An explicit disabled legacy signing policy also stops the request; an
absent legacy flag does not disable signing.

Claude Code's exact `?beta=true` flag is removed from the original
BigModel Messages and count-token request URLs before the signed
transport checks them. Other queries, altered routes and endpoint-policy
URLs retain the existing strict validation.

The signed transport uses only Node built-ins and is included in the
package as `signed-bigmodel.mjs`. This is a model API adapter, not the
ZCode Agent runtime. Successful signed requests do not establish any
particular billing discount or additional allowance. See
[the verification record](docs/signed-bigmodel-verification.md) for the
tested scope and installation state.

## Claude Code tool search

Upstream 0.1.24 fixes ZCode plans hiding ordinary tools such as Bash,
Read, Write and Agent when a request includes a tool named `ToolSearch`.
The plugin sends that tool as `ToolSearchTool`, including its historical
calls and explicit tool choice, and restores its name in JSON and
streamed replies. Schemas already provided by the caller are sent without
`defer_loading`; `DeferredToolPlaceholder` is removed. Deferred tools are
still discovered and executed by the caller. Requests without ToolSearch,
or with a tool already named ToolSearchTool, pass through unchanged.

This compatibility layer applies before paid signing and Start Plan
wrapping. An explicit Trial request still spends only its gift and never
falls back to the paid plan.

## Signing in

- **ZCode: Z.ai GLM Coding Plan** and **ZCode: BigModel (智谱) GLM Coding Plan**
  - zcode.z.ai opens a sign-in flow, and the browser signs in to Z.ai or to
    BigModel. The plugin polls the flow until it is done, so there is
    nothing to paste.
  - With that sign-in it takes the key named `zcode-api-key` from the
    account's default project, or makes it if it isn't there, as ZCode does.
    Z.ai requests go to `api.z.ai/api/anthropic`. Paid BigModel requests
    use `open.bigmodel.cn/api/anthropic` or the recognized ZCode ultra
    mapping described above.
  - If the account has no plan of its own, it looks for a seat on a team's
    plan and uses that team project's `zcode-team-api-key`.
  - Failing both, it uses ZCode's free **Start Plan**, served by zcode.z.ai
    with ZCode's session token.
  - zcode.z.ai serves the Start Plan only to requests that look like the
    ZCode client's own, and refuses others with HTTP 405 "request has been
    blocked due to unusual activity". So a Start Plan request goes as
    ZCode's does: three system blocks, with the agent's system text joined
    into the third (an extra fourth block causes 405/3012; upstream #343).
    It constructs ZCode 3.16.3's headers without forwarding the caller's
    headers or URL query, then puts the day in a `<system-reminder>` turn before the agent's
    turns, and the sign-in's device id in `metadata.user_id`. GLM Coding
    Plan and team request bodies go as the agent sent them. One it still turns
    away (a 405, the block page or code 3012) comes back with what to do
    about it, as magpie's built-in said: "ZCode's Start Plan still turned
    this request away, though magpie sends it as the ZCode app does; …
    Use an account with a GLM Coding Plan, or add another provider to this
    group".
  - The Start Plan's token can't be refreshed. When it runs out, sign in
    again.
- **ZCode: a team's GLM Coding Plan**
  - For an account with a plan of its own and a seat on a team's plan
    (#285). The sign-ins above take the account's own plan, as ZCode does
    by default; this one asks which site, signs in the same way, and
    takes the team seat's `zcode-team-api-key`, as ZCode does when its
    plan picker is switched to the team's plan.
  - It is kept as an account of its own, named `<email> (team)`, beside
    the account's own plan, so both can be used.
  - With no seat on a team's plan, it says so and signs in to nothing.
- **ZCode app's sign-in**
  - Uses the account the ZCode app on this computer is signed in to. For
    every request it reads ZCode's own credentials (`~/.zcode/v2`), so it
    follows ZCode as it signs in again, renews its session or switches to a
    team's plan, but only while ZCode is signed in to that same account.
    Once ZCode signs out, or signs in to another account, the sign-in uses
    what it saved when it was added; when that session has run out, it
    asks to be signed in again. It never sends one account's requests with
    another's credentials: to use both, add the app's sign-in once for each.
- **GLM Coding Plan API key**
  - Paste a key (`<id>.<secret>`) and say which site it is from.
  - A key reaches the GLM Coding Plan alone. ZCode's gift plans (the
    Start Plan, ZCode 1024 Dev Day) are served to ZCode's own session,
    which a key doesn't carry: for an account with only a gift plan, the
    card and each refused request (1113) say to sign in with ZCode
    instead. For an account with a GLM Coding Plan, the card says the
    gift plans' `-Trial` models need ZCode's sign-in, since a key lists
    none of them.

## Where the sign-in is kept

In OpenCode's `auth.json` (magpie: `plugin-auth.json`), under `zcode`:

- **The browser sign-ins** are kept as an `oauth` entry:
  - `access` is the key.
  - `refresh` is JSON holding the site, the endpoint, the key, ZCode's
    token, the team project, the plan and a device id of this plugin's own.
- **A pasted key** is kept as an `api` entry, with the site in `metadata`.

The plugin never writes ZCode's own credential store. It reads it only for
the ZCode app's sign-in (`refresh` then holds `"source": "zcode"`).

## How requests are routed

Before each request, the plugin checks which plan the account is on, and
asks again every 10 minutes:

- If the key's account has a GLM Coding Plan
  (`/api/biz/subscription/list`), its requests go to that plan. A model
  the account's gift plans also serve is listed again as
  `<model>-Trial`; asking that entry spends the gift (see below).
- Otherwise they go to the gift plans.

Coding Plan requests carry the key as both `x-api-key` and
`Authorization: Bearer`. Start Plan requests carry the account's ZCode
session token as Bearer authentication.

**The gift's trial entries.** An account with a GLM Coding Plan can
also hold gift plans from ZCode activities, ones that expire on a fixed
date. Their allowance would lapse unused if every request went to the
coding plan, so the plugin reads the gift's balance (per the sign-in's
session, kept for 10 minutes) and lists every model a live bucket
serves again as `<model>-Trial`, named in the catalog's spelling
(GLM-5.3-Flash-Trial). Asking a trial entry sends the model to the
gift, dressed as ZCode's own; asking the plain model spends the coding
plan — the choice is the user's. A bucket is judged spent only by its
`remaining_units` — a missing one is unknown, not spent. A trial entry
whose bucket is spent or blocked answers 429 without touching the
coding plan; when the gift answers a trial entry with a quota error
(code 1113 "Insufficient balance or no resource package", code 1005
"exceed quota limit", which it can answer inside an HTTP 200) that too
becomes a 429 and keeps the entry off for a minute. Any other gift
answer (its 405, its 401, its 5xx) goes on as it came: the user picked
the gift, so the coding plan is not spent behind their back. Every 429
counts as spent, Z.ai's 1302/1303 rate limits among them. A stream's
body is never read or buffered on the way.

## The usage card

An account with both plans shows both allowances: the coding plan's
windows first, then the gift's buckets, each with its own name, models
and end. The card's plan and term stay the coding plan's. A gift read
that fails leaves just the coding card — magpie hides a card's windows
behind an error, so a gift hiccup must not black out a working Coding
Plan. A gift that goes out of date while requests use it simply stops
showing.

**Resets.** A GLM Coding Plan of the account's own, and a team seat,
show the resets the vendor's usage page lists
(`/api/biz/customer-package-reset/list`, `targetType=PERSONAL` with the
plan's key, `TEAM` with the team's sign-in): how many of the five hours
and of the week are still available, and when each runs out, soonest
first. A team's are marked a team's. They are only read; a reset is
spent on the vendor's own page. A list that can't be read, or has none
left, shows no count.

**Gift plans ZCode holds but has not granted.** ZCode hands out one-off
trust-build / gift plans (a day's ZCode Trust Build, say) that are not
on the account until the ZCode app claims them. The plugin reads the
app's own list of them (`GET /api/v1/zcode-plan/billing/preview`) with
the card and names them there — the window is named "Gift plans to
claim in the ZCode app" and the display shows "1 · ZCode Trust Build"
— set aside, so the line stops nothing and routing, usage caps and the
menu bar pass it over. The name is a fixed sentence magpie can
translate; the count and the plan's own name are the display. The plugin never claims one: the claim needs the
Aliyun captcha attestation only the app's renderer can make. A preview
that fails, or lists nothing, adds no line at all, and a card that is an
error keeps its error. Claim the plan in the ZCode app (open it once);
the next read shows it as an ordinary gift bucket.

**No ZCode session.** A card read with a key, or with a sign-in whose
ZCode session has run out (it can't be renewed), sets aside a line named
"ZCode gift plans (-Trial models) need ZCode's sign-in", with why in its
display: such an account reads no gift and lists no `-Trial` entries.
Sign in again with ZCode to get them back. A gift read that fails
otherwise is asked again a minute later, not ten.

## Models

The models are the ones ZCode offers for the account's plan. They come
from ZCode's provider config: the release zcode.z.ai names, or an
installed ZCode's copy if that one is newer. The list is kept for 10
minutes. When the config can't be read, the plugin falls back to this list
(and magpie keeps the list it was told last, unless the account's gift
plans add `-Trial` entries, which are told as read):

| Model | Context | Output | Efforts |
|---|---|---|---|
| GLM-5.3 | 1M | 128K | low, high, max |
| GLM-5.3-Flash | 1M | 128K | low, high, max |
| GLM-5.2 | 1M | 128K | none, high, max |
| GLM-5-Turbo | 200K | 64K | none, high |

The Start Plan's config has all of these except GLM-5.3. An account
with no GLM Coding Plan also lists every model its gift plans serve under
the model's own name, as ZCode does (the Start Plan's GLM-5.3 bucket makes
GLM-5.3 a model), since all of its requests go to the gift anyway.

A gift plan's models appear again as `<model>-Trial` entries, so a
request can spend the gift's quota on purpose. A trial entry is listed
while any live bucket serves its model, spent buckets included (a spent
entry answers 429 rather than vanishing mid-session).

Two plans can give one model (ZCode Trust Build and the Start Plan both
give GLM-5.3-Flash). The server picks the bucket, so the usage card
counts the model on its live bucket, the least used, and sets a spent
sibling aside. A spent sibling never makes the model, or the account,
look used up while another bucket still has quota.
