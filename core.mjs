// Shared core for talking to APIMart's image API. Two entry points use it:
// index.mjs (a provider plugin magpie loads) and mcp.mjs (a stdio MCP server
// magpie's library gives the agents).
//
// APIMart draws asynchronously. POST /v1/images/generations answers a task —
// the official line's {code, data:[{status:"submitted", task_id}]}, the Ext
// line's {code, data:{id, status:"pending", poll_url}} — and the images are
// only at GET /v1/tasks/<id>, under data.result.images[].url (an array, one
// URL per image), once data.status is completed. Everything here is that
// round trip, the sizes APIMart takes, and which line and version an id
// stands for; nothing here knows about magpie.
//
// Only text-to-image: APIMart takes reference images as public URLs or an
// upload of its own (POST /v1/uploads/images), which is a later step.

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// The gateway. APIMART_BASE_URL points it elsewhere (a proxy, a test).
export const baseURL = () => (process.env.APIMART_BASE_URL || "https://api.apimart.ai/v1").replace(/\/+$/, "");

// APIMart's GPT Image 2.5 and Nano Banana 2.1, on both of its lines. A line
// is a model id — there is no separate switch for it:
//
//   gpt-image-2.5-flare        official line, flare      (token billing)
//   gpt-image-2.5-sunburst     official line, sunburst   (token billing)
//   gpt-image-2.5-ext          Ext line                  (per image, flat)
//   gemini-nano-banana-2.1     official line
//   gemini-nano-banana-2.1-ext Ext line
export const MODELS = {
  "gpt-image-2.5-flare": "GPT Image 2.5 Flare（官方线）",
  "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst（官方线）",
  "gpt-image-2.5-ext": "GPT Image 2.5 Ext（Ext 线 · Sunburst）",
  "gemini-nano-banana-2.1": "Nano Banana 2.1（官方线）",
  "gemini-nano-banana-2.1-ext": "Nano Banana 2.1（Ext 线）",
};

// The models whose flare/sunburst version APIMart takes as a field beside the
// id: its Ext line is the only one so far. Which version goes in it is a
// choice (default sunburst: on that line the two cost the same, and sunburst
// is the one that edits precisely).
export const VERSIONS = { "gpt-image-2.5-ext": true };
export const VERSION_NAMES = ["flare", "sunburst"];

// APIMart's ratio-to-pixels table (its docs' 比例与分辨率映射), for the ratios
// every model accepts. Only the GPT Image official line takes exact pixels;
// the Ext lines and Nano Banana take an aspect ratio beside a 1K/2K/4K tier,
// so a WIDTHxHEIGHT is turned into the nearest ratio of this table and the
// tier whose pixels are nearest — which is how 1024x1024, 2048x2048 and
// 2880x2880 mean 1K, 2K and 4K.
export const SIZES = {
  "1:1": [[1024, 1024], [2048, 2048], [2880, 2880]],
  "3:2": [[1536, 1024], [2048, 1360], [3520, 2336]],
  "2:3": [[1024, 1536], [1360, 2048], [2336, 3520]],
  "4:3": [[1024, 768], [2048, 1536], [3312, 2480]],
  "3:4": [[768, 1024], [1536, 2048], [2480, 3312]],
  "5:4": [[1280, 1024], [2560, 2048], [3216, 2576]],
  "4:5": [[1024, 1280], [2048, 2560], [2576, 3216]],
  "16:9": [[1536, 864], [2048, 1152], [3840, 2160]],
  "9:16": [[864, 1536], [1152, 2048], [2160, 3840]],
  "21:9": [[2016, 864], [2688, 1152], [3840, 1648]],
};
export const TIERS = ["1k", "2k", "4k"];

// A model's context is meaningless for an image, but magpie's pickers show one.
export const LIMIT = { context: 32000, output: 4096 };

export const POLL_MS = 2500;
export const WAIT_MS = 4 * 60 * 1000;

// providers/models APIMart serves on the images API, by the names its
// /v1/models uses. Ids that draw something else — video, or an edit that
// needs an input image — are left out, as is Midjourney, whose own
// /v1/midjourney/generations route this does not speak.
export const IMAGE_MODEL = /(gpt-image|imagen|imagine|banana|seedream|flux|qwen-image|wanx|wan2|z-image|dall-e|midjourney|mai-image|gemini-[0-9.]+[a-z-]*-image)/i;
export const NOT_IMAGE = /(video|i2v|r2v|edit|kontext|omni|audio|whisper|\btts\b|moderation|music|suno|upscale|blend|describe|reroll|variation|inpaint|remix|zoom|pan\b|modal|midjourney|ltx|^wan[0-9][0-9.]*(-preview)?$)/i;

// An API failure: the status APIMart answered with, and its own words.
export class ApimartError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApimartError";
    this.status = typeof status === "number" && status >= 400 ? status : 502;
  }
}

// resolve is what APIMart is asked for, and the version that goes beside it:
// an Ext id asks for a version of its own, and so does an id ending in -flare
// or -sunburst whose base is one (gpt-image-2.5-ext-sunburst is the Ext model
// asked for sunburst, a second entry a picker can offer).
export function resolve(id, opts = {}) {
  if (typeof id !== "string" || id === "") return { model: "", version: "" };
  const versions = opts.versions ?? {};
  const fallback = VERSION_NAMES.includes(opts.extVersion) ? opts.extVersion : "sunburst";
  if (versions[id]) return { model: id, version: versions[id] };
  if (!VERSIONS[id]) {
    const cut = VERSION_NAMES.find((v) => id.endsWith(`-${v}`));
    const base = cut ? id.slice(0, -(cut.length + 1)) : "";
    // an id that names its version gets it: the id is the more specific ask,
    // and versions is what the bare Ext id goes by
    if (cut && VERSIONS[base]) return { model: base, version: cut };
  }
  return { model: id, version: VERSIONS[id] ? versions[id] ?? fallback : "" };
}

// isImaged is whether an id is an image model here: one this is set up to draw
// with (by its id or as a version of one), or one named like one with video
// and edit-only ids out.
export function isImaged(id, opts = {}) {
  if (typeof id !== "string" || id === "") return false;
  const models = opts.models ?? MODELS;
  const asked = resolve(id, opts).model;
  if (models[asked] || (asked !== id && models[id])) return true;
  return IMAGE_MODEL.test(asked) && !NOT_IMAGE.test(asked);
}

// sizeOf is the size fields APIMart is asked with, from what a client said:
// an aspect ratio goes as it is (the tier stays APIMart's default), a
// WIDTHxHEIGHT becomes this table's nearest ratio and the tier whose pixels
// are nearest, and nothing at all (or "auto") leaves both to APIMart.
export function sizeOf(size) {
  if (typeof size !== "string") return {};
  const want = size.trim().toLowerCase();
  if (want === "" || want === "auto") return {};
  if (want.includes(":")) return { size: want };
  const pair = /^(\d+)\s*[x×]\s*(\d+)$/.exec(want);
  if (!pair) return { size: want };
  const width = Number(pair[1]);
  const height = Number(pair[2]);
  if (!(width > 0) || !(height > 0)) return {};
  // its "16x9" spelling of a ratio, which is far too small to be pixels
  if (width <= 32 && height <= 32) return { size: `${width}:${height}` };
  const ratio = nearest(Object.keys(SIZES), (r) => ratioGap(r, width, height));
  if (!ratio) return { size: want };
  const tiers = SIZES[ratio];
  const at = nearest(tiers.map((_, i) => i), (i) => pixelGap(tiers[i], width, height));
  if (at == null) return { size: ratio };
  return { size: ratio, resolution: TIERS[at] };
}

// nearest is the item of list its measure is smallest for, ties going to the
// earlier one; null for a list with nothing measurable in it.
function nearest(list, measure) {
  let best = null;
  let bestGap = Infinity;
  for (const item of list) {
    const gap = measure(item);
    if (Number.isFinite(gap) && gap < bestGap) {
      best = item;
      bestGap = gap;
    }
  }
  return best;
}

// ratioGap is how far a size is from a ratio, in the log space a picture is
// compared in: 2:3 and 3:2 are the same distance apart either way round.
function ratioGap(ratio, width, height) {
  const [a, b] = ratio.split(":").map(Number);
  if (!(a > 0) || !(b > 0)) return Infinity;
  return Math.abs(Math.log(width / height) - Math.log(a / b));
}

// pixelGap is how far a size is from one of the table's, by area.
function pixelGap([w, h], width, height) {
  return Math.abs(Math.log((w * h) / (width * height)));
}

// model is an OpenCode Model as magpie reads one.
export function model(name) {
  return { name, limit: LIMIT };
}

// label is the name a model goes by when a list names ids alone.
export function label(id) {
  if (MODELS[id]) return MODELS[id];
  const cut = VERSION_NAMES.find((v) => id.endsWith(`-${v}`));
  if (cut && MODELS[id.slice(0, -(cut.length + 1))]) {
    const bare = MODELS[id.slice(0, -(cut.length + 1))].replace(/（[^）]*）$/, "");
    return `${bare}（Ext 线 · ${cut === "flare" ? "Flare" : "Sunburst"}）`;
  }
  return id;
}

// draw submits one images request and waits out its task, giving back the
// image URLs. It throws an ApimartError the caller can hand on as it is.
export async function draw(ask, opts = {}) {
  const {
    key = "",
    versions = {},
    extVersion = "sunburst",
    pollMs = POLL_MS,
    waitMs = WAIT_MS,
    signal,
    request = fetch,
    onProgress = () => {},
  } = opts;
  const url = `${baseURL()}/images/generations`;
  const asked = resolve(ask.model, { versions, extVersion });
  const want = { model: asked.model, prompt: ask.prompt, n: whole(ask.n, 1, 4) ?? 1 };
  if (asked.version) want.version = asked.version;
  Object.assign(want, sizeOf(ask.size));
  for (const k of ["quality", "background", "output_format", "output_compression"]) {
    const v = ask[k];
    if (v === undefined || v === null || v === "" || v === "auto") continue;
    want[k] = v;
  }

  const submit = await send(request, url, key, want, signal);
  const payload = json(submit.text);
  if (submit.status >= 300 || !payload) {
    throw new ApimartError(submit.status, messageOf(payload) ?? submit.text.slice(0, 300) ?? `APIMart answered ${submit.status}`);
  }
  // Should APIMart ever answer with the images themselves, they pass through.
  if (Array.isArray(payload.data) && payload.data.some((row) => row?.b64_json || row?.url)) {
    return { urls: imagesOf(payload), model: asked.model, version: asked.version, ...sizeFields(want) };
  }

  const ids = taskIDs(payload);
  if (ids.length === 0) throw new ApimartError(502, `APIMart started no task: ${submit.text.slice(0, 300)}`);
  const urls = [];
  for (const id of ids) {
    const one = await waitFor(id, { key, pollMs, waitMs, signal, request, onProgress });
    if (one.error) throw new ApimartError(one.status, one.error);
    urls.push(...one.urls);
  }
  if (urls.length === 0) throw new ApimartError(502, "APIMart finished the task with no image");
  return { urls, model: asked.model, version: asked.version, ...sizeFields(want) };
}

// waitFor asks after one task until it is completed, failed, or too slow. A
// poll that fails to make the trip (a proxy dropping the handshake, a 5xx) is
// asked again: the task is running at APIMart's end whatever this end did, and
// giving up on it throws an image away that has already been paid for.
export async function waitFor(id, opts = {}) {
  const {
    key = "",
    pollMs = POLL_MS,
    waitMs = WAIT_MS,
    signal,
    request = fetch,
    onProgress = () => {},
    transportTries = 5,
  } = opts;
  const deadline = Date.now() + waitMs;
  let strikes = 0;
  for (;;) {
    try {
      await sleep(pollMs, signal);
      if (Date.now() > deadline) {
        return { error: `APIMart's task ${id} didn't finish within ${Math.round(waitMs / 1000)}s`, status: 504 };
      }
      const res = await request(`${baseURL()}/tasks/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${key}` },
        signal,
      });
      const text = await res.text();
      const payload = json(text);
      if (res.status >= 300) {
        if (res.status >= 500 || res.status === 429) {
          if (++strikes < transportTries) {
            onProgress({ id, status: `APIMart answered ${res.status}: asking again` });
            continue;
          }
        }
        return { error: `APIMart's task ${id}: ${res.status} ${messageOf(payload) ?? text.slice(0, 200)}`.trim(), status: res.status };
      }
      if (!payload) {
        if (++strikes < transportTries) {
          onProgress({ id, status: "APIMart's answer didn't read: asking again" });
          continue;
        }
        return { error: `APIMart's task answer isn't JSON: ${text.slice(0, 200)}`, status: 502 };
      }
      strikes = 0; // it answered: whatever went wrong on the way is over
      const data = payload.data ?? {};
      const status = String(data.status ?? "").toLowerCase();
      if (status === "completed" || status === "succeeded" || status === "success") {
        const urls = imagesOf(payload);
        if (urls.length === 0) return { error: "APIMart finished the task with no image", status: 502 };
        return { urls };
      }
      if (status === "failed" || status === "failure" || status === "canceled" || status === "cancelled") {
        const why = data.error?.message ?? messageOf(payload);
        return { error: `APIMart's image task failed${why ? `: ${why}` : ""}`, status: 502 };
      }
      onProgress({ id, status: status || "processing", progress: data.progress });
    } catch (e) {
      if (signal?.aborted) return { error: "the request was cancelled", status: 499 };
      if (++strikes < transportTries) {
        onProgress({ id, status: `${e?.message ?? e}: asking again` });
        continue;
      }
      return { error: `APIMart's task ${id} couldn't be asked after ${transportTries} tries: ${e?.message ?? e}`, status: 502 };
    }
  }
}

// requester is what to make HTTP calls with. magpie's plugin host already
// sends its plugins' fetches through the user's proxy, so index.mjs uses
// fetch as it comes; a process magpie didn't start (mcp.mjs, run by an agent)
// has to find the proxy itself — Node's fetch ignores proxies, and APIMart is
// not reachable without one on some networks — so when there is one, curl
// (which speaks http, https and socks) is used instead.
export function requester({ proxy = proxyFor() } = {}) {
  return proxy ? curlRequester(proxy) : fetch;
}

// proxyFor is the proxy to reach APIMart through: the environment's, else the
// system's on macOS (what a proxy app sets), else none.
// (MAGPIE_CONFIG_DIR names magpie's own folder, for the ticked models below.)
let cachedProxy;
export function proxyFor(env = process.env) {
  if (cachedProxy !== undefined) return cachedProxy;
  if (off(env.APIMART_NO_PROXY)) return (cachedProxy = "");
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy;
  cachedProxy = (fromEnv || systemProxy()).trim();
  return cachedProxy;
}

// off is a variable that says a switch is on: 1, true, yes or on.
export function off(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

// systemProxy is what macOS' network settings point at, "" for none.
function systemProxy() {
  if (process.platform !== "darwin") return "";
  let out = "";
  try {
    out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 5000 });
  } catch {
    return "";
  }
  const field = (name) => {
    const m = new RegExp(`\\b${name}\\s*:\\s*(\\S+)`).exec(out);
    return m ? m[1] : "";
  };
  const on = (name) => field(`${name}Enable`) === "1";
  if (on("SOCKS")) return `socks5h://${field("SOCKSProxy")}:${field("SOCKSPort")}`;
  if (on("HTTPS")) return `http://${field("HTTPSProxy")}:${field("HTTPSPort")}`;
  if (on("HTTP")) return `http://${field("HTTPProxy")}:${field("HTTPPort")}`;
  return "";
}

// curlRequester is a fetch-shaped call made by curl, so a proxy is honoured
// whatever kind it is.
function curlRequester(proxy) {
  return async (url, init = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "apimart-"));
    const body = join(dir, "body");
    const args = ["-sS", "--max-time", "300", "--proxy", proxy, "-o", body, "-w", "%{http_code}", "-X", init.method || "GET"];
    for (const [k, v] of Object.entries(init.headers ?? {})) args.push("-H", `${k}: ${v}`);
    try {
      if (init.body != null) {
        const sent = join(dir, "sent");
        await writeFile(sent, init.body);
        args.push("--data-binary", `@${sent}`);
      }
      args.push(url);
      let stdout = "";
      let failed = null;
      try {
        ({ stdout } = await run("curl", args, { maxBuffer: 1 << 28, timeout: (init.timeoutMs ?? 300000) + 5000 }));
      } catch (e) {
        failed = e;
      }
      if (failed && failed.code === "ENOENT") {
        throw new Error("curl isn't on PATH, which this needs to go through a proxy");
      }
      const status = Number(String(stdout).trim());
      if (!Number.isFinite(status) || status === 0) {
        throw new Error(String(failed?.stderr || failed?.message || "curl failed").trim().slice(0, 300));
      }
      const text = await readFile(body, "utf8");
      return {
        status,
        ok: status < 300,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// keyFrom is the APIMart key: APIMART_API_KEY in the environment, else a macOS
// Keychain item of that name, so a Keychain-synced key works with no
// environment at all.
export async function keyFrom({ env = process.env, keychain = true } = {}) {
  const fromEnv = (env.APIMART_API_KEY || env.APIMART_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (keychain && process.platform === "darwin") {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "APIMART_API_KEY", "-w"]);
      const key = stdout.trim();
      if (key) return key;
    } catch {
      // no such item: the error below says what to set
    }
  }
  throw new Error("no APIMart key: set APIMART_API_KEY, or store one in the macOS Keychain (security add-generic-password -s APIMART_API_KEY -a apimart -w sk-…)");
}

// balance is what a key has left, as APIMart reports it.
export async function balance(key, { request = fetch } = {}) {
  const res = await request(`${baseURL()}/balance`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new ApimartError(res.status, `APIMart answered ${res.status}`);
  const body = await res.json();
  if (body?.success !== true) throw new ApimartError(502, String(body?.message ?? "APIMart's balance answer said no"));
  return {
    unlimited: body.unlimited_quota === true,
    used: money(body.used_balance),
    left: money(body.remain_balance),
  };
}

// listing is APIMart's own model list, filtered to what the images API draws.
export async function listing(key, { request = fetch } = {}) {
  const res = await request(`${baseURL()}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new ApimartError(res.status, `APIMart answered ${res.status}`);
  const body = await res.json();
  const out = {};
  for (const m of body?.data ?? []) {
    const id = m?.id;
    if (typeof id !== "string" || !id) continue;
    if (!IMAGE_MODEL.test(id) || NOT_IMAGE.test(id)) continue;
    out[id] = model(m.name ?? id);
  }
  return out;
}

async function send(request, url, key, body, signal) {
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    if (signal?.aborted) throw new ApimartError(499, "the request was cancelled");
    throw new ApimartError(502, `APIMart couldn't be reached: ${e?.message ?? e}`);
  }
}

// taskIDs are the tasks a submit answer started: the official line puts an
// array in data ([{status, task_id}]), the Ext line one object ({id, …}).
export function taskIDs(payload) {
  const data = payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((row) => row?.task_id ?? row?.id).filter((id) => typeof id === "string" && id !== "");
}

// imagesOf are the images a task answer holds: result.images[].url is an
// array, one URL per image, and a task with n images holds them all.
export function imagesOf(payload) {
  const data = payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const out = [];
  for (const row of rows) {
    for (const image of row?.result?.images ?? []) {
      for (const url of image?.url ?? []) if (typeof url === "string" && url) out.push(url);
    }
    for (const url of row?.url ?? []) if (typeof url === "string" && url) out.push(url);
  }
  return out;
}

function sizeFields(want) {
  return { size: want.size ?? "", resolution: want.resolution ?? "" };
}

export function messageOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.error?.message === "string") return payload.error.message;
  if (typeof payload.message === "string") return payload.message;
  return null;
}

export function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function whole(value, min, max) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  if (i < min || i > max) return undefined;
  return i;
}

function money(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// sleep waits, and gives up early when the caller's signal does.
export function sleep(ms, signal) {
  return new Promise((ok, no) => {
    const timer = setTimeout(ok, ms);
    if (signal?.aborted) {
      clearTimeout(timer);
      no(new Error("aborted"));
      return;
    }
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        no(new Error("aborted"));
      },
      { once: true },
    );
  });
}
