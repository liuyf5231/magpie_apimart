// Checks the MCP server end to end without touching APIMart (or spending
// anything): a local stand-in answers as APIMart does, the server is spawned
// the way an agent spawns it, and the JSON-RPC it speaks is driven by hand.
// Run it with `node test-mcp.mjs`.
//
// It covers the protocol an agent needs (initialize, tools/list, tools/call),
// both tools, the size and version a request carries, the file it saves, and
// the answer a call that outlasts the agent's patience gives — the id to wait
// on with generation_result.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// standIn is an APIMart that takes `polls` asks after a task to finish it.
async function standIn({ polls = 0 } = {}) {
  const seen = [];
  let asked = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (payload, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url.endsWith("/images/generations")) return send({ code: 200, data: [{ status: "submitted", task_id: "task_A" }] });
      if (req.url.includes("/tasks/")) {
        asked += 1;
        if (asked <= polls) return send({ code: 200, data: { id: "task_A", status: "processing", progress: 10 } });
        return send({ code: 200, data: { id: "task_A", status: "completed", progress: 100, cost: 0.02, credits_cost: 0.2, result: { images: [{ url: [`http://127.0.0.1:${server.address().port}/one.png`] }] } } });
      }
      if (req.url.endsWith("/one.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no ${req.url}` } }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, seen, port: server.address().port, close: () => new Promise((ok) => server.close(ok)) };
}

// start runs the MCP server the way an agent would, over a pipe.
async function start({ dir, base, answerWithin = 5000 }) {
  const child = spawn(process.execPath, [new URL("./mcp.mjs", import.meta.url).pathname], {
    cwd: dir,
    env: {
      ...process.env,
      APIMART_API_KEY: "sk-test-key",
      APIMART_BASE_URL: base,
      APIMART_NO_PROXY: "1",
      APIMART_ANSWER_WITHIN_MS: String(answerWithin),
      APIMART_POLL_MS: "100",
      APIMART_IMAGE_MODEL: "gpt-image-2.5-flare",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiting = new Map();
  const errors = [];
  child.stdout.on("data", (c) => {
    buffer += c.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === "") continue;
      const message = JSON.parse(line);
      const give = waiting.get(message.id);
      if (give) {
        waiting.delete(message.id);
        give(message);
      }
    }
  });
  child.stderr.on("data", (c) => errors.push(c.toString()));
  let next = 0;
  const speak = (method, params) =>
    new Promise((ok, no) => {
      const id = (next += 1);
      waiting.set(id, ok);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (waiting.delete(id)) no(new Error(`${method} never answered; stderr:\n${errors.join("")}`));
      }, 30000);
    });
  const tool = async (name, args) => {
    const res = await speak("tools/call", { name, arguments: args });
    return { text: res.result.content.map((c) => c.text).join("\n"), isError: res.result.isError === true };
  };
  return { child, speak, tool, errors, stop: () => child.kill("SIGTERM") };
}

// 1. a drawing that finishes inside the call
{
  const dir = await mkdtemp(join(tmpdir(), "mcp-test-"));
  const apimart = await standIn({ polls: 1 });
  const mcp = await start({ dir, base: `http://127.0.0.1:${apimart.port}/v1` });
  try {
    const hello = await mcp.speak("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(hello.result.serverInfo.name, "apimart-image");
    assert.ok(hello.result.capabilities.tools, "it says it has tools");

    const list = await mcp.speak("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["generate_image", "generation_result"]);
    assert.ok(list.result.tools[0].inputSchema.required.includes("prompt"), "a prompt is required");

    const drawn = await mcp.tool("generate_image", { prompt: "a cat on a table", model: "gpt-image-2.5-ext", size: "2880x2880" });
    assert.ok(!drawn.isError, `expected an image, got: ${drawn.text}`);
    const path = /- ([^\n]+)/.exec(drawn.text)?.[1];
    assert.ok(path, `the answer names a file: ${drawn.text}`);
    assert.ok(path.startsWith("generated-images/"), `saved in the folder: ${path}`);
    assert.ok((await stat(join(dir, path))).size > 0, "and the file is there");
    assert.deepEqual([...PNG], [...(await readFile(join(dir, path)))], "with the image APIMart served");

    const submit = apimart.seen.find((c) => c.url.endsWith("/images/generations"));
    assert.equal(submit.body !== "", true, "the request carried a body");
    const sent = JSON.parse(submit.body);
    assert.equal(sent.model, "gpt-image-2.5-ext");
    assert.equal(sent.version, "sunburst", "the Ext line is asked for sunburst");
    assert.equal(sent.size, "1:1", "pixels became a ratio: the Ext line takes no pixels");
    assert.equal(sent.resolution, "4k", "and its tier");
    assert.equal(submit.auth, "Bearer sk-test-key", "the key is sent");
    console.log("generate_image: ok");
  } finally {
    mcp.stop();
    await apimart.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 2. a drawing that outlasts the call: an id, then generation_result
{
  const dir = await mkdtemp(join(tmpdir(), "mcp-test-"));
  const apimart = await standIn({ polls: 9 });
  const mcp = await start({ dir, base: `http://127.0.0.1:${apimart.port}/v1`, answerWithin: 600 });
  try {
    await mcp.speak("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const started = await mcp.tool("generate_image", { prompt: "a slow one", model: "gpt-image-2.5-flare", size: "1024x1024" });
    assert.ok(!started.isError, started.text);
    assert.match(started.text, /Still drawing/, `a slow drawing answers with an id: ${started.text}`);
    const id = /id ("[^"]+")/.exec(started.text)?.[1];
    assert.ok(id, `the answer names the id: ${started.text}`);

    const got = await mcp.tool("generation_result", { id: JSON.parse(id) });
    assert.ok(!got.isError, got.text);
    assert.match(got.text, /saved to:/, "and the path comes with it");
    const path = /- ([^\n]+)/.exec(got.text)?.[1];
    assert.ok((await stat(join(dir, path))).size > 0, "the file was written after the call answered");

    const lost = await mcp.tool("generation_result", { id: "apimart-nope" });
    assert.ok(lost.isError, "an id that isn't ours is an error");
    console.log("generation_result: ok");
  } finally {
    mcp.stop();
    await apimart.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 3. APIMart's own failure is told to the agent, not swallowed
{
  const dir = await mkdtemp(join(tmpdir(), "mcp-test-"));
  const apimart = await standIn({ polls: 1 });
  const failing = spawn(process.execPath, [new URL("./mcp.mjs", import.meta.url).pathname], {
    cwd: dir,
    env: { ...process.env, APIMART_API_KEY: "", APIMART_BASE_URL: `http://127.0.0.1:${apimart.port}/v1`, APIMART_NO_PROXY: "1", APIMART_ANSWER_WITHIN_MS: "2000", APIMART_POLL_MS: "100" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const answer = await new Promise((ok) => {
      let buffer = "";
      failing.stdout.on("data", (c) => {
        buffer += c.toString();
        const lines = buffer.split("\n").filter((l) => l.trim() !== "");
        buffer = "";
        for (const l of lines) {
          const m = JSON.parse(l);
          if (m.id === 1) {
            failing.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "x" } } }) + "\n");
          }
          if (m.id === 2) ok(m.result);
        }
      });
      failing.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    });
    // no APIMART_API_KEY in the environment: this machine's Keychain may have
    // one, so either an image is drawn or the error says what to set
    const text = answer.content.map((c) => c.text).join("\n");
    assert.ok(answer.isError || /saved to:/.test(text), `one or the other: ${text}`);
    console.log("no key in the environment: ok");
  } finally {
    failing.kill("SIGTERM");
    await apimart.close();
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("\nthe MCP server draws, saves and answers as an agent expects");
