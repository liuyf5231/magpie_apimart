// Checks the plugin's hooks and the shared core without touching APIMart (or
// spending anything): every fetch is answered by a stand-in. Run it with
// `node test.mjs`.
//
// It covers what magpie does with the plugin: the provider and model list it
// declares, which line and version each id stands for, the sizes APIMart
// takes, the images request it draws (both submit shapes, with the task waited
// out), the 405 that sends an image model from chat completions to the images
// API, a chat model passing through, the model list it lists (with and without
// discovery), and the balance it reports.

import assert from "node:assert/strict";
import { ApimartPlugin, _internal } from "./index.mjs";
import { MODELS, SIZES, VERSIONS, isImaged, label, resolve, sizeOf } from "./core.mjs";

const BASE = "https://api.apimart.ai/v1";
const done = {
  code: 200,
  data: {
    id: "task_A",
    status: "completed",
    progress: 100,
    cost: 0.15,
    credits_cost: 1.5,
    result: { images: [{ url: ["https://cdn/one.png", "https://cdn/two.png"], expires_at: 1 }] },
  },
};

// withFetch answers every request as APIMart does, recording what was asked.
async function withFetch(handler, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    return handler(url, init);
  };
  try {
    return { calls, ...(await run(calls)) };
  } finally {
    globalThis.fetch = real;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// 1. the provider and the models it declares
{
  const plugin = await ApimartPlugin({}, undefined);
  const cfg = {};
  await plugin.config(cfg);
  const apimart = cfg.provider.apimart;
  assert.equal(apimart.name, "APIMart");
  assert.equal(apimart.api, BASE);
  assert.equal(apimart.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(
    Object.keys(apimart.models).sort(),
    ["gemini-nano-banana-2.1", "gemini-nano-banana-2.1-ext", "gpt-image-2.5-ext", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
    "the default list is GPT Image 2.5 and Nano Banana 2.1 on both lines",
  );
  assert.equal(plugin.auth.provider, "apimart");
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.equal(plugin.provider.id, "apimart");
  console.log("config: ok");
}

// 2. which line and version each id stands for
{
  const plain = { versions: {}, extVersion: "sunburst" };
  assert.deepEqual(resolve("gpt-image-2.5-flare", plain), { model: "gpt-image-2.5-flare", version: "" }, "an official id is asked for as it is");
  assert.deepEqual(resolve("gpt-image-2.5-sunburst", plain), { model: "gpt-image-2.5-sunburst", version: "" });
  assert.deepEqual(resolve("gpt-image-2.5-ext", plain), { model: "gpt-image-2.5-ext", version: "sunburst" }, "the Ext line takes the configured version");
  assert.deepEqual(resolve("gemini-nano-banana-2.1", plain), { model: "gemini-nano-banana-2.1", version: "" }, "nano-banana's official line takes none");
  assert.deepEqual(resolve("gemini-nano-banana-2.1-ext", plain), { model: "gemini-nano-banana-2.1-ext", version: "" }, "nano-banana's Ext line is a model id of its own");
  assert.deepEqual(resolve("gpt-image-2.5-ext-flare", plain), { model: "gpt-image-2.5-ext", version: "flare" }, "a -flare/-sunburst id is that version of its base");
  assert.deepEqual(resolve("gpt-image-2.5-ext-sunburst", plain), { model: "gpt-image-2.5-ext", version: "sunburst" });
  assert.deepEqual(resolve("gpt-image-2.5-ext", { ...plain, versions: { "gpt-image-2.5-ext": "flare" } }), { model: "gpt-image-2.5-ext", version: "flare" }, "options.versions wins");
  assert.deepEqual(resolve("gpt-image-2.5-ext", { versions: {}, extVersion: "flare" }), { model: "gpt-image-2.5-ext", version: "flare" }, "options.extVersion is the fallback");
  assert.deepEqual(resolve("gpt-image-2.5-ext-flare", { ...plain, versions: { "gpt-image-2.5-ext": "sunburst" } }), { model: "gpt-image-2.5-ext", version: "flare" }, "a named version wins for that id");
  assert.ok(isImaged("gemini-nano-banana-2.1", plain), "an image model is one to draw with");
  assert.ok(!isImaged("gpt-5.2", plain));
  assert.ok(!isImaged("wan3.0-video", plain), "video is not");
  assert.ok(isImaged("gemini-3.1-flash-image-preview", plain), "a Gemini image model is, by name");
  console.log("lines and versions: ok");
}

// 3. what a size becomes: a ratio stays, pixels become a ratio and a tier
{
  assert.deepEqual(sizeOf("1024x1024"), { size: "1:1", resolution: "1k" });
  assert.deepEqual(sizeOf("2048x2048"), { size: "1:1", resolution: "2k" }, "2K is asked for as pixels");
  assert.deepEqual(sizeOf("2880x2880"), { size: "1:1", resolution: "4k" });
  assert.deepEqual(sizeOf("1536x1024"), { size: "3:2", resolution: "1k" });
  assert.deepEqual(sizeOf("3840x2160"), { size: "16:9", resolution: "4k" });
  assert.deepEqual(sizeOf("2160x3840"), { size: "9:16", resolution: "4k" });
  assert.deepEqual(sizeOf("16:9"), { size: "16:9" }, "a ratio goes as it is");
  assert.deepEqual(sizeOf("21:9"), { size: "21:9" }, "a ratio of a model's own is not rounded to the table");
  assert.deepEqual(sizeOf("16x9"), { size: "16:9" }, "its 16x9 spelling of a ratio");
  assert.deepEqual(sizeOf("auto"), {}, "auto leaves the size to APIMart");
  assert.deepEqual(sizeOf(""), {});
  assert.equal(Object.keys(SIZES).length, 10, "the table is the ratios every model takes");
  assert.equal(Object.keys(MODELS).length, 5, "the offered models are the two families on both lines");
  console.log("sizes: ok");
}

// 4. an image drawn through the account's loader
{
  const plugin = await ApimartPlugin({}, { pollMs: 1, waitMs: 1000 });
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  assert.equal(loader.baseURL, BASE);
  assert.equal(loader.apiKey, "sk-test");

  let polls = 0;
  await withFetch(
    (url) => {
      if (url.endsWith("/images/generations")) return json({ code: 200, data: [{ status: "submitted", task_id: "task_A" }] });
      polls += 1;
      return json(polls < 2 ? { code: 200, data: { status: "processing", progress: 50 } } : done);
    },
    async (calls) => {
      const res = await loader.fetch(`${BASE}/images/generations`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-image-2.5-ext", prompt: "a cat", n: 2, size: "1024x1024", quality: "high", output_format: "png" }),
      });
      assert.equal(res.status, 200, "a drawn image answers 200");
      assert.deepEqual((await res.json()).data, [{ url: "https://cdn/one.png" }, { url: "https://cdn/two.png" }], "every image of the task is passed on");
      const sent = JSON.parse(calls[0].body);
      assert.equal(sent.model, "gpt-image-2.5-ext");
      assert.equal(sent.version, "sunburst", "the Ext line is asked for sunburst");
      assert.equal(sent.size, "1:1", "exact pixels become a ratio: the Ext line takes no pixels");
      assert.equal(sent.resolution, "1k", "and the tier they come to");
      assert.equal(sent.n, 2);
      assert.equal(sent.quality, "high");
      assert.equal(sent.output_format, "png");
      assert.equal(calls[0].url, `${BASE}/images/generations`, "the request goes to APIMart's own URL");
    },
  );
  assert.equal(polls, 2, "the task is asked after until it is done");

  // the same, through a -flare id: the base model, the named version
  await withFetch(
    (url) => (url.endsWith("/images/generations") ? json({ code: 200, data: [{ task_id: "task_A" }] }) : json(done)),
    async (calls) => {
      const res = await loader.fetch(`${BASE}/images/generations`, { method: "POST", body: JSON.stringify({ model: "gpt-image-2.5-ext-flare", prompt: "a bird" }) });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(calls[0].body).model, "gpt-image-2.5-ext", "the base id is what APIMart is asked for");
      assert.equal(JSON.parse(calls[0].body).version, "flare");
    },
  );
  console.log("draw: ok");
}

// 5. the Ext line's answer shape (data is an object, id not task_id)
{
  const plugin = await ApimartPlugin({}, { pollMs: 1, waitMs: 1000 });
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  let polls = 0;
  await withFetch(
    (url) => {
      if (url.endsWith("/images/generations")) {
        return json({ code: 200, request_id: "r", data: { id: "task_B", object: "generation.task", status: "pending", progress: 0, poll_url: "/v1/tasks/task_B" } });
      }
      polls += 1;
      return json(polls < 2 ? { code: 200, data: { id: "task_B", status: "processing" } } : done);
    },
    async () => {
      const res = await loader.fetch(`${BASE}/images/generations`, { method: "POST", body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt: "a dog" }) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).data.length, 2);
    },
  );
  console.log("ext submit shape: ok");
}

// 6. a failed task is the caller's error, with APIMart's reason
{
  const plugin = await ApimartPlugin({}, { pollMs: 1, waitMs: 1000 });
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  await withFetch(
    (url) => (url.endsWith("/images/generations") ? json({ code: 200, data: [{ task_id: "task_A" }] }) : json({ code: 200, data: { status: "failed", error: { message: "size is not a multiple of 16" } } })),
    async () => {
      const res = await loader.fetch(`${BASE}/images/generations`, { method: "POST", body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt: "a dog" }) });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error.message, /multiple of 16/);
    },
  );
  console.log("failed task: ok");
}

// 7. an image model asked on chat completions answers 405, a chat model passes through
{
  const plugin = await ApimartPlugin({}, { pollMs: 1, waitMs: 1000 });
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  await withFetch(
    () => json({ choices: [{ message: { content: "hi" } }] }),
    async (calls) => {
      const named = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gemini-nano-banana-2.1", messages: [] }) });
      assert.equal(named.status, 405, "an image model on chat is told to draw instead");
      const ext = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-image-2.5-ext-sunburst", messages: [] }) });
      assert.equal(ext.status, 405);
      const text = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5.2", messages: [] }) });
      assert.equal(text.status, 200, "a text model is passed through");
      assert.equal(calls.length, 1, "only the text model reached APIMart");
    },
  );
  console.log("chat routing: ok");
}

// 8. what the model list holds, with and without discovery
{
  const listed = {
    data: [
      { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare" },
      { id: "gemini-nano-banana-2.1", name: "Nano Banana 2.1" },
      { id: "gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash Image" },
      { id: "midjourney", name: "Midjourney" },
      { id: "wan2.7", name: "Wan 2.7" },
      { id: "grok-imagine-1.5-edit-apimart", name: "Grok Imagine Edit" },
      { id: "wan3.0-video", name: "Wan 3.0 Video" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ],
  };
  const auth = { type: "api", key: "sk-test" };

  const off = await ApimartPlugin({}, undefined);
  await withFetch(
    () => json(listed),
    async (calls) => {
      const models = await off.provider.models({ models: {} }, { auth });
      assert.deepEqual(Object.keys(models).sort(), ["gemini-nano-banana-2.1", "gemini-nano-banana-2.1-ext", "gpt-image-2.5-ext", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
      assert.equal(calls.length, 0, "APIMart isn't asked at all");
    },
  );

  const on = await ApimartPlugin({}, { discover: true });
  await withFetch(
    () => json(listed),
    async () => {
      const models = await on.provider.models({ models: {} }, { auth });
      assert.ok(models["gemini-3.1-flash-image-preview"], "a Gemini image model is merged in");
      assert.ok(!models["midjourney"], "Midjourney is left out: its own route, not the images API");
      assert.ok(!models["wan2.7"], "a Wan video model is left out");
      assert.ok(!models["grok-imagine-1.5-edit-apimart"], "an edit-only model is left out");
      assert.ok(!models["wan3.0-video"], "a video model is left out");
      assert.ok(!models["gpt-5.2"], "a text model is left out");
    },
  );

  const own = await ApimartPlugin({}, { models: ["gpt-image-2.5-ext-flare", "gpt-image-2.5-ext-sunburst"] });
  const cfg = {};
  await own.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider.apimart.models), ["gpt-image-2.5-ext-flare", "gpt-image-2.5-ext-sunburst"]);
  assert.equal(cfg.provider.apimart.models["gpt-image-2.5-ext-flare"].name, "GPT Image 2.5 Ext（Ext 线 · Flare）");
  assert.equal(cfg.provider.apimart.models["gpt-image-2.5-ext-sunburst"].name, "GPT Image 2.5 Ext（Ext 线 · Sunburst）");
  assert.equal(label("gemini-nano-banana-2.1"), MODELS["gemini-nano-banana-2.1"]);
  console.log("model list: ok");
}

// 9. the balance it reports
{
  const plugin = await ApimartPlugin({}, undefined);
  const auth = { type: "api", key: "sk-test" };
  await withFetch(
    () => json({ success: true, unlimited_quota: false, used_balance: 3, remain_balance: 7 }),
    async () => {
      const usage = await plugin.auth.usage(async () => auth);
      assert.equal(usage.plan, "APIMart");
      assert.equal(usage.balance, "$7.00 left");
      assert.equal(usage.windows[0].used, 30);
      assert.equal(usage.windows[0].limit, 10);
      assert.equal(usage.windows[0].unit, "USD");
    },
  );
  await withFetch(
    () => json({ success: true, unlimited_quota: true, used_balance: 14.73, remain_balance: -1 }),
    async () => {
      const usage = await plugin.auth.usage(async () => auth);
      assert.equal(usage.plan, "Unlimited");
      assert.equal(usage.balance, "$14.73 used");
      assert.deepEqual(usage.windows, []);
    },
  );
  console.log("usage: ok");
}

assert.equal(_internal.PROVIDER, "apimart");
console.log("\nthe plugin and the shared core behave as magpie will use them");
