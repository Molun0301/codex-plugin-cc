import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { listJobs, readJobFile, resolveJobFile, writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { withJobSpeedLock } from "../plugins/codex/scripts/lib/speed-control.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function setup(t, behavior = "review-ok") {
  const workspace = makeTempDir("cc-fast-work-");
  const bin = makeTempDir("cc-fast-bin-");
  installFakeCodex(bin, behavior);
  const env = buildEnv(bin);
  const call = (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: workspace, env });
  const state = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  t.after(async () => {
    const broker = loadBrokerSession(workspace);
    if (broker) {
      await sendBrokerShutdown(broker.endpoint);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { workspace, bin, env, call, state };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("等待任务状态超时");
}

async function launchLive(f) {
  const launch = f.call("task", "--background", "--json", "--service-tier", "default", "只读检查");
  assert.equal(launch.status, 0, launch.stderr);
  const id = JSON.parse(launch.stdout).jobId;
  return waitFor(() => listJobs(f.workspace).find((job) => job.id === id && job.status === "running" && job.turnId));
}

test("快速参数跨越真实子进程并保持模型和 ultra 强度，恢复时可关闭快速模式", (t) => {
  const f = setup(t);
  const first = f.call("task", "--fast", "--model", "gpt-6.1-sol", "--effort", "ultra", "只读检查");
  assert.equal(first.status, 0, first.stderr);
  const initial = f.state();
  assert.equal(initial.lastThreadStart.serviceTier, "fast");
  assert.equal(initial.lastTurnStart.serviceTier, "fast");
  assert.equal(initial.lastTurnStart.model, "gpt-6.1-sol");
  assert.equal(initial.lastTurnStart.effort, "ultra");
  assert.doesNotMatch(initial.lastTurnStart.prompt, /--fast/);
  const second = f.call("task", "--resume", "--service-tier", "DEFAULT", "继续检查");
  assert.equal(second.status, 0, second.stderr);
  const resumed = f.state();
  assert.equal(resumed.threads.length, 1);
  assert.equal(resumed.lastThreadResume.threadId, initial.lastTurnStart.threadId);
  assert.equal(resumed.lastThreadResume.serviceTier, "default");
  assert.equal(resumed.lastTurnStart.serviceTier, "default");
});

test("未指定速度不覆盖对话档位，并从服务端读取状态", (t) => {
  const f = setup(t);
  assert.equal(f.call("task", "--fast", "只读检查").status, 0);
  const resumed = f.call("task", "--resume", "继续检查");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(Object.hasOwn(f.state().lastThreadResume, "serviceTier"), false);
  assert.equal(Object.hasOwn(f.state().lastTurnStart, "serviceTier"), false);
  assert.equal(listJobs(f.workspace)[0].serviceTier, "fast");
});

test("继续对话响应暂时返回旧档位时，状态仍显示显式请求的新档位", (t) => {
  const f = setup(t, "stale-resume-tier");
  assert.equal(f.call("task", "--service-tier", "default", "只读检查").status, 0);
  const resumed = f.call("task", "--resume", "--fast", "继续检查");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.state().lastTurnStart.serviceTier, "fast");
  assert.equal(listJobs(f.workspace)[0].serviceTier, "fast");
});

test("非法或冲突的速度参数在创建任务及启动服务之前拒绝", (t) => {
  const f = setup(t);
  for (const args of [["--service-tier", "warp"], ["--fast", "--service-tier", "default"], ["--fast=false"], ["--service-tier", ""]]) {
    const result = f.call("task", ...args, "只读检查");
    assert.equal(result.status, 1, result.stdout);
  }
  assert.deepEqual(listJobs(f.workspace), []);
  assert.equal(fs.existsSync(path.join(f.bin, "fake-codex-state.json")), false);
});

test("运行中双向切换不创建新轮次，进度通知与完成后的档位保留", async (t) => {
  const f = setup(t, "speed-live");
  const job = await launchLive(f);
  for (const tier of ["fast", "default"]) {
    const result = f.call("speed", job.id, tier, "--json");
    assert.equal(result.status, 0, result.stderr);
    const update = JSON.parse(result.stdout);
    assert.equal(update.futureTurns, "applied");
    assert.equal(update.activeTurn, "applied");
    assert.equal(f.state().activeServiceTier, tier);
    assert.equal(listJobs(f.workspace)[0].serviceTier, tier);
  }
  assert.equal(f.state().turnStartCount, 1);
  assert.deepEqual(f.state().lastTurnSettings, { threadId: job.threadId, turnId: job.turnId, serviceTier: "default" });
  const status = f.call("status", job.id);
  assert.match(status.stdout, /服务档位: default/);
  assert.match(fs.readFileSync(job.logFile, "utf8"), /速度切换期间的进度消息/);
  await waitFor(() => listJobs(f.workspace).find((item) => item.id === job.id && item.status === "completed"));
  const stored = readJobFile(resolveJobFile(f.workspace, job.id));
  assert.equal(stored.serviceTier, "default");
  assert.equal(stored.speedUpdate.activeTurn, "applied");
  assert.match(stored.result.rawOutput, /Handled the requested task/);
});

test("后续轮次成功但当前轮次拒绝时准确报告部分成功", async (t) => {
  const f = setup(t, "speed-partial");
  const job = await launchLive(f);
  const result = f.call("speed", job.id, "fast", "--json");
  assert.equal(result.status, 1, result.stderr);
  const update = JSON.parse(result.stdout);
  assert.equal(update.futureTurns, "applied");
  assert.equal(update.activeTurn, "failed");
  assert.match(update.error, /settings rejected/);
  assert.match(f.call("status", job.id).stdout, /当前轮次更新失败/);
});

test("服务端拒绝档位时不修改原状态", async (t) => {
  const f = setup(t, "speed-reject");
  const job = await launchLive(f);
  const result = f.call("speed", job.id, "fast", "--json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not allowed/);
  const current = listJobs(f.workspace).find((item) => item.id === job.id);
  assert.equal(current.serviceTier, "default");
  assert.equal(current.speedUpdate, undefined);
});

test("切换期间轮次结束时保留后续设置并报告目标已不可更新", async (t) => {
  const f = setup(t, "speed-finished");
  const job = await launchLive(f);
  const result = f.call("speed", job.id, "fast", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).activeTurn, "targetUnavailable");
  await waitFor(() => listJobs(f.workspace)[0].status === "completed");
  assert.equal(listJobs(f.workspace)[0].serviceTier, "fast");
});

test("已完成任务可设置后续速度，恢复原对话且不产生模型轮次", (t) => {
  const f = setup(t);
  assert.equal(f.call("task", "--json", "只读检查").status, 0);
  const job = listJobs(f.workspace)[0];
  const update = f.call("speed", job.id, "fast", "--json");
  assert.equal(update.status, 0, update.stderr);
  assert.equal(JSON.parse(update.stdout).activeTurn, "notRunning");
  assert.equal(f.state().turnStartCount, 1);
  assert.equal(f.state().lastThreadResume.threadId, job.threadId);
  assert.equal(Object.hasOwn(f.state().lastThreadResume, "model"), false);
  assert.equal(f.call("task", "--resume", "继续检查").status, 0);
  assert.equal(listJobs(f.workspace)[0].serviceTier, "fast");
});

test("限定控制旁路，其他对话设置和新轮次在忙碌时被拒绝", async (t) => {
  const f = setup(t, "speed-live");
  const job = await launchLive(f);
  const broker = loadBrokerSession(f.workspace);
  const client = await CodexAppServerClient.connect(f.workspace, { env: f.env, brokerEndpoint: broker.endpoint });
  try {
    await assert.rejects(client.request("thread/settings/update", { threadId: "other-thread", serviceTier: "fast" }), /busy/);
    await assert.rejects(client.request("turn/start", { threadId: job.threadId, input: [] }), /busy/);
  } finally {
    await client.close();
  }
});

test("未启动任务及其他工作区的任务不能被误切换", (t) => {
  const f = setup(t);
  upsertJob(f.workspace, { id: "task-queued", jobClass: "task", status: "queued" });
  assert.match(f.call("speed", "task-queued", "fast").stderr, /starting/);
  assert.match(f.call("speed", "task-other", "fast").stderr, /No job found/);
  assert.match(f.call("speed", "fast").stderr, /Usage/);
  assert.equal(fs.existsSync(path.join(f.bin, "fake-codex-state.json")), false);
});

test("同一对话的同时切换被串行保护，结束后可继续切换", async (t) => {
  const f = setup(t);
  const job = { threadId: "same-thread" };
  let release;
  const pending = withJobSpeedLock(f.workspace, job, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(withJobSpeedLock(f.workspace, job, () => assert.fail("不应同时执行第二次切换")), /already in progress/);
  release("first");
  assert.equal(await pending, "first");
  assert.equal(await withJobSpeedLock(f.workspace, job, () => "second"), "second");
});

test("旧任务编号不能改写同一对话的新运行任务", (t) => {
  const f = setup(t);
  upsertJob(f.workspace, { id: "task-old", jobClass: "task", status: "completed", threadId: "same-thread" });
  upsertJob(f.workspace, { id: "task-live", jobClass: "task", status: "running", threadId: "same-thread", turnId: "live-turn" });
  const result = f.call("speed", "task-old", "fast");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /running as task-live/);
  assert.equal(fs.existsSync(path.join(f.bin, "fake-codex-state.json")), false);
});

test("并行任务各自可切换，取消独立任务时连接被回收", async (t) => {
  const f = setup(t, "speed-live");
  const first = await launchLive(f);
  const second = await launchLive(f);
  assert.notEqual(first.runtimeEndpoint, second.runtimeEndpoint);
  assert.equal(second.runtimeTransport, "broker");
  const change = f.call("speed", second.id, "fast", "--json");
  assert.equal(change.status, 0, change.stderr);
  assert.equal(JSON.parse(change.stdout).activeTurn, "applied");
  assert.equal(listJobs(f.workspace).find((job) => job.id === first.id).serviceTier, "default");
  const cancel = f.call("cancel", second.id, "--json");
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).turnInterrupted, true);
  assert.equal(f.state().lastInterrupt.threadId, second.threadId);
  const endpoint = parseBrokerEndpoint(second.runtimeEndpoint);
  if (endpoint.kind === "unix") {
    await waitFor(() => !fs.existsSync(endpoint.path));
  }
});
