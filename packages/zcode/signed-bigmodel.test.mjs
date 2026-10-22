// Only synthetic keys and mocked HTTP are used here. Verify the signature
// independently with the public key, rather than reproducing the signer.
import { expect, test } from "bun:test"
import { createCipheriv, createHash, createHmac, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto"
import { createSignedBigModelTransport } from "./signed-bigmodel.mjs"

const ORIGINAL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
const ULTRA = "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages"
const CONFIG = "https://zcode.z.ai/api/v1/agent/configs"
const HANDSHAKE = "https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client"
const SALT = "WD_CLIENT_SIGN_KDF_SALT"
const STATE = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: "test-key.test-secret", jwt: "test-zcode-jwt" }
const BODY = '{ "model": "GLM-5.3", "messages": [{"role":"user","content":"中文  hello"}], "stream": true }'
const json = (data, status = 200) => Response.json(data, { status })
const policy = (mapping) => ({ code: 0, data: { codingPlanSignature: { enable: true }, ...(mapping === undefined ? {} : { proxyEndpoint: { mapping } }) } })
const derive = (secret, info) => Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from(SALT), Buffer.from(info), 32))

function fixture(key = STATE.key, { aad } = {}) {
  const [id, secret] = key.split(".")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", derive(secret, "ed25519_priv"), iv)
  cipher.setAAD(Buffer.from(aad ?? id))
  const encodedDER = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  const encrypted = Buffer.concat([cipher.update(encodedDER, "utf8"), cipher.final()])
  return { publicKey, privateCipher: Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64") }
}

function vendor(options = {}) {
  const calls = [], fixtures = new Map()
  let configReply = options.config ?? policy()
  let handshakeReply = options.handshake
  let modelReply = options.model
  const send = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const call = { url, ...init, headers: new Headers(init.headers) }
    calls.push(call)
    if (url === CONFIG) return typeof configReply === "function" ? configReply(call) : json(configReply)
    if (url === HANDSHAKE) {
      if (handshakeReply) return handshakeReply(call)
      const body = JSON.parse(init.body)
      const key = call.headers.get("authorization")
      const [id, secret] = key.split(".")
      expect(body.apiKey).toBe(key)
      const expected = createHmac("sha256", derive(secret, "getSignKey_hmac")).update(`get_sign_key\n${id}\n${body.ts}\n${body.nonce}`).digest("base64")
      expect(body.sig).toBe(expected)
      const f = fixture(key)
      fixtures.set(key, f)
      return json({ code: 200, data: { privateCipher: f.privateCipher } })
    }
    if ([ORIGINAL, ULTRA, ORIGINAL + "/count_tokens", ULTRA + "/count_tokens"].includes(url))
      return modelReply ? modelReply(call) : new Response("model stream", { headers: { "content-type": "text/event-stream" } })
    throw new Error("No network in tests")
  }
  return { calls, fixtures, send, config: (reply) => { configReply = reply }, handshake: (reply) => { handshakeReply = reply }, model: (reply) => { modelReply = reply } }
}

const ask = (transport, state = STATE, opts = {}, url = ORIGINAL) => transport.fetch(url, {
  method: "POST", headers: { "content-type": "application/json", "X-Session-Id": "same-session" }, body: BODY, ...opts,
}, state)
const at = (v, url) => v.calls.filter((c) => c.url === url)

test("signed request verifies against an independent Ed25519 key and PoW check", async () => {
  const v = vendor(), transport = createSignedBigModelTransport({ fetch: v.send })
  await ask(transport)
  const c = at(v, ORIGINAL)[0], h = c.headers
  expect(c.body).toBe(BODY)
  expect(h.get("x-session-id")).toBe("same-session")
  expect(h.get("x-app-id")).toBe("zcode")
  expect(h.get("x-client-version")).toBe(h.get("x-zcode-app-version"))
  expect(h.get("x-client-nonce")).toMatch(/^[0-9a-f]{32}$/)
  const id = STATE.key.split(".")[0]
  const signed = `${id}\n${h.get("x-client-ts")}\n${h.get("x-client-version")}\n${h.get("x-session-id")}\n${h.get("x-client-nonce")}`
  expect(verify(null, Buffer.from(signed), v.fixtures.get(STATE.key).publicKey, Buffer.from(h.get("x-client-sig"), "base64"))).toBe(true)
  const seed = createHash("sha256").update(`${id}\nzcode\n${h.get("x-session-id")}\n${h.get("x-client-ts")}`).digest("hex").slice(0, 32)
  expect(createHash("sha256").update(`${seed}\n${h.get("x-client-pow")}`).digest()[0]).toBe(0)
  expect(h.get("x-zcode-authorization")).toBeNull()
  expect(at(v, CONFIG)[0].headers.get("x-api-key-id")).toBe(id)
  expect(at(v, CONFIG)[0].headers.get("x-api-key")).toBeNull()
  expect(at(v, CONFIG)[0].headers.get("authorization")).toBeNull()
  expect(v.calls.every((c) => c.redirect === "manual")).toBe(true)
})

test("trusted ultra mapping carries the requested JWT header only to ultra", async () => {
  const v = vendor({ config: policy([{ from: ORIGINAL, to: ULTRA, zcodeAuthorizationHeader: "X-Zcode-Authorization" }]) })
  const t = createSignedBigModelTransport({ fetch: v.send })
  await ask(t)
  expect(at(v, ORIGINAL)).toHaveLength(0)
  expect(at(v, ULTRA)[0].headers.get("x-zcode-authorization")).toBe("Bearer " + STATE.jwt)
  expect(v.calls.filter((c) => c.url !== ULTRA).every((c) => !c.headers.has("x-zcode-authorization"))).toBe(true)
  const withoutJWT = await ask(t, { ...STATE, jwt: undefined }, { headers: { "x-zcode-authorization": "Bearer stale-caller-token" } })
  expect(withoutJWT.status).toBe(200)
  expect(at(v, ULTRA).at(-1).headers.has("x-zcode-authorization")).toBe(false)
  expect(at(v, ULTRA)).toHaveLength(2)
})

test("malformed API keys fail before network without disclosing the rejected credential", async () => {
  for (const key of ["credential-id.secret\0tail", "credential-id.secret\r\ntail", "credential-id.secrét", "credential-id.secret\u0100"]) {
    const v = vendor()
    let error
    try { await ask(createSignedBigModelTransport({ fetch: v.send }), { ...STATE, key }) } catch (e) { error = e }
    expect(error?.message).toBe("ZCode signed Coding Plan: invalid Coding Plan credential")
    expect(String(error)).not.toContain("credential-id")
    expect(String(error)).not.toContain(key)
    expect(v.calls).toHaveLength(0)
  }
})

test("malformed JWT values never reach a model request or appear in error messages", async () => {
  for (const jwt of ["jwt-sensitive\r\nInjected: yes", "jwt-sensitive\nend", "jwt-sensitive\0end", "jwt-sensitive-é", "jwt-sensitive-\u0100"]) {
    const v = vendor({ config: policy([{ from: ORIGINAL, to: ULTRA, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) })
    let error
    try { await ask(createSignedBigModelTransport({ fetch: v.send }), { ...STATE, jwt }) } catch (e) { error = e }
    expect(error?.message).toBe("ZCode signed Coding Plan: invalid ZCode session credential")
    expect(String(error)).not.toContain("jwt-sensitive")
    expect(String(error)).not.toContain(jwt)
    expect(at(v, ORIGINAL)).toHaveLength(0)
    expect(at(v, ULTRA)).toHaveLength(0)
  }
})

test("a mapping to BigModel cannot request the ZCode JWT authorization header", async () => {
  const v = vendor({ config: policy([{ from: ORIGINAL, to: ORIGINAL, zcodeAuthorizationHeader: "X-Zcode-Authorization" }]) })
  let error
  try { await ask(createSignedBigModelTransport({ fetch: v.send })) } catch (e) { error = e }
  expect(error?.message).toBe("ZCode signed Coding Plan: authorization header requires the ZCode ultra endpoint")
  expect(at(v, HANDSHAKE)).toHaveLength(0)
  expect(at(v, ORIGINAL)).toHaveLength(0)
  expect(at(v, ULTRA)).toHaveLength(0)
})

test("a missing legacy signing flag still signs; an explicit policy change fails closed", async () => {
  const v = vendor({ config: { code: 0, data: {} } })
  await ask(createSignedBigModelTransport({ fetch: v.send }))
  expect(at(v, ORIGINAL)[0].headers.has("x-client-sig")).toBe(true)
  const stopped = vendor({ config: { code: 0, data: { codingPlanSignature: { enable: false } } } })
  await expect(ask(createSignedBigModelTransport({ fetch: stopped.send }))).rejects.toThrow()
  expect(at(stopped, ORIGINAL)).toHaveLength(0)
})

test("count_tokens stays signed at its original endpoint despite a Messages ultra mapping", async () => {
  const v = vendor({ config: policy([{ from: ORIGINAL, to: ULTRA, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) })
  await ask(createSignedBigModelTransport({ fetch: v.send }), STATE, {}, ORIGINAL + "/count_tokens")
  expect(at(v, ORIGINAL + "/count_tokens")).toHaveLength(1)
  expect(at(v, ORIGINAL + "/count_tokens")[0].headers.has("x-client-sig")).toBe(true)
  expect(at(v, ORIGINAL + "/count_tokens")[0].headers.has("x-zcode-authorization")).toBe(false)
  expect(at(v, ULTRA + "/count_tokens")).toHaveLength(0)
})

test("no mapping and an unrelated mapping keep the signed original endpoint", async () => {
  for (const cfg of [policy(), policy([]), policy([{ from: "https://api.z.ai/api/anthropic/v1/messages", to: "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages" }])]) {
    const v = vendor({ config: cfg })
    await ask(createSignedBigModelTransport({ fetch: v.send }))
    expect(at(v, ORIGINAL)).toHaveLength(1)
    expect(at(v, ORIGINAL)[0].headers.has("x-client-sig")).toBe(true)
  }
})

test("untrusted input endpoints are refused before any network request", async () => {
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send })
  for (const url of ["http://open.bigmodel.cn/api/anthropic/v1/messages", ORIGINAL + "?leak=1", ORIGINAL + "#fragment", ORIGINAL + "-evil", "https://open.bigmodel.cn:444/api/anthropic/v1/messages", "https://user@open.bigmodel.cn/api/anthropic/v1/messages", "https://evil.test/api/anthropic/v1/messages"])
    await expect(ask(t, STATE, {}, url)).rejects.toThrow()
  expect(v.calls).toHaveLength(0)
})

test("unsafe mappings fail closed, without a model request or exposed upstream text", async () => {
  for (const target of ["https://evil.test/api", "http://zcode.z.ai/api/v1/ultra/anthropic/v1/messages", ULTRA + "?token=1", "https://user@zcode.z.ai/api/v1/ultra/anthropic/v1/messages", "https://zcode.z.ai:444/api/v1/ultra/anthropic/v1/messages", "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages"] ) {
    const v = vendor({ config: policy([{ from: ORIGINAL, to: target }]) })
    await expect(ask(createSignedBigModelTransport({ fetch: v.send }))).rejects.toThrow()
    expect(at(v, ORIGINAL)).toHaveLength(0)
    expect(at(v, ULTRA)).toHaveLength(0)
  }
})

test("malformed, duplicate and unrecognized auth-header mappings are rejected", async () => {
  for (const cfg of [
    { code: 0, data: { proxyEndpoint: { mapping: {} } } },
    policy([{ from: ORIGINAL, to: ULTRA }, { from: ORIGINAL, to: ORIGINAL }]),
    policy([{ from: ORIGINAL, to: ULTRA, zcodeAuthorizationHeader: "Authorization" }]),
    { code: 500, msg: STATE.key, data: {} },
  ]) {
    const v = vendor({ config: cfg })
    let error
    try { await ask(createSignedBigModelTransport({ fetch: v.send })) } catch (e) { error = e }
    expect(error).toBeDefined()
    expect(String(error)).not.toContain(STATE.key)
    expect(at(v, ORIGINAL)).toHaveLength(0)
    expect(at(v, ULTRA)).toHaveLength(0)
  }
})

test("configuration and handshake redirects cannot carry credentials to another host", async () => {
  for (const phase of ["config", "handshake"]) {
    const v = vendor({ [phase]: () => new Response("", { status: 302, headers: { location: "https://evil.test" } }) })
    await expect(ask(createSignedBigModelTransport({ fetch: v.send }))).rejects.toThrow()
    expect(at(v, ORIGINAL)).toHaveLength(0)
    expect(v.calls.every((c) => c.redirect === "manual")).toBe(true)
  }
})

test("invalid Base64, wrong AAD and corrupt authentication tags reject the handshake", async () => {
  const wrongAAD = fixture(STATE.key, { aad: "someone-else" }).privateCipher
  const broken = Buffer.from(fixture().privateCipher, "base64"); broken[broken.length - 1] ^= 1
  for (const privateCipher of ["!not-base64!", wrongAAD, broken.toString("base64")]) {
    const v = vendor({ handshake: () => json({ code: 200, data: { privateCipher } }) })
    await expect(ask(createSignedBigModelTransport({ fetch: v.send }))).rejects.toThrow()
    expect(at(v, ORIGINAL)).toHaveLength(0)
  }
})

test("concurrent requests share policy and key handshakes, but have fresh nonces", async () => {
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send })
  await Promise.all([ask(t), ask(t), ask(t)])
  expect(at(v, CONFIG)).toHaveLength(1)
  expect(at(v, HANDSHAKE)).toHaveLength(1)
  expect(at(v, ORIGINAL)).toHaveLength(3)
  expect(new Set(at(v, ORIGINAL).map((c) => c.headers.get("x-client-nonce"))).size).toBe(3)
})

test("different accounts and a changed key never reuse signing material", async () => {
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send })
  await ask(t)
  await ask(t, { ...STATE, key: "second.second-secret" })
  await ask(t, { ...STATE, key: "test-key.rotated-secret" })
  expect(at(v, HANDSHAKE)).toHaveLength(3)
  expect(new Set(at(v, HANDSHAKE).map((c) => c.headers.get("authorization"))).size).toBe(3)
})

test("route and private-key TTLs expire independently", async () => {
  let now = Date.now()
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send, now: () => now, policyTtlMs: 50, keyTtlMs: 100 })
  await ask(t)
  now += 60; await ask(t)
  expect(at(v, CONFIG)).toHaveLength(2)
  expect(at(v, HANDSHAKE)).toHaveLength(1)
  now += 60; await ask(t)
  expect(at(v, HANDSHAKE)).toHaveLength(2)
})

test("a failed handshake is not cached and never falls back unsigned", async () => {
  let fail = true
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send })
  v.handshake(() => fail ? json({ code: 500, msg: STATE.key }) : json({ code: 200, data: { privateCipher: fixture().privateCipher } }))
  let error
  try { await ask(t) } catch (e) { error = e }
  expect(error).toBeDefined()
  expect(String(error)).not.toContain(STATE.key)
  expect(at(v, ORIGINAL)).toHaveLength(0)
  fail = false; await ask(t)
  expect(at(v, HANDSHAKE)).toHaveLength(2)
  expect(at(v, ORIGINAL)).toHaveLength(1)
})

test("401 is returned once; only the next request refreshes its signing key", async () => {
  let first = true
  const v = vendor({ model: () => first ? (first = false, new Response("denied", { status: 401 })) : new Response("ok") })
  const t = createSignedBigModelTransport({ fetch: v.send })
  const denied = await ask(t)
  expect(denied.status).toBe(401)
  expect(await denied.text()).toBe("denied")
  expect(at(v, ORIGINAL)).toHaveLength(1)
  expect(at(v, HANDSHAKE)).toHaveLength(1)
  expect((await ask(t)).status).toBe(200)
  expect(at(v, HANDSHAKE)).toHaveLength(2)
})

test("success stream is delivered without reading or buffering its body", async () => {
  let controller
  const stream = new ReadableStream({ start(c) { controller = c } })
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  const v = vendor({ model: () => response })
  const result = await ask(createSignedBigModelTransport({ fetch: v.send }))
  expect(result.bodyUsed).toBe(false)
  expect(stream.locked).toBe(false)
  controller.enqueue(new TextEncoder().encode("data: first\n\n"))
  const reader = result.body.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
  controller.close()
  expect((await reader.read()).done).toBe(true)
})

test("one cancelled waiter does not cancel another request's shared handshake", async () => {
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const f = fixture()
  const v = vendor({ handshake: async () => { entered(); await gate; return json({ code: 200, data: { privateCipher: f.privateCipher } }) } })
  const t = createSignedBigModelTransport({ fetch: v.send })
  const abort = new AbortController()
  const cancelled = ask(t, STATE, { signal: abort.signal }).then(() => "unexpected success", () => "cancelled")
  await started
  const kept = ask(t)
  abort.abort(); release()
  expect(await cancelled).toBe("cancelled")
  expect((await kept).status).toBe(200)
  expect(at(v, HANDSHAKE)).toHaveLength(1)
  expect(at(v, ORIGINAL)).toHaveLength(1)
})

test("an already-cancelled request performs no network operation", async () => {
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send })
  await expect(ask(t, STATE, { signal: AbortSignal.abort() })).rejects.toThrow()
  expect(v.calls).toHaveLength(0)
})

test("bounded account cache evicts old material, and clear removes all material", async () => {
  const v = vendor(), t = createSignedBigModelTransport({ fetch: v.send, maxAccounts: 1 })
  await ask(t)
  await ask(t, { ...STATE, key: "other.secret" })
  await ask(t)
  expect(at(v, HANDSHAKE)).toHaveLength(3)
  t.clear(); await ask(t)
  expect(at(v, HANDSHAKE)).toHaveLength(4)
})
