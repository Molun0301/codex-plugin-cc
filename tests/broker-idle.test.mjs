import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const IDLE_MS = 300;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition.");
}

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  return { repo, env: { ...buildEnv(binDir), CODEX_COMPANION_BROKER_IDLE_MS: String(IDLE_MS) } };
}

test("shared broker exits after idle timeout and removes its session files", async () => {
  const { repo, env } = setupRepo();
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session);
  assert.equal(loadBrokerSession(repo)?.endpoint, session.endpoint);

  await waitFor(() => !isAlive(session.pid), 5000);
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("shared broker keeps a running turn alive after its client disconnects", async () => {
  // interruptible-slow-task 的轮次约 5 秒后结束。
  const { repo, env } = setupRepo("interruptible-slow-task");
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session);

  const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
  const { thread } = await client.request("thread/start", { cwd: repo });
  await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "slow work" }] });
  await client.close();

  await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 5));
  assert.equal(isAlive(session.pid), true);

  await waitFor(() => !isAlive(session.pid), 10000);
  assert.equal(loadBrokerSession(repo), null);
});
