// OpenCode provider plugin (loaded by magpie): APIMart's image models.
//
// magpie's gateway reads an image API's answer as OpenAI's
// (data[].b64_json | url), and APIMart answers with a task instead of an
// image. So this plugin's fetch submits the task, waits it out, and answers
// the gateway in OpenAI's shape. Nothing in magpie has to know: the gateway
// hands an images request to a plugin provider's fetch
// (internal/provider/pluginFetch → Provider.Do → Account.transport →
// host.js fetchAs), and this plugin is that provider's. The round trip itself,
// the sizes and the lines live in core.mjs — mcp.mjs uses the same ones.
//
// What is offered, and how the two lines are chosen
// -------------------------------------------------
// The default models are APIMart's GPT Image 2.5 and Nano Banana 2.1 on both
// of its lines. A line is a model id (there is no separate switch for it):
// gpt-image-2.5-flare and -sunburst are the official line (token billing),
// gpt-image-2.5-ext is the Ext line (per image, flat), and Nano Banana 2.1
// has one id per line. The Ext line is one model id whose flare/sunburst
// version is a field of its own, so that one is chosen rather than named:
// options.versions maps a model id to "flare" or "sunburst" (default
// gpt-image-2.5-ext → sunburst, because the two cost the same there and
// sunburst is the one that edits precisely), and options.extVersion is the
// fallback. An id ending in -flare or -sunburst whose base is an Ext model
// stands for that version of it, so listing both offers both as models.
//
// options.discover (default off) merges every image model APIMart's /v1/models
// lists in beside these; left off, only what is listed here is offered.
//
// Only text-to-image is wired: an edit says so (magpie sends one as multipart
// files, which APIMart takes as image_urls or an upload of its own).

import { MODELS, VERSIONS, VERSION_NAMES, balance, draw, isImaged, json, label, listing, messageOf, model, resolve } from "./core.mjs";

const PROVIDER = "apimart";

// The plugin. magpie calls it with its own input and the entry's options, and
// runs the hooks this returns.
export const ApimartPlugin = async (input, options) => {
  const opt = options ?? {};
  const versions = {};
  for (const [id, v] of Object.entries(opt.versions ?? {})) {
    if (VERSION_NAMES.includes(v)) versions[id] = v;
  }
  const settings = {
    versions,
    extVersion: VERSION_NAMES.includes(opt.extVersion) ? opt.extVersion : "sunburst",
    pollMs: opt.pollMs,
    waitMs: opt.waitMs,
  };
  const listed = Array.isArray(opt.models) && opt.models.length > 0 ? Object.fromEntries(opt.models.map((id) => [id, label(id)])) : MODELS;
  const served = { ...settings, models: listed, discover: opt.discover === true };

  return {
    // The provider and the models it has before anyone signs in.
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "APIMart",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.apimart.ai/v1",
        models: Object.fromEntries(Object.entries(listed).map(([id, name]) => [id, model(name)])),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "APIMart API key", placeholder: "sk-…" }],

      // What every request of this account is sent with. The images one is
      // drawn here: submitted, waited for, and answered as OpenAI's images API
      // answers, because that is what the caller asked magpie for.
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth || auth.type !== "api") return {};
        const key = auth.key ?? auth.token ?? "";
        return {
          baseURL: "https://api.apimart.ai/v1",
          apiKey: key,
          async fetch(request, init = {}) {
            const url = typeof request === "string" ? request : request?.url ?? String(request);
            let path = "";
            try {
              path = new URL(url).pathname;
            } catch {
              return fetch(url, init);
            }
            if (path.endsWith("/images/generations")) return images(init, key, served);
            if (path.endsWith("/images/edits")) {
              return failure(400, "APIMart edits aren't wired in this plugin: it draws from a prompt alone");
            }
            // An image model asked on chat completions is answered 405: magpie
            // reads a 404/405 as "not served here" and asks the same model on
            // the images API instead (gateway/draw.go's draw), which is where
            // this plugin draws it. Models magpie already knows draw (gpt-image,
            // seedream, wan2 …) never arrive here; its own name list misses
            // gemini-nano-banana-*, z-image-turbo, mai-image-* and midjourney.
            if (path.endsWith("/chat/completions") && isImaged(asked(init.body), served)) {
              return failure(405, "this model draws on APIMart's images API");
            }
            return fetch(url, init);
          },
        };
      },

      // magpie's own hook, which OpenCode ignores: what the key has left.
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) return { windows: [] };
        try {
          const b = await balance(auth.key ?? auth.token ?? "");
          if (b.unlimited) {
            return { plan: "Unlimited", balance: b.used == null ? "" : `$${b.used.toFixed(2)} used`, windows: [] };
          }
          if (b.used == null || b.left == null || b.used + b.left <= 0) return { plan: "APIMart", windows: [] };
          const limit = b.used + b.left;
          return {
            plan: "APIMart",
            balance: `$${b.left.toFixed(2)} left`,
            windows: [
              {
                name: "APIMart balance",
                used: Math.round((b.used / limit) * 1000) / 10,
                amount: b.used,
                limit,
                unit: "USD",
                display: `$${b.used.toFixed(2)} / $${limit.toFixed(2)}`,
                span: 0,
              },
            ],
          };
        } catch (e) {
          return { error: `APIMart: ${e?.message ?? e}`, windows: [] };
        }
      },
    },

    // The models this account has. With options.discover off it is the list
    // above; on, APIMart's own list is merged in beside it. A failure of the
    // ask keeps the list we already had, as magpie asks of a plugin.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const own = Object.fromEntries(Object.entries(listed).map(([id, name]) => [id, model(name)]));
        if (!served.discover || !auth || (auth.type !== "api" && !auth.key)) return own;
        try {
          return { ...own, ...(await listing(auth.key ?? auth.token ?? "")) };
        } catch {
          return own;
        }
      },
    },
  };
};

// images is one images request as the gateway sends it, drawn and answered.
async function images(init, key, served) {
  const body = bodyOf(init.body);
  if (body == null) return failure(400, "no request body to draw from");
  if (body instanceof FormData) {
    return failure(400, "APIMart takes reference images as public URLs or an upload of its own, not as files: this plugin draws from a prompt alone for now");
  }
  try {
    const out = await draw(
      {
        model: body.model,
        prompt: body.prompt,
        n: body.n,
        size: body.size,
        quality: body.quality,
        background: body.background,
        output_format: body.output_format,
        output_compression: body.output_compression,
      },
      { ...served, key, signal: init.signal },
    );
    return answer({ created: Math.floor(Date.now() / 1000), data: out.urls.map((u) => ({ url: u })) }, 200);
  } catch (e) {
    return failure(e?.status ?? 502, e?.message ?? String(e));
  }
}

// asked is the model of a chat request, "" when its body isn't JSON.
function asked(body) {
  const parsed = bodyOf(body);
  if (!parsed || parsed instanceof FormData) return "";
  const m = parsed.model;
  return typeof m === "string" ? m : "";
}

function bodyOf(body) {
  if (body == null) return null;
  if (typeof body === "string") return body.trim() === "" ? null : json(body);
  if (body instanceof FormData) return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
    return text.trim() === "" ? null : json(text);
  }
  if (typeof body === "object") return body;
  return null;
}

function answer(payload, status) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// failure is an error in the shape OpenAI's own images API uses.
function failure(status, message) {
  const code = typeof status === "number" && status >= 400 ? status : 502;
  return answer({ error: { message: String(message ?? ""), type: code === 400 ? "invalid_request_error" : "api_error" } }, code);
}

// What the tests reach; the entry file exports no other function, as magpie
// calls every function a plugin module exports.
export const _internal = { PROVIDER, MODELS, VERSIONS, resolve, isImaged, label, bodyOf, asked };
