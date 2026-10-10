#!/usr/bin/env node
// A stdio MCP server that draws with APIMart, for magpie's library to give the
// agents. It is the syncable half of this repository: magpie's library (its
// MCP servers included) travels through WebDAV, so a machine that syncs gets
// this tool with no install — where the provider plugin (index.mjs) has to be
// added on each machine by hand.
//
// It speaks newline-delimited JSON-RPC on stdin and stdout, as magpie's own
// `magpie mcp image` does, and is driven the same way: an image often takes
// longer than an agent waits, so a call that isn't done within
// answerWithin says so and gives an id to wait on with generation_result.
// Images are saved as files in the project and the path is what the agent
// gets, the same shape magpie's own tool answers in.
//
// What it needs:
//   APIMART_API_KEY          the key (else the macOS Keychain item of that name)
//   APIMART_IMAGE_MODEL      default gpt-image-2.5-flare
//   APIMART_IMAGE_SIZE       default 1024x1024 (WIDTHxHEIGHT, a ratio, or auto)
//   APIMART_IMAGE_QUALITY    default medium (low, medium, high, xhigh, max)
//   APIMART_BASE_URL         default https://api.apimart.ai/v1
//   APIMART_ANSWER_WITHIN_MS default 20000 — how long one call waits inline
//   APIMART_POLL_MS          default 2500 — how often a task is asked after
//   APIMART_NO_PROXY=1       reach APIMart without a proxy (a local stand-in)

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { draw, keyFrom, requester, sleep, whole, ApimartError, WAIT_MS } from "./core.mjs";
const SERVER = "apimart-image";
const VERSION = "1.0.0";
const FOLDER = "generated-images";
const TOOL = "generate_image";
const RESULT_TOOL = "generation_result";

const defaultModel = process.env.APIMART_IMAGE_MODEL || "gpt-image-2.5-flare";
const defaultSize = process.env.APIMART_IMAGE_SIZE ?? "1024x1024";
const defaultQuality = process.env.APIMART_IMAGE_QUALITY ?? "medium";
const answerWithin = whole(process.env.APIMART_ANSWER_WITHIN_MS, 500, 300000) ?? 20000;
const pollMs = whole(process.env.APIMART_POLL_MS, 100, 60000);
const call = requester();

// jobs are the drawings this process has going or has finished, by id: a call
// that answered "not ready" leaves one running here.
const jobs = new Map();
let answered = 0;

const schema = {
  name: TOOL,
  description:
    "Generate an image from a text prompt with APIMart (GPT Image 2.5 and Nano Banana 2.1, official and Ext lines). " +
    "The image is saved as a file in the project (" +
    FOLDER +
    "/ unless path says where) and its path is returned; when it isn't ready within about " +
    Math.round(answerWithin / 1000) +
    " seconds the answer is an id to wait on with " +
    RESULT_TOOL +
    " instead. Reference it from code or docs by that path. " +
    "Write a detailed prompt: subject, style, composition, colours, and any text to render exactly (Chinese is rendered well).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw. Chinese or English." },
      model: {
        type: "string",
        description:
          "Which APIMart model: gpt-image-2.5-flare or gpt-image-2.5-sunburst (official line, token billing), " +
          "gpt-image-2.5-ext (Ext line, flat per image, cheaper at high quality/size), " +
          "gemini-nano-banana-2.1 or gemini-nano-banana-2.1-ext. Default: " +
          defaultModel +
          ".",
      },
      size: { type: "string", description: "WIDTHxHEIGHT (1024x1024, 2048x2048 = 2K, 2880x2880 = 4K), an aspect ratio (16:9), or auto. Default: " + defaultSize + "." },
      quality: { type: "string", description: "low, medium, high, xhigh, max — GPT Image 2.5 only, and higher costs more on the official line. Default: " + defaultQuality + "." },
      path: { type: "string", description: "Where to save it: a file (assets/hero.png) or a folder, relative to the project or absolute." },
    },
    required: ["prompt"],
  },
};

const resultSchema = {
  name: RESULT_TOOL,
  description: "Wait for a drawing started by " + TOOL + " that wasn't ready yet, and get its file path.",
  inputSchema: { type: "object", properties: { id: { type: "string", description: "The id " + TOOL + " answered with." } }, required: ["id"] },
};

const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (...parts) => process.stderr.write(`[${SERVER}] ${parts.join(" ")}\n`);

function reply(id, result) {
  out({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  out({ jsonrpc: "2.0", id, error: { code, message } });
}

// start begins a drawing and gives back its job at once: it goes on whether or
// not a call is still waiting on it.
function start(args) {
  const id = `apimart-${Date.now().toString(36)}-${(answered += 1)}`;
  const job = { id, started: Date.now(), done: false };
  jobs.set(id, job);
  job.work = (async () => {
    const key = await keyFrom();
    const drawn = await draw(
      {
        model: args.model || defaultModel,
        prompt: args.prompt,
        size: args.size ?? defaultSize,
        quality: args.quality ?? defaultQuality,
      },
      { key, request: call, pollMs, signal: AbortSignal.timeout(WAIT_MS + 30000) },
    );
    job.paths = await save(drawn.urls, args.path);
    job.model = drawn.model;
    job.size = drawn.size;
    job.resolution = drawn.resolution;
  })()
    .catch((e) => {
      job.error = e instanceof ApimartError ? e.message : String(e?.message ?? e);
    })
    .finally(() => {
      job.done = true;
      job.took = Math.round((Date.now() - job.started) / 1000);
      log(`job ${id} ${job.error ? "failed" : "ready"} in ${job.took}s`);
    });
  return job;
}

// save writes every image of a drawing into the project and answers with the
// paths, as magpie's own image tool does.
async function save(urls, where) {
  const asked = typeof where === "string" && where.trim() !== "" ? where.trim() : "";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const paths = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the image at ${url} answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const name = urls.length > 1 ? `apimart-${stamp}-${i + 1}.png` : `apimart-${stamp}.png`;
    // the name asked for, when it is a file; a folder (or something with no
    // extension) takes the generated one inside it
    const named = asked !== "" && !/[\\/]$/.test(asked) && /\.[a-z0-9]{2,5}$/i.test(asked);
    let to = asked === "" ? join(FOLDER, name) : named ? asked : join(asked, name);
    if (named && urls.length > 1) to = asked.replace(/(\.[a-z0-9]{2,5})$/i, `-${i + 1}$1`);
    const abs = isAbsolute(to) ? to : resolve(process.cwd(), to);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    paths.push(to);
  }
  return paths;
}

function said(job) {
  const head = `Drew with ${job.model}${job.resolution ? ` (${job.resolution}${job.size ? `, ${job.size}` : ""})` : ""}`;
  return `${head} in ${job.took}s, saved to:\n` + job.paths.map((p) => `- ${p}`).join("\n") + `\n\nReference it by that path.`;
}

async function callTool(name, args) {
  if (name === TOOL) {
    const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
    if (prompt === "") return { content: [{ type: "text", text: "say what to draw in prompt" }], isError: true };
    const job = start({ ...args, prompt });
    return await promiseOf(job);
  }
  if (name === RESULT_TOOL) {
    const id = typeof args?.id === "string" ? args.id.trim() : "";
    const job = jobs.get(id);
    if (!job) return { content: [{ type: "text", text: `no drawing of mine has id ${JSON.stringify(id)}` }], isError: true };
    if (job.done && !job.error) return { content: [{ type: "text", text: said(job) }] };
    if (job.done && job.error) return { content: [{ type: "text", text: `APIMart couldn't draw it: ${job.error}` }], isError: true };
    await job.work;
    if (job.error) return { content: [{ type: "text", text: `APIMart couldn't draw it: ${job.error}` }], isError: true };
    return { content: [{ type: "text", text: said(job) }] };
  }
  return { content: [{ type: "text", text: `no tool named ${JSON.stringify(name)}` }], isError: true };
}

// promiseOf waits a drawing out inline, and answers the id when it outlasts
// what an agent waits.
async function promiseOf(job) {
  await Promise.race([job.work, sleep(answerWithin)]);
  if (job.done && !job.error) {
    jobs.delete(job.id);
    return { content: [{ type: "text", text: said(job) }] };
  }
  if (job.done) return { content: [{ type: "text", text: `APIMart couldn't draw it: ${job.error}` }], isError: true };
  return {
    content: [
      {
        type: "text",
        text: `Still drawing after ${answerWithin / 1000}s.\nDon't ask for it again: call ${RESULT_TOOL} with id ${JSON.stringify(job.id)} to wait for it and get its path.`,
      },
    ],
  };
}

// The protocol: newline-delimited JSON-RPC 2.0 on stdin and stdout.
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return fail(null, -32700, "that isn't JSON");
  }
  const { id, method, params } = message;
  if (method === undefined) return; // a reply to something we sent: nothing to do
  if (method.startsWith("notifications/")) return; // no answer to a notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER, version: VERSION },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [schema, resultSchema] });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        return reply(id, await callTool(name, args));
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `no method named ${JSON.stringify(method)}`);
  }
});
lines.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
log(`ready · model ${defaultModel} · size ${defaultSize} · answering within ${answerWithin / 1000}s`);
