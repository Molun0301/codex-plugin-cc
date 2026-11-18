import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession, waitForBrokerEndpoint } from "./broker-lifecycle.mjs";
import { resolveStateDir } from "./state.mjs";

export async function withJobSpeedLock(cwd, job, action) {
  const key = createHash("sha256").update(job.threadId).digest("hex").slice(0, 16);
  const file = path.join(resolveStateDir(cwd), `speed-${key}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const owner = Number(fs.readFileSync(file, "utf8"));
    let abandoned = false;
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (probe) {
        abandoned = probe.code === "ESRCH";
      }
    }
    if (!abandoned) {
      throw new Error("A speed change is already in progress for this conversation. Retry after it finishes.");
    }
    fs.unlinkSync(file);
    descriptor = fs.openSync(file, "wx");
  }
  try {
    fs.writeFileSync(descriptor, String(process.pid));
    return await action();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
  }
}

export async function updateJobServiceTier(cwd, job, serviceTier) {
  const running = job.status === "running";
  const savedEndpoint = job.runtimeEndpoint ?? process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint;
  const endpoint = savedEndpoint && await waitForBrokerEndpoint(savedEndpoint, 150) ? savedEndpoint : null;
  if (running && (job.runtimeTransport === "direct" || !endpoint)) {
    throw new Error("This running job has no reachable shared runtime. Wait for it to finish, then change its speed.");
  }
  const client = await CodexAppServerClient.connect(cwd, {
    ...(endpoint ? { brokerEndpoint: endpoint } : {}),
    disableBroker: !endpoint && Boolean(job.runtimeEndpoint),
    reuseExistingBroker: true,
    requestTimeoutMs: 10000
  });
  const result = {
    serviceTier,
    updatedAt: new Date().toISOString(),
    futureTurns: "applied",
    activeTurn: "notRunning",
    error: null
  };
  try {
    if (!running) {
      // 只加载已有对话，不创建轮次，也不覆盖模型、强度或权限。
      await client.request("thread/resume", { threadId: job.threadId, cwd });
    }
    await client.request("thread/settings/update", { threadId: job.threadId, serviceTier });
    if (running) {
      try {
        const response = await client.request("turn/settings/update", {
          threadId: job.threadId,
          turnId: job.turnId,
          serviceTier
        });
        if (!["applied", "targetUnavailable"].includes(response.status)) {
          throw new Error("Codex returned an unknown settings-update status.");
        }
        result.activeTurn = response.status;
      } catch (error) {
        result.activeTurn = "failed";
        result.error = String(error.message ?? error);
      }
    }
    return result;
  } catch (error) {
    throw new Error(`Speed change failed: ${error.message ?? error}. If this runtime predates the plugin update, reload plugins after its jobs finish.`);
  } finally {
    await client.close();
  }
}
