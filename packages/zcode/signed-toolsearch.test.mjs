// Cross-adapter contract: ToolSearch translation must compose with the signed
// BigModel transport, and must not move an explicit Trial onto a paid route.
// All keys, policies, balances and responses are synthetic. Run test:zcode.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"

const ORIGINAL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
const COUNT = ORIGINAL + "/count_tokens"
const ULTRA = "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages"
const START = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
const CONFIG = "https://zcode.z.ai/api/v1/agent/configs"
const HANDSHAKE = "https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client"
const KEY = "toolsearch.synthetic-secret"
const JWT = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })]
  .map((s) => Buffer.from(s).toString("base64url")).join(".") + ".synthetic"
const realFetch = globalThis.fetch
let ZCodeAuthPlugin, _internal, publicKey, answer
const calls = []

beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((p) => homedir().startsWith(p)))
    throw new Error("Run with the isolated test:zcode homedir preload")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})

function cipher() {
  const pair = generateKeyPairSync("ed25519")
  publicKey = pair.publicKey
  const [id, secret] = KEY.split(".")
  const iv = randomBytes(12)
  const aes = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("WD_CLIENT_SIGN_KDF_SALT"), Buffer.from("ed25519_priv"), 32))
  const c = createCipheriv("aes-256-gcm", aes, iv)
  c.setAAD(Buffer.from(id))
  const plain = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]).toString("base64")
}

const message = (name = "ToolSearchTool") => ({
  type: "message", role: "assistant", model: "GLM-5.3", stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "查找工具 🧪", signature: "synthetic-thinking-signature" },
    { type: "tool_use", id: "search-1", name, input: { query: "读取 文件" } },
    { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/synthetic/test.txt" } },
    { type: "text", text: "The literal ToolSearchTool in text must remain unchanged." },
  ],
})

beforeEach(() => {
  calls.length = 0
  publicKey = null
  _internal.routes.clear()
  _internal.blocked.clear()
  answer = () => Response.json(message())
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    const sent = { url, ...init, headers: new Headers(init.headers) }
    calls.push(sent)
    if (url === CONFIG) return Response.json({ code: 0, data: {
      codingPlanSignature: { enable: true },
      proxyEndpoint: { mapping: [{ from: ORIGINAL, to: ULTRA, zcodeAuthorizationHeader: "X-ZCode-Authorization" }] },
    } })
    if (url === HANDSHAKE) return Response.json({ code: 200, data: { privateCipher: cipher() } })
    if (url.endsWith("/api/biz/subscription/list"))
      return Response.json({ code: 0, data: [{ status: "VALID", productName: "GLM Coding Pro" }] })
    if (url.includes("/api/v1/zcode-plan/billing/balance")) {
      const now = Math.floor(Date.now() / 1000)
      return Response.json({ code: 0, data: {
        server_time: now,
        plans: [{ plan_id: "synthetic-gift", name: "Synthetic gift", status: "active", ends_at: now + 3600 }],
        balances: [{ plan_id: "synthetic-gift", capabilities: ["model:glm-5.3-flash"], remaining_units: 10, total_units: 10, expires_at: now + 3600 }],
      } })
    }
    if (url === COUNT) return Response.json({ input_tokens: 321 })
    if (url === ULTRA || url === START) return answer()
    throw new Error("Unexpected network destination in signed ToolSearch test")
  }
})
afterEach(() => { globalThis.fetch = realFetch })

async function loader() {
  const state = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: KEY, jwt: JWT, device: "synthetic-device" }
  const auth = { type: "oauth", access: KEY, refresh: JSON.stringify(state), expires: 0 }
  const plugin = await ZCodeAuthPlugin({ client: {} })
  return plugin.auth.loader(async () => auth, { id: "zcode" })
}

function requestBody(model = "GLM-5.3") {
  return {
    model, max_tokens: 4096, stream: false,
    system: "Keep the caller's system instructions.",
    tools: [
      { name: "ToolSearch", description: "Find deferred tools", input_schema: { type: "object" } },
      { name: "Read", input_schema: { type: "object" }, defer_loading: true },
      { name: "DeferredToolPlaceholder", input_schema: { type: "object" }, defer_loading: true },
    ],
    messages: [
      { role: "user", content: "Read the synthetic fixture." },
      { role: "assistant", content: [{ type: "thinking", thinking: "先查找", signature: "saved-signature" }, { type: "tool_use", id: "previous-search", name: "ToolSearch", input: { query: "Read" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "previous-search", content: [{ type: "tool_reference", tool_name: "Read" }] }] },
    ],
    tool_choice: { type: "tool", name: "ToolSearch" },
  }
}

const modelCalls = () => calls.filter((c) => c.url === ULTRA || c.url === START || c.url === ORIGINAL)
const initFor = (body) => {
  const text = JSON.stringify(body)
  return { method: "POST", body: text, headers: {
    "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), "x-session-id": "signed-toolsearch-session",
  } }
}

test("ToolSearch request and JSON reply compose with valid BigModel signing and ultra auth", async () => {
  const opts = await loader()
  for (const asRequest of [false, true]) {
    const original = requestBody()
    const init = initFor(original)
    const res = asRequest ? await opts.fetch(new Request(ORIGINAL, init)) : await opts.fetch(ORIGINAL, init)
    const sent = modelCalls().at(-1)
    expect(sent.url).toBe(ULTRA)
    expect(sent.redirect).toBe("manual")
    expect(sent.headers.has("content-length")).toBe(false)
    expect(sent.headers.get("x-zcode-authorization")).toBe("Bearer " + JWT)
    const fields = [KEY.split(".")[0], "x-client-ts", "x-client-version", "x-session-id", "x-client-nonce"]
      .map((v, i) => i ? sent.headers.get(v) : v)
    expect(verify(null, Buffer.from(fields.join("\n")), publicKey, Buffer.from(sent.headers.get("x-client-sig"), "base64"))).toBe(true)
    const wire = JSON.parse(sent.body)
    expect(wire.system).toBe(original.system)
    expect(wire.tools.map((t) => t.name)).toEqual(["ToolSearchTool", "Read"])
    expect(wire.tools.some((t) => "defer_loading" in t)).toBe(false)
    expect(wire.messages[1].content[1].name).toBe("ToolSearchTool")
    expect(wire.messages[1].content[0]).toEqual(original.messages[1].content[0])
    expect(wire.messages[2]).toEqual(original.messages[2])
    expect(wire.tool_choice.name).toBe("ToolSearchTool")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
    expect(await res.json()).toEqual(message("ToolSearch"))
  }
  expect(calls.filter((c) => c.url === HANDSHAKE)).toHaveLength(1)
  expect(modelCalls()).toHaveLength(2)
})

test("Claude Code's exact beta marker is normalized before signed BigModel ToolSearch transport", async () => {
  const opts = await loader()
  for (const asRequest of [false, true]) {
    const url = ORIGINAL + "?beta=true"
    const init = initFor(requestBody())
    const res = asRequest ? await opts.fetch(new Request(url, init)) : await opts.fetch(url, init)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(message("ToolSearch"))
    const sent = modelCalls().at(-1)
    expect(sent.url).toBe(ULTRA)
    expect(sent.headers.has("x-client-sig")).toBe(true)
    expect(sent.headers.has("content-length")).toBe(false)
    expect(JSON.parse(sent.body).tools[0].name).toBe("ToolSearchTool")
  }
  expect(modelCalls()).toHaveLength(2)
})

test("signed BigModel still rejects other or duplicated query parameters before sending a model request", async () => {
  const opts = await loader()
  for (const query of ["?beta=false", "?beta=True", "?other=1", "?beta=true&other=1", "?beta=true&beta=true", "?beta=true&", "?%62eta=true", "?beta=true#fragment"]) {
    await expect(opts.fetch(ORIGINAL + query, initFor(requestBody()))).rejects.toThrow("unsafe endpoint policy")
  }
  expect(modelCalls()).toHaveLength(0)
  expect(calls.some((c) => c.url === CONFIG || c.url === HANDSHAKE)).toBe(false)
})

test("count_tokens with Claude Code's beta marker stays on original BigModel without ultra JWT", async () => {
  const opts = await loader()
  const res = await opts.fetch(COUNT + "?beta=true", initFor(requestBody()))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ input_tokens: 321 })
  const counted = calls.filter((c) => c.url === COUNT)
  expect(counted).toHaveLength(1)
  expect(counted[0].headers.has("x-client-sig")).toBe(true)
  expect(counted[0].headers.has("x-zcode-authorization")).toBe(false)
  expect(counted[0].headers.get("x-api-key")).toBe(KEY)
  expect(counted[0].headers.has("content-length")).toBe(false)
  expect(JSON.parse(counted[0].body).tools[0].name).toBe("ToolSearchTool")
  expect(modelCalls()).toHaveLength(0)
})

test("signed ToolSearch SSE restores only tool names across byte splits, preserving reasoning and UTF-8", async () => {
  const event = (value) => "data: " + JSON.stringify(value) + "\n\n"
  const wire = ": keepalive\n\n" +
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "查找文件 🧪" } }) +
    event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "unchanged-signature" } }) +
    event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "s1", name: "ToolSearchTool", input: {} } }) +
    event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"读取 文件"}' } }) +
    event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "b1", name: "Bash", input: {} } }) +
    event({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "ToolSearchTool stays in prose" } }) +
    "data: " + JSON.stringify({ type: "message_stop" }) // also exercise the final unterminated line
  answer = () => {
    const bytes = new TextEncoder().encode(wire)
    let offset = 0
    const stream = new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, ++offset))
    } })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "content-length": String(bytes.length), "content-encoding": "gzip" } })
  }
  const opts = await loader()
  const res = await opts.fetch(ORIGINAL, initFor({ ...requestBody(), stream: true }))
  expect(modelCalls()).toHaveLength(1)
  expect(modelCalls()[0].headers.has("x-client-sig")).toBe(true)
  expect(res.headers.has("content-length")).toBe(false)
  expect(res.headers.has("content-encoding")).toBe(false)
  expect(await res.text()).toBe(wire.replace('"name":"ToolSearchTool"', '"name":"ToolSearch"'))
})

test("Trial ToolSearch translation stays on the gift, including a quota refusal without paid replay", async () => {
  const opts = await loader()
  const init = initFor(requestBody("GLM-5.3-Flash-Trial"))
  const success = await opts.fetch(ORIGINAL + "?beta=true", init)
  expect(await success.json()).toEqual(message("ToolSearch"))
  const sent = modelCalls()[0]
  expect(sent.url).toBe(START)
  expect(sent.headers.get("authorization")).toBe("Bearer " + JWT)
  expect(sent.headers.has("x-api-key")).toBe(false)
  expect(sent.headers.has("x-client-sig")).toBe(false)
  const wire = JSON.parse(sent.body)
  expect(wire.model).toBe("glm-5.3-flash")
  expect(wire.system).toHaveLength(3)
  expect(wire.system[2].text).toContain("Keep the caller's system instructions.")
  expect(wire.tools.map((t) => t.name)).toEqual(["ToolSearchTool", "Read"])
  answer = () => Response.json({ error: { code: "1113", message: "Synthetic gift spent" } }, { status: 429 })
  const refused = await opts.fetch(ORIGINAL, init)
  expect(refused.status).toBe(429)
  expect((await refused.json()).error.code).toBe("1113")
  expect(modelCalls().map((c) => c.url)).toEqual([START, START])
  expect(calls.some((c) => c.url === CONFIG || c.url === HANDSHAKE)).toBe(false)
})
