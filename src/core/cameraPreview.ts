// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Owned CS2 remote relay. Only an unguessable loopback stream reaches the player.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resourcePath } from "./appMeta.ts";
import type { CameraSource } from "./cameraAccess.ts";

export class CameraPreviewError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "UNKNOWN") {
    super(message);
    this.name = "CameraPreviewError";
    this.code = code;
  }
}

export const CAMERA_ERRORS: Readonly<Record<string, string>> = {
  CONFIG: "远程播放组件初始化失败，请重新安装组件。",
  RELAY: "未能连接摄像头的公网中继，请确认摄像头在线、当前网络允许 UDP 通信后重试。",
  AUTH: "已连接中继，但摄像头视频会话授权未通过；请先关闭米家中的观看页面再重试。",
  MEDIA: "中继和视频授权已完成，但未收到画面；请确认摄像头镜头已开启后重试。",
  STREAM: "摄像头视频连接已中断，请重试。",
};

export const ERRORS = CAMERA_ERRORS;

export type CameraCommandName = "QUALITY" | "AUDIO" | "PTZ";

const ALLOWED_COMMANDS: Readonly<Record<CameraCommandName, readonly number[]>> = {
  QUALITY: [0, 1, 2],
  AUDIO: [0, 1],
  PTZ: [1, 2, 3, 4],
};

const PASSTHROUGH_MESSAGES = new Set<string>([
  "NOTICE AUDIO_UNSUPPORTED",
  "NOTICE CONTROL_FAILED",
  "INFO VIDEO_CODEC H264",
  "INFO VIDEO_CODEC H265",
  "INFO GOP_BOOTSTRAP",
]);

const PHASE_MESSAGES = new Set<string>(["PHASE RELAY", "PHASE AUTH", "PHASE MEDIA"]);

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Strict(input: string): Uint8Array | null {
  if (input.length === 0 || input.length % 4 !== 0 || !STRICT_BASE64_RE.test(input)) {
    return null;
  }
  const buf = Buffer.from(input, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export interface CameraHelperProcess {
  readonly args: readonly string[];
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  writeStdin(chunk: string): boolean;
  closeStdin(): void;
  terminate(): void;
  kill(): void;
}

export type CameraHelperSpawner = (
  cmd: string[],
  options?: { env?: Record<string, string | undefined> },
) => CameraHelperProcess;

export function launchCameraHelper(
  cmd: string[],
  options?: { env?: Record<string, string | undefined> },
): CameraHelperProcess {
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: options?.env,
    windowsHide: true,
  });

  const stdin = proc.stdin;

  return {
    args: [...cmd],
    exited: proc.exited,
    get exitCode(): number | null {
      return proc.exitCode;
    },
    stdout: proc.stdout instanceof ReadableStream ? proc.stdout : null,
    writeStdin(chunk: string): boolean {
      if (!stdin || typeof stdin === "number") {
        return false;
      }
      try {
        stdin.write(chunk);
        stdin.flush();
        return true;
      } catch {
        return false;
      }
    },
    closeStdin(): void {
      if (!stdin || typeof stdin === "number") {
        return;
      }
      try {
        stdin.end();
      } catch {
        // ignore closed pipe
      }
    },
    terminate(): void {
      try {
        proc.kill();
      } catch {
        // ignore already exited
      }
    },
    kill(): void {
      try {
        proc.kill(9);
      } catch {
        // ignore already exited
      }
    },
  };
}

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve loopback port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

export interface CameraSessionStartOptions {
  onProgress?: (msg: string) => void;
  quality?: number;
  onAudio?: (rate: number, pcm: Uint8Array) => void;
  timeoutMs?: number;
}

export interface CameraSessionOptions {
  spawner?: CameraHelperSpawner;
  javaPath?: string;
  jarPath?: string;
  checkBinariesExist?: boolean;
  allocatePort?: () => Promise<number>;
  stopGraceMs?: number;
}

interface AsyncMessageQueue {
  push(value: string): void;
  next(signal: { cancelled: boolean; deadlineMs: number; onWake: (fn: () => void) => () => void }): Promise<string | null>;
}

function createMessageQueue(): AsyncMessageQueue {
  const buffered: string[] = [];
  let waiter: ((value: string | null) => void) | null = null;

  return {
    push(value: string): void {
      if (waiter !== null) {
        const resolve = waiter;
        waiter = null;
        resolve(value);
      } else {
        buffered.push(value);
      }
    },
    next(signal): Promise<string | null> {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift()!);
      }
      if (signal.cancelled) {
        return Promise.resolve(null);
      }
      const remaining = signal.deadlineMs - performance.now();
      if (remaining <= 0) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubCancel();
          if (waiter === onMessage) {
            waiter = null;
          }
          resolve(value);
        };
        const onMessage = (value: string | null) => finish(value);
        waiter = onMessage;
        const timer = setTimeout(() => finish(null), Math.ceil(remaining));
        const unsubCancel = signal.onWake(() => finish(null));
      });
    },
  };
}

export class CameraSession {
  private _cancelled = false;
  private _process: CameraHelperProcess | null = null;
  private _ready = false;
  private readonly _spawner: CameraHelperSpawner;
  private readonly _javaPath: string;
  private readonly _jarPath: string;
  private readonly _checkBinariesExist: boolean;
  private readonly _allocatePort: () => Promise<number>;
  private readonly _stopGraceMs: number;
  private readonly _cancelWaiters = new Set<() => void>();

  constructor(options: CameraSessionOptions = {}) {
    this._spawner = options.spawner ?? launchCameraHelper;
    this._javaPath = options.javaPath ?? resourcePath("tools/camera_relay/runtime/bin/java.exe");
    this._jarPath = options.jarPath ?? resourcePath("tools/camera_relay/camera-relay.jar");
    this._checkBinariesExist = options.checkBinariesExist ?? options.spawner === undefined;
    this._allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this._stopGraceMs = options.stopGraceMs ?? 350;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  get process(): CameraHelperProcess | null {
    return this._process;
  }

  async start(source: CameraSource, options: CameraSessionStartOptions = {}): Promise<string> {
    try {
      return await this._start(source, options);
    } catch (err) {
      this.stop();
      if (err instanceof CameraPreviewError) {
        throw err;
      }
      throw new CameraPreviewError("远程视频连接启动失败，请稍后重试。", "CONFIG");
    }
  }

  protected async _start(source: CameraSource, options: CameraSessionStartOptions): Promise<string> {
    const onProgress = options.onProgress ?? (() => {});
    const quality = options.quality ?? 1;
    const onAudio = options.onAudio;
    const timeoutMs = options.timeoutMs ?? 90_000;

    if (this._checkBinariesExist && (!existsSync(this._javaPath) || !existsSync(this._jarPath))) {
      throw new CameraPreviewError("缺少远程摄像头组件，请安装后重试。", "CONFIG");
    }

    if (quality !== 0 && quality !== 1 && quality !== 2) {
      throw new CameraPreviewError("不支持的画质档位。");
    }

    const port = await this._allocatePort();
    const path = "/camera-" + randomUUID().replaceAll("-", "") + ".ts";

    const fields: unknown[] = [
      String(port),
      path,
      source?.uid,
      source?.init_string,
      source?.client_public,
      source?.client_private,
      source?.device_public,
      source?.sign,
      String(quality),
    ];

    if (
      fields.some(
        (v) =>
          typeof v !== "string" ||
          v.length === 0 ||
          v.includes("\n") ||
          v.includes("\r"),
      )
    ) {
      throw new CameraPreviewError("远程视频授权格式无效，请重新获取。");
    }

    if (this._cancelled) {
      throw new CameraPreviewError("预览已取消。");
    }

    const args = [
      this._javaPath,
      "-Xmx96m",
      "-XX:ErrorFile=NUL",
      "-cp",
      this._jarPath,
      "CameraRelay",
    ];
    const proc = this._spawner(args);
    this._process = proc;

    if (this._cancelled) {
      this.stop();
      throw new CameraPreviewError("预览已取消。", "CANCELLED");
    }

    const messages = createMessageQueue();
    this._pumpStdout(proc, messages, onProgress, onAudio);

    // Ephemeral keys go through a pipe, never process arguments or a config file.
    const written = proc.writeStdin((fields as string[]).join("\n") + "\n");
    if (!written) {
      throw new Error("Failed to write relay configuration to stdin pipe");
    }

    const self = this;
    const deadlineMs = performance.now() + timeoutMs;
    const signal = {
      get cancelled(): boolean {
        return self._cancelled;
      },
      deadlineMs,
      onWake: (fn: () => void) => {
        self._cancelWaiters.add(fn);
        return () => {
          self._cancelWaiters.delete(fn);
        };
      },
    };

    while (!this._cancelled && performance.now() < deadlineMs) {
      const message = await messages.next(signal);
      if (message === null) {
        break;
      }
      if (message === "READY") {
        if (this._cancelled || proc.exitCode !== null) {
          break;
        }
        this._ready = true;
        return `http://127.0.0.1:${port}${path}`;
      }
      if (message.startsWith("ERROR ")) {
        const key = message.slice(6);
        throw new CameraPreviewError(CAMERA_ERRORS[key] ?? "远程视频连接失败，请重试。", key);
      }
      if (message === "EXIT") {
        throw new CameraPreviewError("远程播放组件意外退出，请重试。", "HELPER_EXIT");
      }
      onProgress(message);
    }

    throw new CameraPreviewError(
      this._cancelled ? "预览已取消。" : "远程视频连接超时，请重试。",
      this._cancelled ? "CANCELLED" : "TIMEOUT",
    );
  }

  private _pumpStdout(
    proc: CameraHelperProcess,
    messages: AsyncMessageQueue,
    onProgress: (msg: string) => void,
    onAudio?: (rate: number, pcm: Uint8Array) => void,
  ): void {
    const stream = proc.stdout;
    if (!stream) {
      messages.push("EXIT");
      return;
    }

    const handleLine = (raw: string, state: { errorSeen: boolean }) => {
      const message = raw.trim();
      if (!message) {
        return;
      }
      if (message.startsWith("AUDIO 8000 ")) {
        if (onAudio && !this._cancelled) {
          const pcm = decodeBase64Strict(message.slice(11));
          if (pcm !== null && pcm.byteLength <= 16384) {
            onAudio(8000, pcm);
          }
        }
        return;
      }
      if (PASSTHROUGH_MESSAGES.has(message)) {
        if (!this._cancelled) {
          onProgress(message);
        }
        return;
      }
      if (
        message === "READY" ||
        PHASE_MESSAGES.has(message) ||
        (message.startsWith("ERROR ") && Object.prototype.hasOwnProperty.call(CAMERA_ERRORS, message.slice(6)))
      ) {
        messages.push(message);
        if (message.startsWith("ERROR ")) {
          state.errorSeen = true;
          if (this._ready && !this._cancelled) {
            onProgress(message);
          }
        }
      }
    };

    void (async () => {
      const state = { errorSeen: false };
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8");
      let remainder = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          remainder += decoder.decode(value, { stream: true });
          let newlineIndex = remainder.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = remainder.slice(0, newlineIndex);
            remainder = remainder.slice(newlineIndex + 1);
            handleLine(line, state);
            newlineIndex = remainder.indexOf("\n");
          }
        }
        remainder += decoder.decode();
        if (remainder.length > 0) {
          handleLine(remainder, state);
        }
      } catch {
        // stream closed or read interrupted on process termination
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        messages.push("EXIT");
        if (this._ready && !this._cancelled && !state.errorSeen) {
          onProgress("ERROR STREAM");
        }
      }
    })();
  }

  command(name: CameraCommandName, value: number): boolean {
    const allowed = ALLOWED_COMMANDS[name];
    if (!allowed || !allowed.includes(value)) {
      return false;
    }
    const proc = this._process;
    if (this._cancelled || proc === null || proc.exitCode !== null) {
      return false;
    }
    try {
      return proc.writeStdin(`${name} ${value}\n`);
    } catch {
      return false;
    }
  }

  stop(): void {
    this._cancelled = true;
    for (const wake of [...this._cancelWaiters]) {
      wake();
    }
    this._cancelWaiters.clear();

    const proc = this._process;
    this._process = null;
    if (proc === null) {
      return;
    }

    if (proc.exitCode === null) {
      const wroteStop = proc.writeStdin("STOP\n");
      proc.closeStdin();
      if (!wroteStop && proc.exitCode === null) {
        proc.terminate();
      }
      this._ensureProcessExit(proc);
    } else {
      proc.closeStdin();
    }
  }

  private _ensureProcessExit(proc: CameraHelperProcess): void {
    const graceMs = this._stopGraceMs;
    let settled = false;
    let termTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      if (termTimer !== null) {
        clearTimeout(termTimer);
        termTimer = null;
      }
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    void proc.exited.then(cleanup, cleanup);

    termTimer = setTimeout(() => {
      if (settled || proc.exitCode !== null) {
        cleanup();
        return;
      }
      proc.terminate();
      killTimer = setTimeout(() => {
        if (!settled && proc.exitCode === null) {
          proc.kill();
        }
        cleanup();
      }, graceMs);
    }, graceMs);
  }
}
