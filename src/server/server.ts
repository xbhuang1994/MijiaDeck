// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * MijiaDeck 本地 HTTP + WebSocket 服务端装配与生命周期管理。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PiAgentService } from "../agent/piAgentService.ts";
import { VoiceListenerController } from "../agent/voiceListenerController.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type AppMode } from "../cli/startup.ts";
import * as agentConfigStore from "../core/agentConfigStore.ts";
import { NetworkMonitor } from "../core/availability.ts";
import type { IJobExecutor, IMijiaService } from "../core/contracts.ts";
import { JobExecutor } from "../core/jobs.ts";
import { MijiaService } from "../core/service.ts";
import * as settingsStore from "../core/settingsStore.ts";
import * as trayStore from "../core/trayStore.ts";
import { VirtualDemoService, VirtualLightService } from "../core/virtualLightService.ts";
import { MainWindowController } from "../ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../ui/theme.ts";
import {
  StateBroadcaster,
  createRequestHandler,
  serializeState,
  type AppRuntime,
} from "./routes.ts";

export interface WsData {
  connectedAt: number;
}

export interface StartServerOptions {
  port?: number;
  hostname?: string;
  mode?: AppMode;
  service?: IMijiaService;
  jobs?: IJobExecutor;
  rootDir?: string;
  updateFetcher?: typeof fetch;
  sttFetcher?: typeof fetch;
  agentStreamFn?: StreamFn;
  agentModel?: Model<Api>;
  autoStart?: boolean;
  autoStartTimers?: boolean;
}

export interface MijiaDeckServer {
  readonly server: ReturnType<typeof Bun.serve<WsData>>;
  readonly url: string;
  readonly port: number;
  readonly runtime: AppRuntime;
  stop(): Promise<void>;
}

function createServiceForMode(mode: AppMode): IMijiaService {
  if (mode === "demo") {
    return new VirtualDemoService();
  }
  if (mode === "virtual-light") {
    return new VirtualLightService();
  }
  return new MijiaService();
}

async function waitForInitialVirtualLoad(
  mainWindow: MainWindowController,
  timeoutMs = 2_000,
): Promise<void> {
  const isSettled = (): boolean =>
    !mainWindow.loggedOut &&
    !mainWindow.loadActive &&
    !mainWindow.loadingDevices &&
    !mainWindow.loadingScenes &&
    !mainWindow.pollInFlight &&
    mainWindow.allDevices.length > 0 &&
    !(mainWindow.tray?.quick.audioBar.readInFlight ?? false);

  if (isSettled()) {
    return;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(deadline);
      clearInterval(checkTimer);
      unsubMain();
      unsubAudio?.();
      resolve();
    };

    const check = (): void => {
      if (isSettled()) {
        finish();
      }
    };

    const unsubMain = mainWindow.on("stateChanged", check);
    const unsubAudio = mainWindow.tray?.quick.audioBar.events.on("stateChanged", check);

    const checkTimer = setInterval(check, 15);
    (checkTimer as { unref?: () => void }).unref?.();

    const deadline = setTimeout(finish, timeoutMs);
    (deadline as { unref?: () => void }).unref?.();
  });
}

function handleWsMessage(
  ws: { send(data: string): number | void },
  raw: string | Buffer | Uint8Array,
  runtime: AppRuntime,
): void {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (parsed && parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (parsed && (parsed.type === "get_state" || parsed.type === "refresh_state")) {
      const snapshot = serializeState(runtime);
      ws.send(JSON.stringify({ type: "state", data: snapshot, state: snapshot }));
    }
  } catch {
    // 忽略非 JSON 心跳或未知文本帧
  }
}

async function resolveSpeakerAudioProps(
  service: IMijiaService,
  did: string,
): Promise<{ volName: string; muteName: string }> {
  let volName = "volume";
  let muteName = "mute-2";
  try {
    const detail = await service.deviceDetail(did);
    let mute2Found = false;
    for (const p of detail.props) {
      if (p.name === "volume" && p.range && p.range.length >= 2) {
        volName = p.name;
      }
      if (p.name === "mute-2") {
        mute2Found = true;
      }
    }
    if (!mute2Found) {
      for (const p of detail.props) {
        if (p.name.startsWith("mute") && p.writable && p.name !== "mute-4") {
          muteName = p.name;
          break;
        }
      }
    }
  } catch {
    // keep defaults
  }
  return { volName, muteName };
}

/**
 * 启动 MijiaDeck 本地 HTTP + WebSocket 控制台服务。
 */
export async function startMijiaDeckServer(
  options: StartServerOptions = {},
): Promise<MijiaDeckServer> {
  const mode: AppMode = options.mode ?? "live";
  const hostname = options.hostname ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const isLocalVirtual = mode !== "live";

  // 主题必须在创建任何控制器之前生效
  const initialThemeMode = settingsStore.getThemeMode();
  const initialThemeColor = settingsStore.getThemeColor();
  applyTheme(initialThemeMode, initialThemeColor);
  const themeCtrl = new ThemeController(initialThemeMode);

  const ownsJobs = options.jobs === undefined;
  const jobs: IJobExecutor = options.jobs ?? new JobExecutor();
  const service: IMijiaService = options.service ?? createServiceForMode(mode);

  const autoStartTimers =
    options.autoStartTimers ?? (!isLocalVirtual && options.service === undefined);
  const networkMonitor = new NetworkMonitor({
    initialReachability: isLocalVirtual ? "online" : "unknown",
    autoStart: autoStartTimers,
  });

  const mainWindow = new MainWindowController({
    service,
    jobs,
    themeCtrl,
    networkMonitor,
    autoStartTimers,
    ...(isLocalVirtual
      ? {
          cacheLoader: () => null,
          cacheSaver: () => {},
        }
      : {}),
  });

  const broadcaster = new StateBroadcaster();
  const speakerAudioProps = new Map<string, { volName: string; muteName: string }>();
  const pendingSpeakerLookups = new Set<string>();

  const ensureSpeakerAudioProps = (did: string | null): void => {
    if (!did || speakerAudioProps.has(did) || pendingSpeakerLookups.has(did)) {
      return;
    }
    pendingSpeakerLookups.add(did);
    jobs.submit(() => resolveSpeakerAudioProps(service, did), {
      priority: 15,
      onSuccess: (props) => {
        pendingSpeakerLookups.delete(did);
        speakerAudioProps.set(did, props);
        runtime.broadcastState?.();
      },
      onError: () => {
        pendingSpeakerLookups.delete(did);
      },
    });
  };

  const runtime: AppRuntime = {
    mode,
    service,
    jobs,
    mainWindow,
    themeCtrl,
    settingsStore,
    trayStore,
    agentConfigStore,
    broadcaster,
    speakerAudioProps,
    broadcastState: () => {
      const snapshot = serializeState(runtime);
      broadcaster.broadcast({
        type: "state",
        data: snapshot,
        state: snapshot,
      });
    },
  };

  const piAgent = new PiAgentService({
    deps: {
      service,
      jobs,
      mainWindow,
      settingsStore,
      broadcastState: () => runtime.broadcastState?.(),
    },
    ...(options.agentStreamFn ? { customStreamFn: options.agentStreamFn } : {}),
    ...(options.agentModel ? { customModel: options.agentModel } : {}),
  });
  const voiceListener = new VoiceListenerController(piAgent, {
    fetcher: options.sttFetcher,
  });
  runtime.piAgent = piAgent;
  runtime.voiceListener = voiceListener;

  const unsubscribers: Array<() => void> = [
    mainWindow.on("stateChanged", () => {
      ensureSpeakerAudioProps(mainWindow.tray?.quick.audioBar.did ?? null);
      runtime.broadcastState?.();
    }),
    mainWindow.on("toastRequested", (text, durationMs) => {
      broadcaster.broadcast({
        type: "toast",
        text,
        message: text,
        durationMs,
      });
    }),
    themeCtrl.on("themeChanged", (theme) => {
      broadcaster.broadcast({
        type: "theme_changed",
        resolved: theme,
        data: { resolved: theme },
      });
      runtime.broadcastState?.();
    }),
    piAgent.on("stateChanged", (agentSnapshot) => {
      broadcaster.broadcast({
        type: "agent_state",
        data: agentSnapshot,
      });
    }),
    piAgent.on("streamEvent", (ev) => {
      broadcaster.broadcast({
        type: "agent_event",
        data: ev,
      });
    }),
    voiceListener.on("stateChanged", (voiceSnapshot) => {
      broadcaster.broadcast({
        type: "voice_state",
        data: voiceSnapshot,
      });
    }),
    voiceListener.on("speakRequested", (text) => {
      broadcaster.broadcast({
        type: "agent_speak",
        text,
        data: { text },
      });
    }),
  ];
  if (mainWindow.tray !== null) {
    unsubscribers.push(
      mainWindow.tray.quick.audioBar.events.on("stateChanged", () => {
        ensureSpeakerAudioProps(mainWindow.tray?.quick.audioBar.did ?? null);
        runtime.broadcastState?.();
      }),
    );
  }

  const requestHandler = createRequestHandler(runtime, {
    rootDir: options.rootDir,
    updateFetcher: options.updateFetcher,
  });

  const server = Bun.serve<WsData>({
    port: requestedPort,
    hostname,
    // QR login long-poll (/api/auth/qr/wait) holds the request open up to 120s;
    // Bun's default idleTimeout is 10s which would abort waiting scans prematurely.
    idleTimeout: 255,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req, {
          data: { connectedAt: Date.now() },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response(JSON.stringify({ ok: false, error: "WebSocket 升级失败" }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return requestHandler(req);
    },
    websocket: {
      open(ws) {
        broadcaster.add(ws);
        try {
          const snapshot = serializeState(runtime);
          ws.send(JSON.stringify({ type: "state", data: snapshot, state: snapshot }));
        } catch {
          broadcaster.remove(ws);
        }
      },
      message(ws, message) {
        handleWsMessage(ws, message, runtime);
      },
      close(ws) {
        broadcaster.remove(ws);
      },
    },
  });

  const boundPort = server.port ?? requestedPort;
  const displayHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const url = `http://${displayHost}:${boundPort}`;

  if (options.autoStart !== false) {
    mainWindow.start();
    if (isLocalVirtual) {
      await waitForInitialVirtualLoad(mainWindow);
    }
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    voiceListener.dispose();
    piAgent.dispose();
    broadcaster.clear();
    await server.stop(true);
    networkMonitor.stop();
    mainWindow.dispose();
    if (ownsJobs) {
      await jobs.shutdown();
    }
  };

  return {
    server,
    url,
    port: boundPort,
    runtime,
    stop,
  };
}
