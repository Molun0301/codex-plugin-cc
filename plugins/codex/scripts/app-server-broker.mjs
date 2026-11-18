#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerSession, loadBrokerSession, teardownBrokerSession } from "./lib/broker-lifecycle.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
// 没有客户端连接、也没有运行中的轮次时，空闲满该时长后自行退出。
const IDLE_TIMEOUT_MS = Number(process.env.CODEX_COMPANION_BROKER_IDLE_MS) || 15 * 60 * 1000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isControlRequest(message, threadIds) {
  if (message?.method === "turn/interrupt") {
    return true;
  }
  return ["thread/settings/update", "turn/settings/update"].includes(message?.method) &&
    threadIds?.has(message.params?.threadId);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"],
    booleanOptions: ["single-task"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let primarySocket = null;
  let shuttingDown = false;
  const sockets = new Set();
  // 客户端被杀后轮次可能仍在运行，按线程记录，避免空闲退出中断 Codex 的工作。
  const runningTurnThreadIds = new Set();
  let idleTimer = null;

  function refreshIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (shuttingDown || sockets.size > 0 || runningTurnThreadIds.size > 0) {
      return;
    }
    idleTimer = setTimeout(shutdownWhenIdle, IDLE_TIMEOUT_MS);
  }

  async function shutdownWhenIdle() {
    await shutdown(server);
    // 与 SessionEnd 的清理结果保持一致；独立 broker 不写 broker.json，由调用方回收。
    const session = loadBrokerSession(cwd);
    if (session?.endpoint === endpoint) {
      teardownBrokerSession(session);
      clearBrokerSession(cwd);
    }
    process.exit(0);
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    if (message.method === "turn/started") {
      runningTurnThreadIds.add(message.params?.threadId);
      refreshIdleTimer();
    } else if (message.method === "turn/completed") {
      runningTurnThreadIds.delete(message.params?.threadId);
      refreshIdleTimer();
    }
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearTimeout(idleTimer);
    // 先停止接收新连接，新调用的就绪探测失败后会另起 broker。
    const serverClosed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await serverClosed;
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    refreshIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowControlDuringActiveStream =
          isControlRequest(message, activeStreamThreadIds) && activeStreamSocket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowControlDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowControlDuringActiveStream) {
          // 控制请求复用连接，但不得接管原任务的通知流或清除其所有权。
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            primarySocket ??= socket;
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      if (options["single-task"] && primarySocket === socket && !shuttingDown) {
        // 独立任务完成或被取消后，其控制连接一并回收。
        awaitShutdown();
      }
      refreshIdleTimer();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      refreshIdleTimer();
    });
  });

  function awaitShutdown() {
    shutdown(server).finally(() => process.exit(0));
  }

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
  refreshIdleTimer();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
