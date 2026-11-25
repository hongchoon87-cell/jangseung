import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chat, chatHistory } from "./chat.ts";
import { config } from "./config.ts";
import type { Engine } from "./engine.ts";
import { toJson } from "./store.ts";
import type { Settings } from "./types.ts";
import { publicState } from "./view.ts";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(toJson(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * Dashboard and chat for the vault owner. It listens on the loopback interface only: the
 * endpoints can pause the agent and change its preferences, so they must not be reachable
 * from other machines.
 */
export function startServer(engine: Engine): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // A web page open in the owner's browser must not be able to drive these endpoints.
      // Checking the Host header stops DNS rebinding; requiring a JSON content type makes
      // cross-site requests need a CORS preflight, which this server never grants.
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") {
        send(res, 403, { error: "forbidden host" });
        return;
      }
      if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
        send(res, 415, { error: "content-type must be application/json" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(path.join(webDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        send(res, 200, { state: publicState(engine.state), chat: chatHistory() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const push = () => res.write(`data: ${toJson(publicState(engine.state))}\n\n`);
        push();
        const unsubscribe = engine.onUpdate(push);
        const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
        req.on("close", () => {
          unsubscribe();
          clearInterval(heartbeat);
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readBody(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          send(res, 400, { error: "message is required" });
          return;
        }
        send(res, 200, await chat(engine, message.slice(0, 2_000)));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await readBody(req);
        const change = engine.updateSettings(body as Partial<Settings>);
        send(res, 200, change);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tick") {
        await engine.tick();
        send(res, 200, { ok: true });
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Dashboard: http://127.0.0.1:${config.port}`);
  });
}
