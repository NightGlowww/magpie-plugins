// Exercise the installed-plugin interface, including the free/paid decision.
// All credentials and responses are synthetic and fetch is replaced below.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { createCipheriv, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

const ORIGINAL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
const ZAI = "https://api.z.ai/api/anthropic/v1/messages"
const ULTRA = "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages"
const START = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
const CONFIG = "https://zcode.z.ai/api/v1/agent/configs"
const HANDSHAKE = "https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client"
const KEY = "integration.secret"
const BODY = '{ "model": "GLM-5.3", "messages": [{"role":"user","content":"original  body"}], "stream": true }'
const JWT = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const real = globalThis.fetch
let ZCodeAuthPlugin, _internal
const calls = []
let configStatus = 200

beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with the isolated homedir preload")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})

function privateCipher(key) {
  const [id, secret] = key.split(".")
  const { privateKey } = generateKeyPairSync("ed25519")
  const iv = randomBytes(12)
  const k = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("WD_CLIENT_SIGN_KDF_SALT"), Buffer.from("ed25519_priv"), 32))
  const c = createCipheriv("aes-256-gcm", k, iv)
  c.setAAD(Buffer.from(id))
  const plaintext = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  return Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]).toString("base64")
}

beforeEach(() => {
  calls.length = 0; configStatus = 200
  _internal.routes.clear(); _internal.blocked.clear()
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const c = { url, ...init, headers: new Headers(init.headers) }; calls.push(c)
    if (url === CONFIG) return Response.json({ code: 0, data: { codingPlanSignature: { enable: true }, proxyEndpoint: { mapping: [{ from: ORIGINAL, to: ULTRA }] } } }, { status: configStatus })
    if (url === HANDSHAKE) return Response.json({ code: 200, data: { privateCipher: privateCipher(JSON.parse(init.body).apiKey) } })
    if (url.endsWith("/api/biz/subscription/list")) return Response.json({ code: 0, data: [{ status: "VALID", productName: "GLM Coding Pro" }] })
    if (url.includes("/api/v1/zcode-plan/billing/balance")) {
      const now = Math.floor(Date.now() / 1000)
      return Response.json({ code: 0, data: { server_time: now, plans: [{ plan_id: "gift", status: "active", ends_at: now + 3600, name: "Gift" }], balances: [{ plan_id: "gift", capabilities: ["model:glm-5.3-flash"], remaining_units: 10, total_units: 10, expires_at: now + 3600 }] } })
    }
    if ([ORIGINAL, ZAI, ULTRA, START].includes(url)) return new Response("data: untouched\n\n", { headers: { "content-type": "text/event-stream" } })
    throw new Error("No network in tests")
  }
})
afterEach(() => { globalThis.fetch = real })

async function loader(auth) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.loader(async () => auth, { id: "zcode" })
}
const oauth = (state) => ({ type: "oauth", access: state.key || state.jwt, refresh: JSON.stringify(state), expires: 0 })
const modelCalls = () => calls.filter((c) => [ORIGINAL, ZAI, ULTRA, START].includes(c.url))

test("BigModel API-key loader signs both string and Request inputs without rewriting the body", async () => {
  const opts = await loader({ type: "api", key: KEY, metadata: { site: "bigmodel" } })
  for (const asRequest of [false, true]) {
    const init = { method: "POST", headers: { "content-type": "application/json", "x-session-id": "same-session" }, body: BODY }
    const res = asRequest ? await opts.fetch(new Request(ORIGINAL, init)) : await opts.fetch(ORIGINAL, init)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
    expect(await res.text()).toBe("data: untouched\n\n")
    const sent = modelCalls().at(-1)
    expect(sent.url).toBe(ULTRA)
    expect(sent.body).toBe(BODY)
    expect(sent.headers.has("x-client-sig")).toBe(true)
    expect(sent.headers.get("x-session-id")).toBe("same-session")
  }
})

test("BigModel team seat with an existing key also uses the signed transport", async () => {
  const state = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: KEY, jwt: JWT, org: "team", project: "project" }
  const opts = await loader(oauth(state))
  await opts.fetch(ORIGINAL, { method: "POST", body: BODY })
  expect(modelCalls()).toHaveLength(1)
  expect(modelCalls()[0].url).toBe(ULTRA)
  expect(modelCalls()[0].headers.has("x-client-sig")).toBe(true)
})

test("Z.ai paid key retains the existing unsigned path", async () => {
  const opts = await loader({ type: "api", key: KEY, metadata: { site: "zai" } })
  await opts.fetch(ZAI, { method: "POST", body: BODY })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(ZAI)
  expect(calls[0].body).toBe(BODY)
  expect(calls[0].headers.has("x-client-sig")).toBe(false)
})

test("BigModel Start Plan retains JWT and prompt wrapping without a signing handshake", async () => {
  const opts = await loader(oauth({ site: "bigmodel", jwt: JWT, device: "start-device", plan: "Start Plan" }))
  await opts.fetch(ORIGINAL, { method: "POST", body: BODY })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(START)
  expect(calls[0].headers.get("authorization")).toBe("Bearer " + JWT)
  expect(calls[0].headers.has("x-client-sig")).toBe(false)
  const body = JSON.parse(calls[0].body)
  expect(body.system.length).toBeGreaterThan(0)
  expect(body.messages).toHaveLength(2)
})

test("BigModel Trial spends only the gift and never enters the signed paid transport", async () => {
  const opts = await loader(oauth({ site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: KEY, jwt: JWT, device: "gift-device", plan: "GLM Coding Pro" }))
  await opts.fetch(ORIGINAL, { method: "POST", body: JSON.stringify({ model: "GLM-5.3-Flash-Trial", messages: [{ role: "user", content: "gift only" }] }) })
  expect(calls.some((c) => c.url === CONFIG || c.url === HANDSHAKE)).toBe(false)
  expect(modelCalls()).toHaveLength(1)
  expect(modelCalls()[0].url).toBe(START)
  expect(JSON.parse(modelCalls()[0].body).model).toBe("glm-5.3-flash")
})

test("signed BigModel setup failure never sends an unsigned paid request", async () => {
  configStatus = 503
  const opts = await loader({ type: "api", key: KEY, metadata: { site: "bigmodel" } })
  await expect(opts.fetch(ORIGINAL, { method: "POST", body: BODY })).rejects.toThrow()
  expect(modelCalls()).toHaveLength(0)
})

test("BigModel plugin rejects malformed API keys before header construction can disclose them", async () => {
  for (const key of ["id.SYNTHETIC_SECRET\r\nInjected: yes", "id.SYNTHETIC_SECRET\0tail", "id.SYNTHETIC_SECRET-é", "id.SYNTHETIC_SECRET-\u0100"]) {
    const opts = await loader({ type: "api", key, metadata: { site: "bigmodel" } })
    let error
    try { await opts.fetch(ORIGINAL, { method: "POST", body: BODY }) } catch (e) { error = e }
    expect(error?.message).toBe("ZCode signed Coding Plan: invalid Coding Plan credential")
    expect(String(error)).not.toContain("SYNTHETIC_SECRET")
    expect(calls).toHaveLength(0)
  }
})

test("BigModel plugin sanitizes malformed caller Authorization headers without network access", async () => {
  const opts = await loader({ type: "api", key: KEY, metadata: { site: "bigmodel" } })
  let error
  try {
    await opts.fetch(ORIGINAL, {
      method: "POST", body: BODY,
      headers: { Authorization: "Bearer SYNTHETIC_SECRET\r\nInjected: yes" },
    })
  } catch (e) { error = e }
  expect(error?.message).toBe("ZCode signed Coding Plan: invalid request headers")
  expect(String(error)).not.toContain("SYNTHETIC_SECRET")
  expect(calls).toHaveLength(0)
})
