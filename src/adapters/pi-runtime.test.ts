import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { closeRuntimeOwnedStandalonePrivateBuses } from "../core/auto-bus.ts";
import { createBusSubscription } from "../core/bus.ts";
import { Orchestra } from "../core/orchestra.ts";
import type { AgentRun } from "../core/subagent.ts";
import { OrchestraEventController } from "../extension/orchestra-events.ts";
import { closeWorkgroupRun } from "../tools/workgroup.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { observeAgentSessionHealth, PiAgentRuntime } from "./pi-runtime.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  // Exercise the real session factory with deterministic in-memory auth.
  const authStorage = actual.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("faux", "test");
  return {
    ...actual,
    createAgentSession: (options?: CreateAgentSessionOptions) => actual.createAgentSession({ ...options, authStorage }),
  };
});

const profile = { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined };

test("spawn completes a child conversation without creating an orchestra directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-runtime-"));
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finish", { status: "success", summary: "Done." }), {
      stopReason: "toolUse",
    }),
  ]);
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-memory", name: "bus-memory", state: "open", messages: [], nextMessageSeq: 1 });
  const runtime = new PiAgentRuntime({
    store,
    cwd,
    resolveModel: () => faux.getModel(),
    resolveCustomTools: () => [],
    ownerSessionId: "owner",
  });

  try {
    await runtime.spawn({ ...profile, model: "faux/faux-1" }, "Research.", "bus-memory", {
      id: "agent-memory",
      name: "agent-memory",
      parentRunId: null,
    });
    const promptTask = runtimeInternals(runtime).entries.get("agent-memory")?.promptTask;
    assert.ok(promptTask);
    await promptTask;

    assert.equal(store.getRun("agent-memory")?.state, "success");
    assert.equal(existsSync(join(cwd, ".pi", "orchestra")), false);
  } finally {
    runtime.dispose();
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime health reads context live and hides errors during recoverable phases", () => {
  const harness = createHealthHarness({ contextPercent: 40 });
  harness.state.errorMessage = "provider context error";

  harness.runtimeState.isStreaming = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "active", contextPercent: 40 });

  harness.runtimeState.isStreaming = false;
  harness.runtimeState.isRetrying = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "retrying", contextPercent: 40 });

  harness.runtimeState.isRetrying = false;
  harness.runtimeState.isCompacting = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "compacting", contextPercent: 40 });

  harness.runtimeState.isCompacting = false;
  harness.health.setWaiting();
  assert.deepEqual(harness.health.getSnapshot(), { phase: "waiting", contextPercent: 40 });

  harness.health.beginPrompt();
  assert.equal(harness.health.getSnapshot().finalError, "provider context error");

  harness.runtimeState.contextPercent = 60;
  assert.equal(harness.health.getSnapshot().contextPercent, 60);
});

test("finish-required retry preserves a final provider error and bounds its summary", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-required-error";
  store.saveRun(run(runId, null));
  let promptCalls = 0;
  const providerError = "provider context error ".repeat(100);
  let harness: HealthHarness;
  harness = createHealthHarness({
    prompt: async () => {
      if (++promptCalls === 2) harness.state.errorMessage = providerError;
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  const failedRun = store.getRun(runId);
  assert.equal(promptCalls, 2);
  assert.equal(failedRun?.state, "failed");
  assert.equal(failedRun?.result?.status, "failed");
  assert.match(failedRun?.result?.summary ?? "", /provider context error/);
  assert.ok((failedRun?.result?.summary.length ?? 0) <= 500);
  assert.match(failedRun?.result?.summary ?? "", /truncated/);
  assert.deepEqual(failedRun?.result?.data, { providerError });
  runtime.dispose();
});

test("final provider error waits while a direct child is active", async () => {
  const store = new InMemoryAgentStore();
  const runId = "errored-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  let promptCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      promptCalls++;
      harness.state.errorMessage = "provider failed";
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(promptCalls, 1);
  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(store.getRun(runId)?.result, null);
  assert.deepEqual(harness.health.getSnapshot(), { phase: "waiting" });
  runtime.dispose();
});

test("a thrown prompt error waits while a direct child is active", async () => {
  const store = new InMemoryAgentStore();
  const runId = "throwing-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const harness = createHealthHarness({
    prompt: async () => {
      throw new Error("provider unavailable");
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  runtime.dispose();
});

test("a preflight failure parks the unaccepted message while a direct child is active", async () => {
  const store = new InMemoryAgentStore();
  const runId = "preflight-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const resumedPromptStarted = createDeferred();
  const resumedPrompt = createDeferred();
  const prompts: string[] = [];
  let acceptPrompt = false;
  const harness = createHealthHarness({
    preflightAccepted: () => acceptPrompt,
    prompt: async (message) => {
      prompts.push(message);
      if (!acceptPrompt) throw new Error("Authentication failed.");
      if (prompts.length === 3) {
        resumedPromptStarted.resolve();
        await resumedPrompt.promise;
        store.saveRun({
          ...run(runId, null),
          state: "success",
          result: { status: "success", summary: "Original and child messages handled." },
        });
      }
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Original prompt.", busDeliveries: [] });
  const failedPreflightTask = entry.promptTask;
  assert.ok(failedPreflightTask);
  await failedPreflightTask;

  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  assert.equal(entry.queueParked, true);
  assert.deepEqual(
    entry.queuedMessages.map(({ content }) => content),
    ["Original prompt."],
  );

  store.saveRun({
    ...run("active-child", runId),
    state: "success",
    result: { status: "success", summary: "Child finished." },
  });
  acceptPrompt = true;
  await runtime.message(runId, "Child finished.");
  await resumedPromptStarted.promise;

  assert.deepEqual(prompts, ["Original prompt.", "Original prompt.", "Child finished."]);
  assert.equal(entry.queueParked, false);
  assert.deepEqual(entry.queuedMessages, []);
  const resumedTask = entry.promptTask;
  assert.ok(resumedTask);
  resumedPrompt.resolve();
  await resumedTask;

  assert.equal(store.getRun(runId)?.state, "success");
  runtime.dispose();
});

test("a message queued during preflight grants one immediate retry", async () => {
  const store = new InMemoryAgentStore();
  const runId = "queued-preflight-retry-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const preflightStarted = createDeferred();
  const failPreflight = createDeferred();
  const queuedPromptStarted = createDeferred();
  const queuedPrompt = createDeferred();
  const prompts: string[] = [];
  let acceptPrompt = false;
  const harness = createHealthHarness({
    preflightAccepted: () => acceptPrompt,
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        preflightStarted.resolve();
        await failPreflight.promise;
        throw new Error("Authentication failed.");
      }
      if (prompts.length === 3) {
        queuedPromptStarted.resolve();
        await queuedPrompt.promise;
        store.saveRun({
          ...run("active-child", runId),
          state: "success",
          result: { status: "success", summary: "Child cancelled." },
        });
        store.saveRun({
          ...run(runId, null),
          state: "success",
          result: { status: "success", summary: "Queued cancellation handled." },
        });
      }
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Original prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await preflightStarted.promise;

  await runtime.message(runId, "Cancel the child.");
  assert.deepEqual(
    entry.queuedMessages.map(({ content }) => content),
    ["Cancel the child."],
  );
  acceptPrompt = true;
  failPreflight.resolve();
  await initialTask;

  assert.deepEqual(prompts.slice(0, 2), ["Original prompt.", "Original prompt."]);
  await queuedPromptStarted.promise;
  assert.deepEqual(prompts, ["Original prompt.", "Original prompt.", "Cancel the child."]);
  assert.equal(entry.queueParked, false);
  assert.equal(entry.preflightRetryInProgress, false);
  const resumedTask = entry.promptTask;
  assert.ok(resumedTask);
  queuedPrompt.resolve();
  await resumedTask;

  assert.equal(store.getRun(runId)?.state, "success");
  runtime.dispose();
});

test("a queued preflight wake retries the unaccepted message only once", async () => {
  const store = new InMemoryAgentStore();
  const runId = "bounded-preflight-retry-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const preflightStarted = createDeferred();
  const failPreflight = createDeferred();
  const retryStarted = createDeferred();
  const failRetry = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    preflightAccepted: false,
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        preflightStarted.resolve();
        await failPreflight.promise;
      } else {
        retryStarted.resolve();
        await failRetry.promise;
      }
      throw new Error("Authentication failed.");
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Original prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await preflightStarted.promise;

  await runtime.message(runId, "Cancel the child.");
  failPreflight.resolve();
  await initialTask;
  await retryStarted.promise;
  const retryTask = entry.promptTask;
  assert.ok(retryTask);
  failRetry.resolve();
  await retryTask;

  assert.deepEqual(prompts, ["Original prompt.", "Original prompt."]);
  assert.equal(entry.queueParked, true);
  assert.equal(entry.preflightRetryInProgress, false);
  assert.deepEqual(
    entry.queuedMessages.map(({ content }) => content),
    ["Original prompt.", "Cancel the child."],
  );
  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  runtime.dispose();
});

test("a child completion waits for a parked prompt task before resuming", async () => {
  const store = new InMemoryAgentStore();
  const runId = "resumed-parent";
  const parent = run(runId, null);
  store.saveRun(parent);
  const previousPrompt = createDeferred();
  let promptCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      promptCalls++;
      harness.state.errorMessage = undefined;
      store.saveRun({ ...parent, state: "success", result: { status: "success", summary: "Resumed." } });
    },
  });
  harness.state.errorMessage = "previous provider error";
  harness.health.setWaiting();
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness, previousPrompt.promise);

  const messageTask = runtime.message(runId, "Child finished.");
  await Promise.resolve();

  assert.equal(promptCalls, 0);
  assert.deepEqual(store.getRun(runId), parent);

  previousPrompt.resolve();
  await messageTask;
  await Promise.resolve();

  assert.equal(promptCalls, 1);
  assert.equal(store.getRun(runId)?.state, "success");
  assert.equal(store.getRun(runId)?.result?.summary, "Resumed.");
  runtime.dispose();
});

test("a parked parent with a settled prompt task starts the next prompt", async () => {
  const store = new InMemoryAgentStore();
  const runId = "settled-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });

  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await initialTask;

  assert.equal(entry.promptTask, undefined);
  assert.equal(harness.health.getSnapshot().phase, "waiting");

  await runtime.message(runId, "Child finished.");
  const resumedTask = runtimeInternals(runtime).entries.get(runId)?.promptTask;
  assert.ok(resumedTask);
  await resumedTask;

  assert.deepEqual(prompts, ["Initial prompt.", "Child finished."]);
  assert.equal(store.getRun(runId)?.state, "running");
  runtime.dispose();
});

test("finish-required prompt waits for a newly spawned child", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-required-child";
  store.saveRun(run(runId, null));
  let promptCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      if (++promptCalls === 2) store.saveRun(run("new-child", runId));
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(promptCalls, 2);
  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  runtime.dispose();
});

test("message waits for a finished prompt task before resuming", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finished-parent";
  const parent = run(runId, null);
  const finishedRun: AgentRun = {
    ...parent,
    state: "success",
    result: { status: "success", summary: "First turn finished." },
  };
  store.saveRun(parent);
  const previousPrompt = createDeferred();
  const resumedPrompt = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        store.saveRun(finishedRun);
        await previousPrompt.promise;
        return;
      }
      if (prompts.length === 2) {
        await resumedPrompt.promise;
        store.saveRun({
          ...finishedRun,
          state: "success",
          result: { status: "success", summary: "Second turn finished." },
        });
        return;
      }
      assert.fail("unexpected finish-required prompt");
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  assert.deepEqual(store.getRun(runId), finishedRun);

  const savedStates: AgentRun["state"][] = [];
  const unsubscribe = store.subscribeRuns((savedRun) => savedStates.push(savedRun.state), undefined);
  const messageTask = runtime.message(runId, "Child finished.");
  await Promise.resolve();

  assert.deepEqual(prompts, ["Initial prompt."]);
  assert.deepEqual(store.getRun(runId), finishedRun);

  previousPrompt.resolve();
  const messagedRun = await messageTask;

  assert.equal(messagedRun.state, "running");
  assert.deepEqual(prompts, ["Initial prompt.", "Child finished."]);
  assert.deepEqual(savedStates, ["running"]);

  const resumedTask = entry.promptTask;
  assert.ok(resumedTask);
  resumedPrompt.resolve();
  await resumedTask;

  assert.deepEqual(prompts, ["Initial prompt.", "Child finished."]);
  assert.deepEqual(savedStates, ["running", "success"]);
  unsubscribe();
  runtime.dispose();
});

test("message rechecks a run that closes while its prompt settles", async () => {
  const store = new InMemoryAgentStore();
  const runId = "closed-parent";
  const finishedRun: AgentRun = {
    ...run(runId, null),
    state: "success",
    result: { status: "success", summary: "Finished." },
  };
  store.saveRun(finishedRun);
  const previousPrompt = createDeferred();
  const runtime = createRuntime(store);
  installEntry(runtime, runId, createHealthHarness(), previousPrompt.promise);

  const messageTask = runtime.message(runId, "Too late.");
  await runtime.close(runId);
  previousPrompt.resolve();

  await assert.rejects(messageTask, /is closed/);
  assert.equal(store.getRun(runId)?.state, "closed");
  runtime.dispose();
});

test("message queues outside Pi after the agent loop drains", async () => {
  const store = new InMemoryAgentStore();
  const runId = "settling-parent";
  store.saveRun(run(runId, null));
  const settlingPrompt = createDeferred();
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, createHealthHarness(), settlingPrompt.promise);

  await runtime.message(runId, "After queue drain.");

  assert.deepEqual(entry.queuedMessages, [{ content: "After queue drain.", busDeliveries: [] }]);
  settlingPrompt.resolve();
  runtime.dispose();
});

test("runtime and Pi queues preserve message order across prompt settlement", async () => {
  const store = new InMemoryAgentStore();
  const runId = "queued-next-turn-parent";
  store.saveRun(run(runId, null));
  const agentLoopFinished = createDeferred();
  const queueDrained = createDeferred();
  const initialPrompt = createDeferred();
  const firstQueuedStarted = createDeferred();
  const firstQueuedPrompt = createDeferred();
  const secondQueuedStarted = createDeferred();
  const secondQueuedPrompt = createDeferred();
  const thirdQueuedStarted = createDeferred();
  const thirdQueuedPrompt = createDeferred();
  const prompts: string[] = [];
  let harness: HealthHarness;
  harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        harness.runtimeState.isStreaming = true;
        await agentLoopFinished.promise;
        harness.runtimeState.isStreaming = false;
        queueDrained.resolve();
        await initialPrompt.promise;
        return;
      }

      harness.runtimeState.isStreaming = true;
      if (prompts.length === 2) {
        firstQueuedStarted.resolve();
        await firstQueuedPrompt.promise;
      } else if (prompts.length === 3) {
        secondQueuedStarted.resolve();
        await secondQueuedPrompt.promise;
      } else if (prompts.length === 4) {
        thirdQueuedStarted.resolve();
        await thirdQueuedPrompt.promise;
        store.saveRun({
          ...run(runId, null),
          state: "success",
          result: { status: "success", summary: "Queued messages finished." },
        });
      } else {
        assert.fail("unexpected prompt");
      }
      harness.runtimeState.isStreaming = false;
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  agentLoopFinished.resolve();
  await queueDrained.promise;

  await runtime.message(runId, "A");
  await runtime.message(runId, "B");
  assert.deepEqual(
    entry.queuedMessages.map(({ content }) => content),
    ["A", "B"],
  );

  initialPrompt.resolve();
  await initialTask;
  await firstQueuedStarted.promise;
  await runtime.message(runId, "C");
  assert.deepEqual(
    entry.queuedMessages.map(({ content }) => content),
    ["B", "C"],
  );

  firstQueuedPrompt.resolve();
  await secondQueuedStarted.promise;
  secondQueuedPrompt.resolve();
  await thirdQueuedStarted.promise;
  const finalTask = entry.promptTask;
  assert.ok(finalTask);
  thirdQueuedPrompt.resolve();
  await finalTask;

  assert.deepEqual(prompts, ["Initial prompt.", "A", "B", "C"]);
  assert.deepEqual(entry.queuedMessages, []);
  runtime.dispose();
});

test("an accepted prompt failure defers completion while a runtime message is queued", async () => {
  const store = new InMemoryAgentStore();
  const runId = "queued-preflight-parent";
  store.saveRun(run(runId, null));
  const providerStarted = createDeferred();
  const failProvider = createDeferred();
  const secondPromptStarted = createDeferred();
  const secondPrompt = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    preflightAccepted: true,
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        providerStarted.resolve();
        await failProvider.promise;
        throw new Error("Provider failed after prompt acceptance.");
      }
      secondPromptStarted.resolve();
      await secondPrompt.promise;
      store.saveRun({
        ...run(runId, null),
        state: "success",
        result: { status: "success", summary: "Recovered message finished." },
      });
    },
  });
  const deliveredEvents: unknown[] = [];
  const events = new OrchestraEventController({
    store,
    sendEvents: (sentEvents) => deliveredEvents.push(...sentEvents),
    isRunWaiting: () => false,
    flushDelayMs: 0,
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await providerStarted.promise;

  await runtime.message(runId, "Recover after provider failure.");
  failProvider.resolve();
  await initialTask;
  await secondPromptStarted.promise;

  events.flush();
  assert.deepEqual(deliveredEvents, []);
  assert.equal(store.getRun(runId)?.state, "running");

  const resumedTask = entry.promptTask;
  assert.ok(resumedTask);
  secondPrompt.resolve();
  await resumedTask;
  events.flush();

  assert.deepEqual(prompts, ["Initial prompt.", "Recover after provider failure."]);
  assert.equal(deliveredEvents.length, 1);
  events.dispose();
  runtime.dispose();
});

test("a preflight failure fails instead of skipping to queued messages", async () => {
  const store = new InMemoryAgentStore();
  const runId = "queued-preflight-failure";
  store.saveRun(run(runId, null));
  const preflightStarted = createDeferred();
  const failPreflight = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    preflightAccepted: false,
    prompt: async (message) => {
      prompts.push(message);
      preflightStarted.resolve();
      await failPreflight.promise;
      throw new Error("Authentication failed.");
    },
  });
  const deliveredEvents: unknown[] = [];
  const events = new OrchestraEventController({
    store,
    sendEvents: (sentEvents) => deliveredEvents.push(...sentEvents),
    isRunWaiting: () => false,
    flushDelayMs: 0,
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await preflightStarted.promise;

  await runtime.message(runId, "Must not skip the initial prompt.");
  assert.equal(entry.queuedMessages.length, 1);
  failPreflight.resolve();
  await initialTask;
  events.flush();

  assert.deepEqual(prompts, ["Initial prompt."]);
  assert.deepEqual(entry.queuedMessages, []);
  assert.equal(store.getRun(runId)?.state, "failed");
  assert.match(store.getRun(runId)?.result?.summary ?? "", /Authentication failed/);
  assert.equal(deliveredEvents.length, 1);
  events.dispose();
  runtime.dispose();
});

test("finish requires confirmation after queued messages and retains an unconfirmed result", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-with-queued-message";
  store.saveRun(run(runId, null));
  const prompts: string[] = [];
  const runtime = createRuntime(store);
  const entry = installEntry(
    runtime,
    runId,
    createHealthHarness({ prompt: async (message) => void prompts.push(message) }),
  );
  entry.queuedMessages.push({ content: "Queued message.", busDeliveries: [] });
  const finishTool = runtimeInternals(runtime)
    .createChildTools(runId)
    .find((tool) => tool.name === "finish");
  assert.ok(finishTool);

  const result = await finishTool.execute("finish-call", { status: "success", summary: "First turn." });

  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(store.getRun(runId)?.result, null);
  assert.equal(result.terminate, true);
  assert.match(finishTool.description, /call finish again to confirm or update/);
  assert.match(result.content[0]?.text ?? "", /call finish again to confirm or update/i);

  entry.queuedMessages.shift();
  await runtimeInternals(runtime).runPrompt(runId, { content: "Queued message.", busDeliveries: [] });

  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "Queued message.");
  assert.match(prompts[1] ?? "", /previous finish result was deferred/i);
  assert.equal(store.getRun(runId)?.state, "failed");
  assert.deepEqual(store.getRun(runId)?.result?.data, {
    deferredFinish: { status: "success", summary: "First turn.", data: undefined },
  });
  runtime.dispose();
});

test("close preserves a finish result deferred by queued messages", async () => {
  const store = new InMemoryAgentStore();
  const runId = "close-with-deferred-finish";
  store.saveRun(run(runId, null));
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, createHealthHarness());
  entry.queuedMessages.push({ content: "Queued message.", busDeliveries: [] });
  const finishTool = runtimeInternals(runtime)
    .createChildTools(runId)
    .find((tool) => tool.name === "finish");
  assert.ok(finishTool);
  await finishTool.execute("finish-call", {
    status: "success",
    summary: "Valuable result.",
    data: { pages: 42 },
  });

  const closedRun = await runtime.close(runId);

  assert.equal(closedRun?.state, "closed");
  assert.deepEqual(closedRun?.result, {
    status: "success",
    summary: "Valuable result.",
    data: { pages: 42 },
  });
  assert.deepEqual(store.getRun(runId)?.result, closedRun?.result);
  runtime.dispose();
});

test("workgroup teardown force-closes registered runs without cascading to nested descendants", async () => {
  const store = new InMemoryAgentStore();
  const runtime = createRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "bus-group-nested" });
  const leader = { ...run("leader", null), busId: bus.id };
  const member = { ...run("member", leader.id), busId: bus.id };
  const nested = { ...run("nested", member.id), busId: "bus-nested" };
  store.saveRun(leader);
  store.saveRun(member);
  store.saveRun(nested);
  installEntry(runtime, leader.id, createHealthHarness());
  installEntry(runtime, member.id, createHealthHarness());
  installEntry(runtime, nested.id, createHealthHarness());
  const workgroup = {
    id: "workgroup-1",
    name: "group-nested",
    busId: bus.id,
    ownerSessionId: "owner",
    goal: "Test nested teardown.",
    leaderRunId: leader.id,
    memberRunIds: [member.id],
    state: "running" as const,
    result: null,
    createdAtMs: Date.now(),
  };
  store.saveWorkgroup(workgroup);

  const closedWorkgroup = await closeWorkgroupRun(orchestra, store, workgroup, {
    includeLeader: true,
    result: { status: "blocked", summary: "Cancelled." },
  });

  assert.equal(closedWorkgroup.state, "closed");
  assert.equal(store.getBus(bus.id)?.state, "closed");
  assert.equal(store.getRun(leader.id)?.state, "closed");
  assert.equal(store.getRun(member.id)?.state, "closed");
  assert.equal(store.getRun(nested.id)?.state, "running");
  assert.deepEqual(runtime.listRunIds(), [nested.id]);
  runtime.dispose();
});

test("shutdown closes nested standalone runs and their private buses", async () => {
  const store = new InMemoryAgentStore();
  for (const bus of [
    { id: "bus-parent", name: "bus-agent-parent" },
    { id: "bus-child", name: "bus-agent-child" },
  ]) {
    store.saveBus({
      ...bus,
      state: "open",
      messages: [],
      nextMessageSeq: 1,
      metadata: { autoClose: "standalone-subagent-private", ownerSessionId: "session-1" },
    });
  }
  const parent = { ...run("parent", null), busId: "bus-parent" };
  const child = { ...run("child", parent.id), busId: "bus-child" };
  store.saveRun(parent);
  store.saveRun(child);
  const runtime = createRuntime(store);
  installEntry(runtime, parent.id, createHealthHarness());
  installEntry(runtime, child.id, createHealthHarness());
  const orchestra = new Orchestra({ runtime, store });

  await closeRuntimeOwnedStandalonePrivateBuses(store, orchestra, "session-1");

  assert.equal(store.getRun(parent.id)?.state, "closed");
  assert.equal(store.getRun(child.id)?.state, "closed");
  assert.equal(store.getBus(parent.busId)?.state, "closed");
  assert.equal(store.getBus(child.busId)?.state, "closed");
  assert.deepEqual(runtime.listRunIds(), []);
  runtime.dispose();
});

test("a leader with a running workgroup still receives the finish-required nudge", async () => {
  const store = new InMemoryAgentStore();
  const runId = "deferred-finish-workgroup";
  store.saveRun(run(runId, null));
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length !== 1) return;
      store.saveWorkgroup({
        id: "new-workgroup",
        name: "new-workgroup",
        busId: "workgroup-bus",
        ownerSessionId: "owner",
        goal: "Check X.",
        leaderRunId: runId,
        memberRunIds: [],
        state: "running",
        result: null,
        createdAtMs: Date.now(),
      });
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  entry.queuedMessages.push({ content: "Check X.", busDeliveries: [] });
  const finishTool = runtimeInternals(runtime)
    .createChildTools(runId)
    .find((tool) => tool.name === "finish");
  assert.ok(finishTool);
  await finishTool.execute("finish-call", { status: "success", summary: "Before checking X." });

  entry.queuedMessages.shift();
  await runtimeInternals(runtime).runPrompt(runId, { content: "Check X.", busDeliveries: [] });

  assert.equal(prompts[0], "Check X.");
  assert.match(prompts[1] ?? "", /previous finish result was deferred/i);
  assert.equal(store.getRun(runId)?.state, "failed");
  assert.equal(store.getWorkgroup("new-workgroup")?.state, "running");
  runtime.dispose();
});

test("finish-required preflight failure preserves messages queued during that preflight", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-preflight-queue";
  store.saveRun(run(runId, null));
  const finishPreflightStarted = createDeferred();
  const failFinishPreflight = createDeferred();
  const queuedPrompt = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    preflightAccepted: (message) => !message.startsWith("Your previous response ended without finish."),
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 2) {
        finishPreflightStarted.resolve();
        await failFinishPreflight.promise;
        throw new Error("Authentication failed before finish-required prompt.");
      }
      if (prompts.length === 3) {
        await queuedPrompt.promise;
        store.saveRun({
          ...run(runId, null),
          state: "success",
          result: { status: "success", summary: "Queued message handled." },
        });
      }
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  const initialTask = entry.promptTask;
  assert.ok(initialTask);
  await finishPreflightStarted.promise;

  await runtime.message(runId, "Queued during finish preflight.");
  failFinishPreflight.resolve();
  await initialTask;

  assert.equal(prompts[0], "Initial prompt.");
  assert.match(prompts[1] ?? "", /without finish/);
  assert.equal(prompts[2], "Queued during finish preflight.");
  assert.equal(store.getRun(runId)?.state, "running");
  const resumedTask = entry.promptTask;
  assert.ok(resumedTask);
  queuedPrompt.resolve();
  await resumedTask;

  assert.equal(store.getRun(runId)?.result?.summary, "Queued message handled.");
  assert.deepEqual(entry.queuedMessages, []);
  runtime.dispose();
});

test("a queued-message finalizer never revives a terminal run", async () => {
  const store = new InMemoryAgentStore();
  const runId = "terminal-with-queued-message";
  store.saveRun(run(runId, null));
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      store.saveRun({
        ...run(runId, null),
        state: "success",
        result: { status: "success", summary: "Already finished." },
      });
    },
  });
  const promptErrors: unknown[] = [];
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: () => [],
    ownerSessionId: "owner",
    onPromptTaskError: (_runId, error) => promptErrors.push(error),
  });
  const entry = installEntry(runtime, runId, harness);
  entry.queuedMessages.push({ content: "Do not revive.", busDeliveries: [] });

  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  await entry.promptTask;

  assert.deepEqual(prompts, ["Initial prompt."]);
  assert.equal(store.getRun(runId)?.state, "success");
  assert.deepEqual(entry.queuedMessages, []);
  assert.match(String(promptErrors[0]), /became terminal before 1 queued message/);
  runtime.dispose();
});

test("message releases bus delivery when saveRun throws", async () => {
  const store = new InMemoryAgentStore();
  const runId = "save-failure";
  const finishedRun: AgentRun = {
    ...run(runId, null),
    state: "success",
    result: { status: "success", summary: "Finished." },
  };
  store.saveRun(finishedRun);
  const subscription = addUnreadBusMessage(store, runId);
  const sentMessages: string[] = [];
  const harness = createHealthHarness({ agentSteer: (message) => sentMessages.push(message) });
  harness.runtimeState.isStreaming = true;
  const runtime = createRuntime(store);
  const activePrompt = createDeferred();
  installEntry(runtime, runId, harness, activePrompt.promise);

  const saveRun = store.saveRun.bind(store);
  let saveCalls = 0;
  store.saveRun = (savedRun) => {
    saveRun(savedRun);
    throw new Error(`save failed #${++saveCalls}`);
  };

  await assert.rejects(runtime.message(runId, "First attempt."), { message: "save failed #1" });
  store.saveRun = saveRun;

  assert.equal(saveCalls, 2);
  assert.deepEqual(store.getRun(runId), finishedRun);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 0);
  assert.deepEqual(sentMessages, []);

  await runtime.message(runId, "Retry.");

  assert.match(sentMessages[0] ?? "", /Retry this shared context\./);
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 1);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  activePrompt.resolve();
  runtime.dispose();
});

test("idle message save failure releases bus delivery for retry", async () => {
  const store = new InMemoryAgentStore();
  const runId = "idle-save-failure";
  store.saveRun(run(runId, null));
  const subscription = addUnreadBusMessage(store, runId);
  const promptStarted = createDeferred();
  const finishPrompt = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      promptStarted.resolve();
      await finishPrompt.promise;
      const currentRun = store.getRun(runId);
      assert.ok(currentRun);
      store.saveRun({
        ...currentRun,
        state: "success",
        result: { status: "success", summary: "Retry finished." },
      });
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  const saveRun = store.saveRun.bind(store);
  let rejectSave = true;
  store.saveRun = (savedRun) => {
    if (rejectSave) {
      rejectSave = false;
      throw new Error("save failed");
    }
    saveRun(savedRun);
  };

  await assert.rejects(runtime.message(runId, "First attempt."), { message: "save failed" });

  assert.deepEqual(prompts, []);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 0);

  await runtime.message(runId, "Retry.");
  await promptStarted.promise;
  const promptTask = entry.promptTask;
  assert.ok(promptTask);
  finishPrompt.resolve();
  await promptTask;

  assert.match(prompts[0] ?? "", /Retry this shared context\./);
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 1);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  runtime.dispose();
});

test("message releases bus delivery when prompt rejects", async () => {
  const store = new InMemoryAgentStore();
  const runId = "prompt-failure";
  store.saveRun(run(runId, null));
  const subscription = addUnreadBusMessage(store, runId);
  const firstPromptStarted = createDeferred();
  const rejectFirstPrompt = createDeferred();
  const retryPromptStarted = createDeferred();
  const finishRetryPrompt = createDeferred();
  const prompts: string[] = [];
  const harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        firstPromptStarted.resolve();
        await rejectFirstPrompt.promise;
        throw new Error("prompt failed");
      }
      retryPromptStarted.resolve();
      await finishRetryPrompt.promise;
      const currentRun = store.getRun(runId);
      assert.ok(currentRun);
      store.saveRun({
        ...currentRun,
        state: "success",
        result: { status: "success", summary: "Retry finished." },
      });
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);

  await runtime.message(runId, "First attempt.");
  await firstPromptStarted.promise;
  const failedPromptTask = entry.promptTask;
  assert.ok(failedPromptTask);
  rejectFirstPrompt.resolve();
  await failedPromptTask;

  assert.equal(store.getRun(runId)?.state, "failed");
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 0);

  await runtime.message(runId, "Retry.");
  await retryPromptStarted.promise;
  const retriedPromptTask = entry.promptTask;
  assert.ok(retriedPromptTask);
  finishRetryPrompt.resolve();
  await retriedPromptTask;

  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /Retry this shared context\./);
  assert.match(prompts[1] ?? "", /Retry this shared context\./);
  assert.equal(store.getRun(runId)?.state, "success");
  assert.equal(store.getBusSubscription(subscription.id)?.lastDeliveredSeq, 1);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);
  runtime.dispose();
});

test("message safely resumes and raw-queues running and finished streaming runs", async () => {
  const store = new InMemoryAgentStore();
  const finishedRun: AgentRun = {
    ...run("agent-1", null),
    state: "success",
    result: { status: "success", summary: "Done." },
  };
  const resumedRun: AgentRun = { ...finishedRun, state: "running", result: null };
  const concurrentFinishedRun: AgentRun = {
    ...finishedRun,
    state: "blocked",
    result: { status: "blocked", summary: "Concurrent finish." },
  };
  store.saveRun(finishedRun);
  const deliveredEvents: unknown[] = [];
  const events = new OrchestraEventController({
    store,
    sendEvents: (sentEvents) => deliveredEvents.push(...sentEvents),
    isRunWaiting: () => false,
    flushDelayMs: 0,
  });

  const queuedUserMessages: string[] = [];
  const session = {
    isStreaming: true,
    prompt: async () => assert.fail("message must not start a new prompt task"),
    steer: async () => assert.fail("runtime messages must bypass AgentSession.steer expansion"),
    sendUserMessage: async () => assert.fail("runtime messages must use the atomic agent queue"),
    agent: {
      steer(message: Parameters<AgentSession["agent"]["steer"]>[0]) {
        assert.deepEqual(store.getRun(finishedRun.id), resumedRun);
        queuedUserMessages.push(queuedUserMessageText(message));
      },
    },
  } as unknown as AgentSession;
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: undefined,
    ownerSessionId: "session-1",
    onRunRollback: (runId) => events.suppressRunFinish(runId),
  });
  const activePrompt = createDeferred();
  installEntry(runtime, finishedRun.id, { session, health: observeAgentSessionHealth(session) }, activePrompt.promise);

  store.saveBus({ id: "failure-bus", name: "failure-bus", state: "open", messages: [], nextMessageSeq: 1 });
  const failureSubscription = createBusSubscription({
    busId: "failure-bus",
    subscriberId: finishedRun.id,
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });
  store.saveBusSubscription(failureSubscription);
  store.addBusMessage("failure-bus", { id: "failure-message", from: "main", message: "Unread context." });
  const saveBusSubscription = store.saveBusSubscription.bind(store);
  let finishDuringDeliveryMark = false;
  // Fail delivery bookkeeping after agent.steer has already queued the message.
  store.saveBusSubscription = (subscription) => {
    if (subscription.id !== failureSubscription.id) return saveBusSubscription(subscription);
    if (finishDuringDeliveryMark) store.saveRun(concurrentFinishedRun);
    throw new Error(
      finishDuringDeliveryMark ? "Delivery bookkeeping failed after finish." : "Delivery bookkeeping failed.",
    );
  };

  await assert.rejects(runtime.message(finishedRun.id, "Continue."), /Delivery bookkeeping failed\./);
  events.flush();
  assert.deepEqual(store.getRun(finishedRun.id), finishedRun);
  assert.deepEqual(deliveredEvents, []);
  assert.match(queuedUserMessages[0] ?? "", /Unread context\./);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);

  finishDuringDeliveryMark = true;
  await assert.rejects(
    runtime.message(finishedRun.id, "Concurrent finish."),
    /Delivery bookkeeping failed after finish\./,
  );
  events.flush();
  assert.deepEqual(store.getRun(finishedRun.id), concurrentFinishedRun);
  assert.equal(deliveredEvents.length, 1);
  assert.equal(queuedUserMessages.length, 2);
  assert.match(queuedUserMessages[1] ?? "", /Unread context\./);
  assert.equal(store.getBusSubscription(failureSubscription.id)?.lastDeliveredSeq, 0);
  assert.equal(runtimeInternals(runtime).pendingBusDeliveryIds.size, 0);

  store.saveBusSubscription = saveBusSubscription;
  store.deleteBusSubscription(failureSubscription.id);
  queuedUserMessages.length = 0;
  store.saveRun(resumedRun);
  store.saveRun(finishedRun);
  events.flush();
  assert.equal(deliveredEvents.length, 2);

  const finishedMessagedRun = await runtime.message(finishedRun.id, "/review unchanged");
  const runningMessagedRun = await runtime.message(finishedRun.id, "/review unchanged");

  store.saveBus({ id: "bus-1", name: "bus-1", state: "open", messages: [], nextMessageSeq: 1 });
  const busSubscription = createBusSubscription({
    busId: "bus-1",
    subscriberId: finishedRun.id,
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });
  store.saveBusSubscription(busSubscription);
  store.addBusMessage("bus-1", {
    id: "message-1",
    from: "main",
    message: "Keep this bus context unchanged.",
  });
  const busMessagedRun = await runtime.message(finishedRun.id, "/review with bus context");
  const rawMessageWithBus = [
    "/review with bus context",
    "",
    "<bus_reference_context>",
    "Supplemental peer context; not the active task unless explicitly instructed.",
    '<bus_message from="main">',
    "Keep this bus context unchanged.",
    "</bus_message>",
    "</bus_reference_context>",
  ].join("\n");

  assert.deepEqual(finishedMessagedRun, resumedRun);
  assert.deepEqual(runningMessagedRun, resumedRun);
  assert.deepEqual(busMessagedRun, resumedRun);
  assert.deepEqual(store.getRun(finishedRun.id), resumedRun);
  assert.deepEqual(queuedUserMessages, ["/review unchanged", "/review unchanged", rawMessageWithBus]);
  assert.equal(store.getBusSubscription(busSubscription.id)?.lastDeliveredSeq, 1);
  activePrompt.resolve();
  events.dispose();
});

test("concurrent messages join the resumed prompt before its completion event", async () => {
  const store = new InMemoryAgentStore();
  const runId = "concurrent-parent";
  const parent = run(runId, null);
  const finishedRun: AgentRun = {
    ...parent,
    state: "success",
    result: { status: "success", summary: "Initial turn finished." },
  };
  store.saveRun(parent);
  const previousPrompt = createDeferred();
  const resumedPrompt = createDeferred();
  const prompts: string[] = [];
  const steers: string[] = [];
  let harness: HealthHarness;
  harness = createHealthHarness({
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) {
        store.saveRun(finishedRun);
        await previousPrompt.promise;
        return;
      }
      harness.runtimeState.isStreaming = true;
      await resumedPrompt.promise;
      harness.runtimeState.isStreaming = false;
      store.saveRun({
        ...parent,
        state: "success",
        result: { status: "success", summary: "Both messages finished." },
      });
    },
    agentSteer: (message) => {
      steers.push(message);
    },
  });
  const runtime = createRuntime(store);
  const entry = installEntry(runtime, runId, harness);
  runtimeInternals(runtime).startPromptTask(runId, entry, { content: "Initial prompt.", busDeliveries: [] });
  assert.deepEqual(store.getRun(runId), finishedRun);

  const deliveredEvents: unknown[] = [];
  const events = new OrchestraEventController({
    store,
    sendEvents: (sentEvents) => deliveredEvents.push(...sentEvents),
    isRunWaiting: () => false,
    flushDelayMs: 0,
  });
  const firstMessage = runtime.message(runId, "First message.");
  const secondMessage = runtime.message(runId, "Second message.");
  previousPrompt.resolve();

  await Promise.all([firstMessage, secondMessage]);
  events.flush();
  assert.deepEqual(prompts, ["Initial prompt.", "First message."]);
  assert.deepEqual(steers, ["Second message."]);
  assert.deepEqual(entry.queuedMessages, []);
  assert.deepEqual(deliveredEvents, []);
  assert.equal(store.getRun(runId)?.state, "running");

  const promptTask = entry.promptTask;
  resumedPrompt.resolve();
  await promptTask;
  events.flush();

  assert.equal(deliveredEvents.length, 1);
  assert.equal(store.getRun(runId)?.state, "success");
  events.dispose();
  runtime.dispose();
});

test.each([
  { label: "retry", phase: "isRetrying" as const, healthPhase: "retrying", streaming: true },
  { label: "compaction", phase: "isCompacting" as const, healthPhase: "compacting", streaming: false },
])("concurrent messages steer during $label", async ({ phase, healthPhase, streaming }) => {
  const store = new InMemoryAgentStore();
  const runId = `${phase}-parent`;
  store.saveRun(run(runId, null));
  const activePrompt = createDeferred();
  const steers: string[] = [];
  const harness = createHealthHarness({
    agentSteer: (message) => {
      steers.push(message);
    },
  });
  harness.runtimeState[phase] = true;
  harness.runtimeState.isStreaming = streaming;
  assert.equal(harness.health.getSnapshot().phase, healthPhase);
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness, activePrompt.promise);

  await Promise.all([runtime.message(runId, "First message."), runtime.message(runId, "Second message.")]);

  assert.deepEqual(steers, ["First message.", "Second message."]);
  assert.equal(store.getRun(runId)?.state, "running");
  activePrompt.resolve();
  runtime.dispose();
});

function addUnreadBusMessage(store: InMemoryAgentStore, runId: string) {
  store.saveBus({ id: "bus-1", name: "bus-1", state: "open", messages: [], nextMessageSeq: 1 });
  const subscription = createBusSubscription({
    busId: "bus-1",
    subscriberId: runId,
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });
  store.saveBusSubscription(subscription);
  store.addBusMessage("bus-1", {
    id: "retry-message",
    from: "main",
    message: "Retry this shared context.",
  });
  return subscription;
}

function queuedUserMessageText(message: Parameters<AgentSession["agent"]["steer"]>[0]): string {
  assert.equal(typeof message.timestamp, "number");
  if (message.role !== "user" || !Array.isArray(message.content)) assert.fail("expected a queued user message");
  assert.equal(message.content.length, 1);
  const content = message.content[0];
  if (content?.type !== "text") assert.fail("expected one queued text part");
  return content.text;
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

interface HealthHarnessOptions {
  contextPercent?: number;
  preflightAccepted?: boolean | ((message: string) => boolean);
  prompt?: (message: string, options: Parameters<AgentSession["prompt"]>[1]) => Promise<void>;
  agentSteer?: (message: string) => void;
}

function createHealthHarness(options: HealthHarnessOptions = {}) {
  const state = { errorMessage: undefined as string | undefined };
  const runtimeState = {
    isStreaming: false,
    isRetrying: false,
    isCompacting: false,
    contextPercent: options.contextPercent,
  };
  const session = {
    state,
    get isStreaming() {
      return runtimeState.isStreaming;
    },
    get isRetrying() {
      return runtimeState.isRetrying;
    },
    get isCompacting() {
      return runtimeState.isCompacting;
    },
    dispose() {},
    getContextUsage() {
      return runtimeState.contextPercent === undefined
        ? undefined
        : { tokens: null, contextWindow: 1_000, percent: runtimeState.contextPercent };
    },
    prompt: async (message: string, promptOptions: Parameters<AgentSession["prompt"]>[1]) => {
      const preflightAccepted =
        typeof options.preflightAccepted === "function"
          ? options.preflightAccepted(message)
          : (options.preflightAccepted ?? true);
      promptOptions?.preflightResult?.(preflightAccepted);
      await options.prompt?.(message, promptOptions);
    },
    steer: async () => assert.fail("runtime messages must bypass AgentSession.steer expansion"),
    sendUserMessage: async () => assert.fail("runtime messages must use the atomic agent queue"),
    agent: {
      steer(message: Parameters<AgentSession["agent"]["steer"]>[0]) {
        if (!options.agentSteer) assert.fail("unexpected agent.steer call");
        options.agentSteer(queuedUserMessageText(message));
      },
    },
    messages: [],
  } as unknown as AgentSession;
  return {
    session,
    state,
    runtimeState,
    health: observeAgentSessionHealth(session),
  };
}

type HealthHarness = ReturnType<typeof createHealthHarness>;
type RuntimeTestEntry = {
  session: AgentSession;
  health: ReturnType<typeof observeAgentSessionHealth>;
  promptTask?: Promise<void>;
  queuedMessages: RuntimeTestMessage[];
  queueParked: boolean;
  preflightRetryInProgress: boolean;
};
type RuntimeTestMessage = { content: string; busDeliveries: [] };
type RuntimeInternals = {
  entries: Map<string, RuntimeTestEntry>;
  pendingBusDeliveryIds: Set<string>;
  createChildTools(runId: string): Array<{
    name: string;
    description: string;
    execute(
      toolCallId: string,
      params: { status: string; summary: string; data?: unknown },
    ): Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
  }>;
  startPromptTask(id: string, entry: RuntimeTestEntry, message: RuntimeTestMessage): void;
  runPrompt(id: string, message: RuntimeTestMessage): Promise<void>;
};

function createRuntime(store: InMemoryAgentStore): PiAgentRuntime {
  return new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: () => [],
    ownerSessionId: "owner",
  });
}

function installEntry(
  runtime: PiAgentRuntime,
  runId: string,
  { session, health }: Pick<HealthHarness, "session" | "health">,
  promptTask?: Promise<void>,
): RuntimeTestEntry {
  const entry: RuntimeTestEntry = {
    session,
    health,
    queuedMessages: [],
    queueParked: false,
    preflightRetryInProgress: false,
    ...(promptTask ? { promptTask } : {}),
  };
  runtimeInternals(runtime).entries.set(runId, entry);
  return entry;
}

function runtimeInternals(runtime: PiAgentRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

function run(id: string, parentRunId: string | null): AgentRun {
  return {
    id,
    name: id,
    profile,
    task: "Task.",
    busId: "bus-1",
    ownerSessionId: "session-1",
    parentRunId,
    state: "running",
    result: null,
  };
}
