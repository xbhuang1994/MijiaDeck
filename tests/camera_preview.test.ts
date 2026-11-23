// SPDX-License-Identifier: GPL-3.0-or-later
/** Camera authorization, cancellation and preview lifecycle without a real account. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CameraSource,
  buildCameraSource,
  deriveX25519PublicHex,
  type CloudRequestFn,
} from "../src/core/cameraAccess.ts";
import {
  CAMERA_ERRORS,
  CameraPreviewError,
  CameraSession,
  type CameraHelperProcess,
  type CameraHelperSpawner,
} from "../src/core/cameraPreview.ts";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { buildReport } from "../src/core/diagnostics.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import {
  CameraPreviewController,
  computeVideoRect,
  type IAudioOutput,
  type ICameraPlayer,
  type ICameraService,
  type ICameraSession,
  type IScheduler,
} from "../src/ui/controllers/cameraPreviewController.ts";

interface QueuedJob {
  fn: () => unknown | Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class TestJobs implements Pick<IJobExecutor, "submit"> {
  readonly pending: QueuedJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess
        ? (value: unknown) => options.onSuccess?.(value as T)
        : undefined,
      onError: options?.onError,
    });
  }

  async finishNext(): Promise<void> {
    const job = this.pending.shift();
    if (!job) {
      throw new Error("No pending job to finish");
    }
    const result = await job.fn();
    job.onSuccess?.(result);
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface ScheduledTimer {
  id: number;
  fn: () => void;
  dueMs: number;
  intervalMs: number | null;
  active: boolean;
}

class FakeScheduler implements IScheduler {
  private _nowMs = 0;
  private _nextId = 1;
  private readonly _timers = new Map<number, ScheduledTimer>();

  get nowMs(): number {
    return this._nowMs;
  }

  setNow(ms: number): void {
    this._nowMs = ms;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this._nextId++;
    this._timers.set(id, {
      id,
      fn,
      dueMs: this._nowMs + ms,
      intervalMs: null,
      active: true,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      const timer = this._timers.get(handle);
      if (timer) {
        timer.active = false;
        this._timers.delete(handle);
      }
    }
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this._nextId++;
    this._timers.set(id, {
      id,
      fn,
      dueMs: this._nowMs + ms,
      intervalMs: ms,
      active: true,
    });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  advanceBy(deltaMs: number): void {
    const target = this._nowMs + deltaMs;
    while (true) {
      let next: ScheduledTimer | null = null;
      for (const timer of this._timers.values()) {
        if (!timer.active || timer.dueMs > target) {
          continue;
        }
        if (next === null || timer.dueMs < next.dueMs) {
          next = timer;
        }
      }
      if (next === null) {
        break;
      }
      this._nowMs = next.dueMs;
      if (next.intervalMs !== null) {
        next.dueMs += next.intervalMs;
      } else {
        next.active = false;
        this._timers.delete(next.id);
      }
      next.fn();
    }
    this._nowMs = target;
  }
}

interface MockHelperHandle {
  readonly process: CameraHelperProcess;
  readonly stdinChunks: string[];
  readonly stdinText: () => string;
  readonly isStdinClosed: () => boolean;
  readonly terminateCalls: () => number;
  readonly killCalls: () => number;
  pushStdout(line: string): void;
  closeStdout(): void;
  finish(code?: number): void;
}

function createMockHelperProcess(
  args: string[],
  options: { exitOnStop?: boolean } = {},
): MockHelperHandle {
  const exitOnStop = options.exitOnStop ?? true;
  const stdinChunks: string[] = [];
  let stdinClosed = false;
  let exitCode: number | null = null;
  let terminateCount = 0;
  let killCount = 0;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });

  const closeStdout = () => {
    if (!streamClosed && streamController) {
      streamClosed = true;
      try {
        streamController.close();
      } catch {
        // already closed
      }
    }
  };

  const finish = (code = 0) => {
    if (exitCode !== null) {
      return;
    }
    exitCode = code;
    closeStdout();
    resolveExited(code);
  };

  const proc: CameraHelperProcess = {
    args: [...args],
    exited,
    get exitCode(): number | null {
      return exitCode;
    },
    stdout,
    writeStdin(chunk: string): boolean {
      if (stdinClosed || exitCode !== null) {
        return false;
      }
      stdinChunks.push(chunk);
      if (exitOnStop && chunk.includes("STOP")) {
        queueMicrotask(() => finish(0));
      }
      return true;
    },
    closeStdin(): void {
      stdinClosed = true;
    },
    terminate(): void {
      terminateCount += 1;
    },
    kill(): void {
      killCount += 1;
      finish(137);
    },
  };

  return {
    process: proc,
    stdinChunks,
    stdinText: () => stdinChunks.join(""),
    isStdinClosed: () => stdinClosed,
    terminateCalls: () => terminateCount,
    killCalls: () => killCount,
    pushStdout(line: string): void {
      if (!streamClosed && streamController) {
        streamController.enqueue(encoder.encode(line));
      }
    },
    closeStdout,
    finish,
  };
}

class FailingStartSession extends CameraSession {
  protected override async _start(): Promise<string> {
    throw new Error("secret-private-key");
  }
}

describe("CameraAccess", () => {
  test("signed source has matching ephemeral X25519 keys and device without leaking secrets", async () => {
    const calls: Array<{ uri: string; data: Record<string, unknown> }> = [];
    const request: CloudRequestFn = mock((uri: string, data: Record<string, unknown>) => {
      calls.push({ uri, data });
      return {
        vendor: {
          vendor: 4,
          vendor_params: {
            p2p_id: "ABC-123-TEST",
            init_string: "example-init",
          },
        },
        public_key: "ab".repeat(32),
        sign: "temporary/sign+test",
      };
    });
    const diagnostics: Array<Record<string, unknown>> = [];

    const source = await buildCameraSource("123", "chuangmi.camera.029a02", request, (fields) =>
      diagnostics.push(fields),
    );

    expect(deriveX25519PublicHex(source.client_private)).toBe(source.client_public);
    expect(source.uid).toBe("ABC-123-TEST");
    expect(source.init_string).toBe("example-init");
    expect(source.device_public).toBe("ab".repeat(32));
    expect(source.sign).toBe("temporary/sign+test");

    expect(String(source)).not.toContain(source.client_private);
    expect(JSON.stringify(source)).not.toContain(source.client_private);
    expect(Bun.inspect(source)).not.toContain(source.client_private);
    expect(String(source)).not.toContain(source.sign);
    expect(JSON.stringify(source)).not.toContain(source.sign);
    expect(Bun.inspect(source)).not.toContain(source.sign);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.uri).toBe("/v2/device/miss_get_vendor");
    expect(calls[0]!.data.app_pubkey).toBe(source.client_public);
    expect(calls[0]!.data.did).toBe("123");
    expect(diagnostics[0]).toMatchObject({
      vendor_id: 4,
      protocol: "CS2",
      authorization_fields_present: {
        p2p_id: true,
        init_string: true,
        public_key: true,
        sign: true,
      },
    });
  });

  test("pipe injection (\\n / \\r) in cloud fields is rejected with CameraPreviewError", async () => {
    const injectedPayloads: Array<Record<string, unknown>> = [
      {
        vendor: {
          vendor: 4,
          vendor_params: {
            p2p_id: "ABC-123-TEST\nINJECT",
            init_string: "example-init",
          },
        },
        public_key: "ab".repeat(32),
        sign: "test",
      },
      {
        vendor: {
          vendor: 4,
          vendor_params: {
            p2p_id: "ABC-123-TEST",
            init_string: "example-init\rINJECT",
          },
        },
        public_key: "ab".repeat(32),
        sign: "test",
      },
      {
        vendor: {
          vendor: 4,
          vendor_params: {
            p2p_id: "ABC-123-TEST",
            init_string: "example-init",
          },
        },
        public_key: "ab".repeat(32),
        sign: "test\r\ninject",
      },
    ];

    for (const payload of injectedPayloads) {
      const request: CloudRequestFn = () => payload;
      await expect(buildCameraSource("123", "test.camera.model", request)).rejects.toBeInstanceOf(
        CameraPreviewError,
      );
      try {
        await buildCameraSource("123", "test.camera.model", request);
      } catch (err) {
        expect(err).toBeInstanceOf(CameraPreviewError);
        expect((err as CameraPreviewError).code).toBe("AUTH_FIELDS");
      }
    }
  });

  test("incomplete or unsupported vendor authorizations are rejected", async () => {
    const cases: Array<{ result: Record<string, unknown>; expectedCode: string }> = [
      { result: { vendor: { vendor: 9 } }, expectedCode: "VENDOR_UNSUPPORTED" },
      { result: { vendor: { vendor: 4 } }, expectedCode: "AUTH_FIELDS" },
      {
        result: { vendor: { vendor: 1 }, public_key: "ab".repeat(32), sign: "test" },
        expectedCode: "VENDOR_UNSUPPORTED",
      },
      {
        result: {
          vendor: { vendor: 4, vendor_params: { p2p_id: "ABC-123", init_string: "init" } },
          public_key: "short-invalid-key",
          sign: "test",
        },
        expectedCode: "AUTH_KEY",
      },
    ];

    for (const { result, expectedCode } of cases) {
      let caught: unknown = null;
      try {
        await buildCameraSource("123", "test.camera.model", () => result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CameraPreviewError);
      expect((caught as CameraPreviewError).code).toBe(expectedCode);
    }
  });

  test("backend errors in CameraSession do not expose signed source secrets and mark cancelled", async () => {
    const session = new FailingStartSession({ checkBinariesExist: false });
    const source = new CameraSource(
      "UID-SECRET",
      "init-secret",
      "ab".repeat(32),
      "secret-private-key",
      "cd".repeat(32),
      "xiaomi://private?sign=secret-private-key",
    );

    let caught: unknown = null;
    try {
      await session.start(source);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CameraPreviewError);
    expect((caught as CameraPreviewError).message).not.toContain("secret-private-key");
    expect(session.cancelled).toBe(true);
  });

  test("mock helper spawner passes keys ONLY via stdin pipe and handles PHASE/READY/AUDIO/commands/STOP", async () => {
    let spawnedArgs: string[] = [];
    let helper!: MockHelperHandle;
    const spawner: CameraHelperSpawner = (cmd) => {
      spawnedArgs = [...cmd];
      helper = createMockHelperProcess(cmd, { exitOnStop: true });
      return helper.process;
    };

    const session = new CameraSession({
      spawner,
      javaPath: "C:/mock/java.exe",
      jarPath: "C:/mock/camera-relay.jar",
      allocatePort: async () => 45678,
    });

    const source = new CameraSource(
      "ABCDEF-123456-GHIJK",
      "init-secret-blob",
      "aa".repeat(32),
      "bb".repeat(32),
      "cc".repeat(32),
      "temporary-sign-secret",
    );

    const progressMessages: string[] = [];
    const audioFrames: Array<{ rate: number; pcm: Uint8Array }> = [];

    const startPromise = session.start(source, {
      quality: 1,
      onProgress: (msg) => progressMessages.push(msg),
      onAudio: (rate, pcm) => audioFrames.push({ rate, pcm }),
    });

    // Wait for spawn + stdin write to execute.
    await flushMicrotasks();

    // Verify NO sensitive source fields appear in process arguments.
    const joinedArgs = spawnedArgs.join(" ");
    expect(joinedArgs).not.toContain(source.client_private);
    expect(joinedArgs).not.toContain(source.sign);
    expect(joinedArgs).not.toContain(source.init_string);
    expect(joinedArgs).not.toContain(source.uid);
    expect(joinedArgs).not.toContain(source.client_public);
    expect(joinedArgs).not.toContain(source.device_public);

    // Verify all 9 fields were written over the stdin pipe.
    const configLines = helper.stdinText().split("\n").filter((line) => line.length > 0);
    expect(configLines).toHaveLength(9);
    expect(configLines[0]).toBe("45678");
    expect(configLines[1]).toMatch(/^\/camera-[0-9a-f]{32}\.ts$/);
    expect(configLines[2]).toBe(source.uid);
    expect(configLines[3]).toBe(source.init_string);
    expect(configLines[4]).toBe(source.client_public);
    expect(configLines[5]).toBe(source.client_private);
    expect(configLines[6]).toBe(source.device_public);
    expect(configLines[7]).toBe(source.sign);
    expect(configLines[8]).toBe("1");

    // Emit connection phases, codec/GOP metadata, and READY.
    helper.pushStdout("PHASE RELAY\n");
    helper.pushStdout("PHASE AUTH\n");
    helper.pushStdout("INFO VIDEO_CODEC H265\n");
    helper.pushStdout("INFO GOP_BOOTSTRAP\n");
    helper.pushStdout("PHASE MEDIA\n");
    helper.pushStdout("READY\n");

    const url = await startPromise;
    expect(url).toBe(`http://127.0.0.1:45678${configLines[1]}`);
    expect(progressMessages).toEqual([
      "PHASE RELAY",
      "PHASE AUTH",
      "INFO VIDEO_CODEC H265",
      "INFO GOP_BOOTSTRAP",
      "PHASE MEDIA",
    ]);

    // Emit valid and invalid AUDIO 8000 PCM chunks and post-READY notices/errors.
    const pcmSample = new Uint8Array([1, 2, 3, 4, 250, 251]);
    const validBase64 = Buffer.from(pcmSample).toString("base64");
    helper.pushStdout(`AUDIO 8000 ${validBase64}\n`);
    helper.pushStdout("AUDIO 8000 not-valid-base64!!!\n");
    helper.pushStdout("NOTICE AUDIO_UNSUPPORTED\n");
    helper.pushStdout("ERROR STREAM\n");
    await flushMicrotasks();

    expect(audioFrames).toHaveLength(1);
    expect(audioFrames[0]!.rate).toBe(8000);
    expect(Array.from(audioFrames[0]!.pcm)).toEqual(Array.from(pcmSample));
    expect(progressMessages).toContain("NOTICE AUDIO_UNSUPPORTED");
    expect(progressMessages).toContain("ERROR STREAM");

    // Verify valid commands and rejection of invalid values.
    expect(session.command("QUALITY", 2)).toBe(true);
    expect(session.command("AUDIO", 1)).toBe(true);
    expect(session.command("PTZ", 3)).toBe(true);
    expect(session.command("QUALITY", 9)).toBe(false);
    expect(session.command("AUDIO", 2)).toBe(false);
    expect(session.command("PTZ", 5)).toBe(false);

    expect(helper.stdinChunks.slice(1)).toEqual(["QUALITY 2\n", "AUDIO 1\n", "PTZ 3\n"]);

    // Verify STOP writes STOP\n, closes stdin, marks cancelled, and blocks further commands.
    session.stop();
    expect(helper.stdinChunks[helper.stdinChunks.length - 1]).toBe("STOP\n");
    expect(helper.isStdinClosed()).toBe(true);
    expect(session.cancelled).toBe(true);
    expect(session.process).toBeNull();
    expect(session.command("PTZ", 1)).toBe(false);
    await helper.process.exited;
    expect(helper.process.exitCode).toBe(0);
  });

  test("mock helper spawner maps ERROR lines and cleanly cancels hung helper without leaking keys", async () => {
    // 1. ERROR before READY rejects with mapped CameraPreviewError code.
    let errorHelper!: MockHelperHandle;
    const errorSession = new CameraSession({
      spawner: (cmd) => {
        errorHelper = createMockHelperProcess(cmd, { exitOnStop: true });
        return errorHelper.process;
      },
      allocatePort: async () => 45679,
    });
    const source = new CameraSource(
      "ABCDEF-123456-GHIJK",
      "A",
      "ab".repeat(32),
      "cd".repeat(32),
      "ef".repeat(32),
      "temporary-sign",
    );

    const errStart = errorSession.start(source);
    await flushMicrotasks();
    errorHelper.pushStdout("ERROR RELAY\n");

    let relayErr: unknown = null;
    try {
      await errStart;
    } catch (err) {
      relayErr = err;
    }
    expect(relayErr).toBeInstanceOf(CameraPreviewError);
    expect((relayErr as CameraPreviewError).code).toBe("RELAY");
    expect((relayErr as CameraPreviewError).message).toBe(CAMERA_ERRORS.RELAY);
    expect(errorSession.cancelled).toBe(true);

    // 2. Cancellation during connection terminates and kills an unresponsive helper without exposing keys.
    let cancelHelper!: MockHelperHandle;
    const cancelSession = new CameraSession({
      spawner: (cmd) => {
        cancelHelper = createMockHelperProcess(cmd, { exitOnStop: false });
        return cancelHelper.process;
      },
      allocatePort: async () => 45680,
      stopGraceMs: 15,
    });

    let reachedRelay = false;
    const cancelStart = cancelSession.start(source, {
      onProgress: (msg) => {
        if (msg === "PHASE RELAY") {
          reachedRelay = true;
        }
      },
    });
    await flushMicrotasks();
    cancelHelper.pushStdout("PHASE RELAY\n");
    await flushMicrotasks();

    expect(reachedRelay).toBe(true);
    expect(cancelSession.process).not.toBeNull();
    expect(cancelSession.process!.args.join(" ")).not.toContain(source.client_private);
    expect(cancelSession.process!.args.join(" ")).not.toContain(source.sign);

    cancelSession.stop();
    let cancelErr: unknown = null;
    try {
      await cancelStart;
    } catch (err) {
      cancelErr = err;
    }
    expect(cancelErr).toBeInstanceOf(CameraPreviewError);
    expect((cancelErr as CameraPreviewError).code).toBe("CANCELLED");
    expect(cancelSession.cancelled).toBe(true);
    expect(cancelHelper.stdinChunks[cancelHelper.stdinChunks.length - 1]).toBe("STOP\n");
    expect(cancelHelper.isStdinClosed()).toBe(true);

    // Unresponsive helper gets terminated and force-killed after grace timers.
    const exitCode = await cancelHelper.process.exited;
    expect(cancelHelper.terminateCalls()).toBeGreaterThanOrEqual(1);
    expect(cancelHelper.killCalls()).toBe(1);
    expect(exitCode).toBe(137);
  });
});

interface MockBackend extends ICameraSession {
  cancelled: boolean;
  start: ReturnType<typeof mock<() => string>>;
  command: ReturnType<typeof mock<(name: "QUALITY" | "AUDIO" | "PTZ", value: number) => boolean>>;
  stop: ReturnType<typeof mock<() => void>>;
}

interface MockPlayer extends ICameraPlayer {
  setSource: ReturnType<typeof mock<(url: string) => void>>;
  play: ReturnType<typeof mock<() => void>>;
  stop: ReturnType<typeof mock<() => void>>;
}

interface MockAudio extends IAudioOutput {
  start: ReturnType<typeof mock<(rate: number) => void>>;
  write: ReturnType<typeof mock<(data: Uint8Array) => void>>;
  stop: ReturnType<typeof mock<() => void>>;
}

interface MockService extends ICameraService {
  powerState: ReturnType<typeof mock<(did: string) => boolean | null>>;
  setPowerState: ReturnType<typeof mock<(did: string, state: boolean) => void>>;
  prepareCameraSource: ReturnType<typeof mock<(device: DeviceInfo) => unknown>>;
}

describe("CameraPanel", () => {
  let jobs: TestJobs;
  let scheduler: FakeScheduler;
  let device: DeviceInfo;
  let service: MockService;
  let backend: MockBackend;
  let player: MockPlayer;
  let audioOutput: MockAudio;
  let panel: CameraPreviewController;

  beforeEach(() => {
    jobs = new TestJobs();
    scheduler = new FakeScheduler();
    device = createDeviceInfo({
      online: true,
      did: "camera-test",
      name: "测试摄像头",
      home_name: "测试家",
      room_name: "客厅",
      model: "chuangmi.camera.029a02",
    });
    service = {
      prepareCameraSource: mock(() => "signed-source"),
      powerState: mock<() => boolean | null>(() => false),
      setPowerState: mock(() => {}),
    };
    backend = {
      cancelled: false,
      start: mock(() => "rtsp://127.0.0.1:1/test"),
      command: mock(() => true),
      stop: mock(() => {
        backend.cancelled = true;
      }),
    };
    player = {
      setSource: mock(() => {}),
      play: mock(() => {}),
      stop: mock(() => {}),
    };
    audioOutput = {
      start: mock(() => {}),
      write: mock(() => {}),
      stop: mock(() => {}),
    };
    panel = new CameraPreviewController(service, jobs, device, {
      sessionFactory: () => backend,
      player,
      audioOutput,
      clock: () => scheduler.nowMs,
      scheduler,
      visible: true,
    });
  });

  afterEach(() => {
    panel.dispose();
  });

  test("close while queued skips cloud and ignores late result", async () => {
    panel.start();
    const generation = panel.generation;
    const job = jobs.pending.pop()!;
    panel.hide();

    expect(() => job.fn()).toThrow(CameraPreviewError);
    expect(service.prepareCameraSource).not.toHaveBeenCalled();

    job.onSuccess?.("rtsp://127.0.0.1:1/late");
    panel.onConnected(generation, "rtsp://127.0.0.1:1/late");
    await flushMicrotasks();

    expect(player.play).not.toHaveBeenCalled();
    expect(panel.session).toBeNull();
    expect(panel.timeoutActive).toBe(false);
  });

  test("success plays and stop releases connection", async () => {
    panel.start();
    await jobs.finishNext();

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(panel.session).toBe(backend);

    panel.stop();
    expect(backend.stop).toHaveBeenCalled();
    expect(panel.session).toBeNull();
    expect(panel.canvas.muteEnabled).toBe(false);
  });

  test("offline never starts job and displays 离线", () => {
    device.online = false;
    panel.start();

    expect(jobs.pending).toEqual([]);
    expect(panel.canvas.notice).toContain("离线");
  });

  test("timeout allows retry and displays 预览超时", () => {
    panel.start();
    jobs.pending.length = 0;

    panel.onTimeout();
    expect(panel.session).toBeNull();
    expect(panel.canvas.notice).toContain("预览超时");
    expect(panel.canvas.muteEnabled).toBe(false);

    panel.retry();
    expect(jobs.pending).toHaveLength(1);
  });

  test("connection stage is visible and old/post-error progress is ignored", () => {
    panel.start();
    const generation = panel.generation;

    panel.onProgress(generation, "PHASE AUTH");
    expect(panel.canvas.notice).toContain("验证视频会话");

    panel.onProgress(generation, "ERROR RELAY");
    expect(panel.canvas.notice).toContain("公网中继");

    panel.onProgress(generation, "PHASE MEDIA");
    expect(panel.canvas.notice).toContain("公网中继");
  });

  test("player errors map to exact diagnostic codes without leaking backend URL text", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["ResourceError", "PLAYER_RESOURCE"],
      ["FormatError", "PLAYER_FORMAT"],
      ["NetworkError", "PLAYER_NETWORK"],
      ["AccessDeniedError", "PLAYER_ACCESS"],
    ];

    for (const [category, code] of cases) {
      panel.attachSession(backend);
      panel.onPlayerError(category, "SECRET-MEDIA-URL");

      const snapshot = panel.diagnosticSnapshot();
      expect(snapshot.error_code).toBe(code);
      expect(panel.canvas.notice).not.toContain("SECRET");

      const report = buildReport(device, { observation: snapshot });
      expect(report).not.toContain("SECRET");
      expect(report).toContain(code);
    }
  });

  test("codec and GOP_BOOTSTRAP info are recorded only for current connection generation", () => {
    panel.start();
    const generation = panel.generation;

    panel.onProgress(generation, "INFO VIDEO_CODEC H265");
    panel.onProgress(generation, "INFO GOP_BOOTSTRAP");

    expect(panel.diagnosticSnapshot().video_codec).toBe("H265");
    expect(panel.diagnosticSnapshot().gop_bootstrap).toBe(true);

    panel.onProgress(generation - 1, "INFO VIDEO_CODEC H264");
    expect(panel.diagnosticSnapshot().video_codec).toBe("H265");
  });

  test("unknown power hides power button, starts video auth, polling never restarts failed video, manual retry works without writing power", async () => {
    service.powerState.mockReturnValue(null);
    panel.load();
    await jobs.finishNext();

    expect(panel.powerVisible).toBe(false);
    expect(jobs.pending).toHaveLength(1); // video auth, not another power read

    await jobs.finishNext();
    expect(service.prepareCameraSource).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);

    panel.onFailed(panel.generation, new CameraPreviewError("test auth failure"));
    panel.refreshPower();
    await jobs.finishNext();

    expect(jobs.pending).toEqual([]); // polling must not restart failed video
    expect(panel.canvas.notice).toBe("test auth failure");

    panel.retry();
    expect(jobs.pending).toHaveLength(1);
    expect(service.setPowerState).not.toHaveBeenCalled();
  });

  test("failed power read allows auth when visible, blocks when hidden or offline", () => {
    panel.load();
    const firstJob = jobs.pending.shift()!;
    firstJob.onError?.(new Error("power unavailable"));

    expect(jobs.pending).toHaveLength(1);
    expect(panel.powerVisible).toBe(false);

    panel.hide();
    jobs.pending.length = 0;
    panel.continueWithoutPowerState();
    expect(jobs.pending).toEqual([]);

    device.online = false;
    panel.retry();
    expect(jobs.pending).toEqual([]);
  });

  test("sleeping camera never starts video until woken via togglePower", async () => {
    panel.load();
    await jobs.finishNext();

    expect(panel.powerState).toBe(false);
    expect(panel.canvas.notice).toContain("休眠");
    expect(service.prepareCameraSource).not.toHaveBeenCalled();

    panel.togglePower();
    expect(panel.powerBusy).toBe(true);

    await jobs.finishNext();
    expect(service.setPowerState).toHaveBeenCalledTimes(1);
    expect(service.setPowerState).toHaveBeenCalledWith("camera-test", true);
    expect(panel.powerState).toBe(true);
    expect(jobs.pending).toHaveLength(1); // fresh authorization queued after wake
  });

  test("close only stops viewing and never powers off physical camera", () => {
    panel.applyPower(true);
    panel.hide();
    expect(backend.stop).toHaveBeenCalled();
    expect(service.setPowerState).not.toHaveBeenCalled();

    panel.close();
    expect(service.setPowerState).not.toHaveBeenCalled();
  });

  test("quality, mute, and drag use existing session commands", () => {
    panel.attachSession(backend, { playing: true });
    panel.canvas.dragEnabled = true;

    panel.selectQuality(2);
    expect(backend.command).toHaveBeenLastCalledWith("QUALITY", 2);

    panel.toggleMute();
    expect(panel.muted).toBe(false);
    expect(backend.command).toHaveBeenLastCalledWith("AUDIO", 1);

    panel.toggleMute();
    expect(panel.muted).toBe(true);
    expect(backend.command).toHaveBeenLastCalledWith("AUDIO", 0);

    panel.drag(2);
    expect(backend.command).toHaveBeenLastCalledWith("PTZ", 2);

    const count = backend.command.mock.calls.length;
    panel.drag(2);
    expect(backend.command.mock.calls.length).toBe(count);
  });

  test("fullscreen reuses canvas and Escape keeps stream without stopping session", () => {
    panel.attachSession(backend);
    const generation = panel.generation;
    const canvas = panel.canvas;

    panel.toggleFullscreen();
    expect(panel.fullscreen).toBe(true);
    expect(panel.canvasHost).toBe("fullscreen");
    expect(panel.canvas).toBe(canvas);

    expect(panel.handleKeyPress("Escape")).toBe(true);
    expect(panel.fullscreen).toBe(false);
    expect(panel.canvasHost).toBe("panel");
    expect(panel.canvas).toBe(canvas);
    expect(panel.generation).toBe(generation);
    expect(backend.stop).not.toHaveBeenCalled();
  });

  test("drag waits for 1.5s settling and a new decoded frame without queuing", () => {
    panel.attachSession(backend);
    const frame = { width: 640, height: 360, valid: true };
    panel.onFrame(frame);

    scheduler.setNow(100_000);
    panel.drag(1);
    expect(panel.canvas.dragBusy).toBe(true);

    // Extra drag while busy is discarded (not queued).
    panel.drag(2);

    scheduler.setNow(101_000);
    panel.onFrame(frame);
    expect(panel.canvas.dragBusy).toBe(true);
    expect(backend.command).toHaveBeenCalledTimes(1);
    expect(backend.command).toHaveBeenLastCalledWith("PTZ", 1);

    // Even after 1.5s, busy does not clear until a new decoded frame arrives.
    scheduler.setNow(102_000);
    expect(panel.canvas.dragBusy).toBe(true);

    panel.onFrame(frame);
    expect(panel.canvas.dragBusy).toBe(false);
    expect(backend.command).toHaveBeenCalledTimes(1);
    expect(backend.command).toHaveBeenLastCalledWith("PTZ", 1);

    panel.drag(3);
    expect(backend.command).toHaveBeenLastCalledWith("PTZ", 3);

    panel.stop();
    expect(panel.canvas.dragBusy).toBe(false);
  });

  test("failed drag write does not lock dragBusy", () => {
    panel.attachSession(backend, { playing: true });
    panel.canvas.dragEnabled = true;
    backend.command.mockReturnValue(false);

    panel.drag(1);
    expect(panel.canvas.dragBusy).toBe(false);
  });

  test("quality switch reopens local viewer after 900ms without new remote session", () => {
    panel.attachSession(backend, { url: "http://127.0.0.1:1/camera-test.ts" });
    const generation = panel.generation;

    panel.selectQuality(2);
    expect(panel.switchingQuality).toBe(true);
    expect(player.play).not.toHaveBeenCalled();

    scheduler.advanceBy(899);
    expect(panel.switchingQuality).toBe(true);
    expect(player.play).not.toHaveBeenCalled();

    scheduler.advanceBy(1);
    expect(panel.switchingQuality).toBe(false);
    expect(player.setSource).toHaveBeenLastCalledWith("http://127.0.0.1:1/camera-test.ts");
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(panel.generation).toBe(generation);
    expect(backend.start).not.toHaveBeenCalled();
  });

  test("muted and stale-generation PCM audio cannot open audio output", () => {
    panel.attachSession(backend, { playing: true, muted: true });
    panel.onPcm(panel.generation, 8000, new Uint8Array(160));

    panel.attachSession(backend, { playing: true, muted: false });
    panel.onPcm(panel.generation - 1, 8000, new Uint8Array(160));

    expect(audioOutput.start).not.toHaveBeenCalled();
    expect(audioOutput.write).not.toHaveBeenCalled();

    // Unmuted current-generation PCM opens audio output and writes bytes.
    const sample = new Uint8Array(160);
    panel.onPcm(panel.generation, 8000, sample);
    expect(audioOutput.start).toHaveBeenCalledTimes(1);
    expect(audioOutput.start).toHaveBeenCalledWith(8000);
    expect(audioOutput.write).toHaveBeenCalledWith(sample);
  });

  test("frame updates actual quality label (360P, 2K, 自动), enables mute, and keeps canvas in bounds", () => {
    panel.attachSession(backend);

    // Quality 1 (smooth) with 640x360 frame -> "360P"
    panel.onFrame({ width: 640, height: 360, valid: true });
    expect(panel.playing).toBe(true);
    expect(panel.canvas.qualityText).toBe("360P");
    expect(panel.canvas.muteEnabled).toBe(true);
    expect(panel.canvas.hasFrame).toBe(true);

    // Canvas rect stays inside panel bounds.
    const bounds = { x: 0, y: 0, width: 640, height: 400 };
    const videoRect = computeVideoRect(bounds, panel.videoRatio);
    expect(videoRect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(videoRect.y).toBeGreaterThanOrEqual(bounds.y);
    expect(videoRect.x + videoRect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(videoRect.y + videoRect.height).toBeLessThanOrEqual(bounds.y + bounds.height);

    // Quality 2 (HD) with 2304x1296 frame (height > 1080) -> "2K"
    panel.selectQuality(2);
    panel.onFrame({ width: 2304, height: 1296, valid: true });
    expect(panel.canvas.qualityText).toBe("2K");

    // Quality 0 (auto) -> "自动"
    panel.selectQuality(0);
    panel.onFrame({ width: 640, height: 360, valid: true });
    expect(panel.canvas.qualityText).toBe("自动");
  });
});
