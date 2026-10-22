// Signed BigModel Coding Plan transport, ported from our validated LiteLLM
// adapter. Keys stay in memory; a failed handshake never sends unsigned or
// replays a model request. Z.ai and Start/Trial plans use the existing plugin.
import {
  createDecipheriv, createHash, createHmac, createPrivateKey, hkdfSync,
  randomBytes, randomUUID, sign,
} from "node:crypto"
import { arch, release } from "node:os"

const BASE = "https://open.bigmodel.cn/api/anthropic"
const ORIGINAL = BASE + "/v1/messages"
const ULTRA = "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages"
const POLICY = "https://zcode.z.ai/api/v1/agent/configs"
const HANDSHAKE = "https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client"
const SALT = "WD_CLIENT_SIGN_KDF_SALT"
const AUTH_HEADER = "X-ZCode-Authorization"

function failure(message) {
  const error = new Error("ZCode signed Coding Plan: " + message)
  error.status = 502
  return error
}

function endpoint(value) {
  if (typeof value !== "string") throw failure("invalid endpoint policy")
  let u
  try { u = new URL(value) } catch { throw failure("invalid endpoint policy") }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash)
    throw failure("unsafe endpoint policy")
  return u.origin + (u.pathname.replace(/\/+$/, "") || "/")
}

function routing(payload) {
  if (!payload || payload.code !== 0 || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data))
    throw failure("endpoint policy was not accepted")
  // Current ZCode selects signing by provider access mode. An absent legacy
  // flag doesn't turn signing off; an explicit policy change needs review.
  const flag = payload.data.codingPlanSignature
  if (flag !== undefined && flag?.enable !== true) throw failure("signing policy changed")
  const proxy = payload.data.proxyEndpoint
  if (proxy === undefined) return { target: ORIGINAL, withJWT: false }
  if (!proxy || !Array.isArray(proxy.mapping)) throw failure("malformed endpoint mapping")
  const seen = new Set()
  let result = { target: ORIGINAL, withJWT: false }
  for (const item of proxy.mapping) {
    if (!item || typeof item !== "object") throw failure("malformed endpoint mapping")
    const from = endpoint(item.from)
    const to = endpoint(item.to)
    if (seen.has(from)) throw failure("duplicate endpoint mapping")
    seen.add(from)
    if (from !== ORIGINAL) continue
    if (to !== ORIGINAL && to !== ULTRA) throw failure("unrecognized BigModel endpoint")
    const name = item.zcodeAuthorizationHeader
    if (name !== undefined && (typeof name !== "string" || name.toLowerCase() !== AUTH_HEADER.toLowerCase()))
      throw failure("unrecognized endpoint authorization header")
    if (name !== undefined && to !== ULTRA) throw failure("authorization header requires the ZCode ultra endpoint")
    result = { target: to, withJWT: to === ULTRA && name !== undefined }
  }
  return result
}

function derive(secret, info) {
  return Buffer.from(hkdfSync("sha256", secret, SALT, info, 32))
}

function base64(value) {
  if (typeof value !== "string" || !value.length || value.length > 65536 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw failure("invalid signing key encoding")
  return Buffer.from(value, "base64")
}

function privateKey(cipher, id, secret) {
  const raw = base64(cipher)
  if (raw.length <= 28) throw failure("invalid signing key payload")
  const aes = derive(secret, "ed25519_priv")
  let plain, der
  try {
    const decipher = createDecipheriv("aes-256-gcm", aes, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(raw.subarray(-16))
    plain = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()])
    // The encrypted plaintext is base64-encoded PKCS#8 DER, not PEM.
    der = base64(plain.toString("utf8"))
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    if (key.asymmetricKeyType !== "ed25519") throw failure("unexpected signing key type")
    return key
  } catch {
    throw failure("could not decrypt the signing key")
  } finally {
    aes.fill(0)
    plain?.fill(0)
    der?.fill(0)
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError")
}

// Shared preparation has its own timeout. Cancelling one waiter must not
// cancel a handshake another request from the same account still needs.
function waiting(promise, signal) {
  checkAbort(signal)
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("The request was aborted", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function identity(version) {
  const locale = Intl.DateTimeFormat().resolvedOptions()
  return {
    "HTTP-Referer": "https://zcode.z.ai", "User-Agent": "ZCode/" + version,
    "X-ZCode-App-Version": version, "X-Title": "Z Code@cli", "X-Release-Channel": "production",
    "X-Client-Language": locale.locale || "unknown", "X-Client-Timezone": locale.timeZone || "UTC",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "X-Os-Version": `${process.platform} ${release()} ${arch()}`, "X-ZCode-Agent": "glm",
  }
}

function proof(id, session, ts, signal) {
  const seed = createHash("sha256").update(`${id}\nzcode\n${session}\n${ts}`).digest("hex").slice(0, 32)
  const prefix = randomBytes(12).toString("hex")
  for (let n = 0; n < 1_000_000; n++) {
    checkAbort(signal)
    const value = prefix + n.toString(16).padStart(8, "0")
    if (createHash("sha256").update(seed + "\n" + value).digest()[0] === 0) return value
  }
  throw failure("signing proof generation failed")
}

export function createSignedBigModelTransport({
  fetch: send = (...args) => globalThis.fetch(...args), now = Date.now,
  version = "3.16.2", policyTtlMs = 300_000, keyTtlMs = 1_800_000, maxAccounts = 32,
} = {}) {
  const accounts = new Map()

  async function json(url, init, stage) {
    let res
    try {
      res = await send(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) })
    } catch { throw failure(stage + " request failed") }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw failure(`${stage} HTTP ${res.status}`)
    }
    try { return await res.json() } catch { throw failure(stage + " returned invalid JSON") }
  }

  function account(key) {
    const hash = createHash("sha256").update(version + "\0" + key).digest("hex")
    let state = accounts.get(hash)
    if (state) accounts.delete(hash)
    else state = {}
    accounts.set(hash, state)
    while (accounts.size > Math.max(1, maxAccounts)) accounts.delete(accounts.keys().next().value)
    return state
  }

  function cached(state, field, ttl, load) {
    if (state[field] && state[field + "Until"] > now()) return Promise.resolve(state[field])
    if (state[field + "Pending"]) return state[field + "Pending"]
    const pending = Promise.resolve().then(load).then((value) => {
      state[field] = value
      state[field + "Until"] = now() + ttl
      return value
    }).finally(() => { if (state[field + "Pending"] === pending) delete state[field + "Pending"] })
    state[field + "Pending"] = pending
    return pending
  }

  async function handshake(key, id, secret) {
    const ts = String(now()), nonce = randomBytes(16).toString("hex")
    const hmacKey = derive(secret, "getSignKey_hmac")
    let sig
    try { sig = createHmac("sha256", hmacKey).update(`get_sign_key\n${id}\n${ts}\n${nonce}`).digest("base64") }
    finally { hmacKey.fill(0) }
    const result = await json(HANDSHAKE, {
      method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key, nonce, sig, ts }),
    }, "signing handshake")
    if (result?.code !== 200) throw failure("signing handshake was rejected")
    return privateKey(result?.data?.privateCipher, id, secret)
  }

  return {
    clear() { accounts.clear() },
    async fetch(url, opts = {}, auth = {}) {
      checkAbort(opts.signal)
      if (auth.site !== "bigmodel" || endpoint(auth.base) !== BASE)
        throw failure("only the BigModel Coding Plan is supported")
      // Match complete paths, never a string prefix. A Messages mapping does
      // not authorize inventing a count_tokens endpoint on the ultra host.
      const requested = endpoint(String(url))
      if (requested !== ORIGINAL && requested !== ORIGINAL + "/count_tokens")
        throw failure("unrecognized BigModel request endpoint")
      const key = auth.key
      if (typeof key !== "string" || !/^[\x21-\x7e]+$/.test(key) || !/^[^.\s]+\.[^.\s]+$/.test(key))
        throw failure("invalid Coding Plan credential")
      const [id, secret] = key.split(".")
      const state = account(key)
      const policy = await waiting(cached(state, "policy", policyTtlMs, async () => routing(await json(POLICY, {
        headers: { ...identity(version), "x-api-key-id": id },
      }, "endpoint policy"))), opts.signal)
      const route = requested === ORIGINAL ? policy : { target: requested, withJWT: false }
      checkAbort(opts.signal)
      const signer = await waiting(cached(state, "signer", keyTtlMs, () => handshake(key, id, secret)), opts.signal)
      checkAbort(opts.signal)
      let headers
      try { headers = new Headers(opts.headers) } catch { throw failure("invalid request headers") }
      const session = headers.get("X-Session-Id")?.trim() || randomUUID()
      const ts = String(now()), nonce = randomBytes(16).toString("hex")
      const pow = proof(id, session, ts, opts.signal)
      const signature = sign(null, Buffer.from(`${id}\n${ts}\n${version}\n${session}\n${nonce}`), signer).toString("base64")
      for (const [name, value] of Object.entries(identity(version))) headers.set(name, value)
      headers.delete(AUTH_HEADER)
      headers.delete("x-api-key-id")
      headers.set("x-api-key", key)
      headers.set("Authorization", "Bearer " + key)
      headers.set("X-Client-Ts", ts)
      headers.set("X-Client-Version", version)
      headers.set("X-Client-Sig", signature)
      headers.set("X-Client-Nonce", nonce)
      headers.set("X-Client-Pow", pow)
      headers.set("X-App-Id", "zcode")
      headers.set("X-Session-Id", session)
      headers.set("x-request-id", randomUUID())
      headers.set("x-zcode-session-type", "main")
      headers.set("x-zcode-trace-id", randomUUID())
      if (route.withJWT && typeof auth.jwt === "string" && auth.jwt.trim()) {
        const jwt = auth.jwt.trim().replace(/^Bearer\s+/i, "")
        // Headers.set errors include the rejected value. Validate credentials
        // first so a malformed token cannot be exposed in a host error log.
        if (!/^[\x21-\x7e]+$/.test(jwt)) throw failure("invalid ZCode session credential")
        headers.set(AUTH_HEADER, "Bearer " + jwt)
      }
      // Never consume or retry a response here, even after a 401 or redirect.
      const res = await send(route.target, { ...opts, headers, redirect: "manual" })
      if (res.status === 401 && state.signer === signer) {
        delete state.signer
        delete state.signerUntil
      }
      return res
    },
  }
}
