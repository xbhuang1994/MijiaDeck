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
import { VoiceStreamSession } from "../agent/voiceStreamSession.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type AppMode } from "../cli/startup.ts";
import * as agentConfigStore from "../core/agentConfigStore.ts";
import { NetworkMonitor } from "../core/availability.ts";
import type { IJobExecutor, IMijiaService } from "../core/contracts.ts";
import { JobExecutor } from "../core/jobs.ts";
import * as settingsStore from "../core/settingsStore.ts";
import * as trayStore from "../core/trayStore.ts";
import { VirtualDemoService, VirtualLightService } from "../core/virtualLightService.ts";
import { createMultiPlatformService, isMultiPlatformService } from "../platforms/index.ts";
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
  voiceStream?: VoiceStreamSession | null;
  ttsSpeaking?: boolean;
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
  modelFetcher?: typeof fetch;
  systemOneFetcher?: typeof fetch;
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
  return createMultiPlatformService();
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
  ws: { send(data: string): number | void; data: WsData },
  raw: string | Buffer | Uint8Array,
  runtime: AppRuntime,
  activeVoiceStreams: Set<VoiceStreamSession>,
): void {
  // 二进制帧：来自浏览器 AudioWorklet 的 16kHz Int16 PCM 实时音频流（零 JSON 开销）
  if (typeof raw !== "string") {
    if (ws.data.voiceStream) {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      ws.data.voiceStream.pushInt16Frame(bytes);
      return;
    }
    // 兼容极少数客户端以二进制帧发送 ping/JSON
  }

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
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (parsed.type === "get_state" || parsed.type === "refresh_state") {
      const snapshot = serializeState(runtime);
      ws.send(JSON.stringify({ type: "state", data: snapshot, state: snapshot }));
    } else if (parsed.type === "voice_stream_start") {
      if (ws.data.voiceStream) {
        activeVoiceStreams.delete(ws.data.voiceStream);
        ws.data.voiceStream.dispose();
        ws.data.voiceStream = null;
      }
      const vl = runtime.voiceListener;
      if (!vl) return;
      const cfg = vl.config;
      const bypassWakeWord = parsed.bypassWakeWord === true;
      const lang = typeof parsed.lang === "string" && parsed.lang.trim() ? parsed.lang.trim() : cfg.voiceLang;
      const sampleRate = typeof parsed.sampleRate === "number" && parsed.sampleRate >= 8000 ? parsed.sampleRate : 16000;
      const prefRaw = typeof parsed.engine === "string" ? parsed.engine : "auto";
      const preferredEngine: "auto" | "local" | "whisper" =
        prefRaw === "local" || prefRaw === "whisper" ? prefRaw : "auto";

      const session = new VoiceStreamSession({
        localEngine: vl.localEngine,
        noiseMode: cfg.noiseSuppressionMode,
        vadSilenceMs: cfg.vadSilenceMs,
        vadSensitivity: cfg.vadSensitivity,
        sampleRate,
        bypassWakeWord,
        wakeWordEnabled: cfg.wakeWordEnabled,
        wakeGatedAsr: true,
        isInConversation: () => vl.dialogState === "conversation",
        lang,
        engine: preferredEngine,
        wakeWords: cfg.wakeWords,
        owwEnabled: cfg.owwEnabled,
        owwThreshold: cfg.owwThreshold,
        streamingAsrEnabled: cfg.streamingAsrEnabled,
        voicePipelineMode: cfg.voicePipelineMode,
        echoCancellationMode: cfg.echoCancellationMode,
        clientAecActive: parsed.clientAecActive === true,
        onAecTelemetry: (telemetry) => {
          vl.handleTtsClientState({
            phase: "telemetry",
            aecActive: telemetry.active,
            erleDb: telemetry.erleDb,
            doubleTalk: telemetry.doubleTalk,
          });
        },
        onPartialTranscript: (partial) => {
          try {
            ws.send(
              JSON.stringify({
                type: "voice_stream_event",
                kind: "partial",
                text: partial.text,
                stableText: partial.stableText,
                unstableText: partial.unstableText,
                engine: partial.engine,
                latencyMs: partial.latencyMs,
              }),
            );
          } catch {
            // ignore closed socket
          }
        },
        onWakeWordSpot: (hit) => {
          vl.recordWakeWordSpot(hit);
          try {
            ws.send(
              JSON.stringify({
                type: "voice_stream_event",
                kind: "wake_spot",
                wakeWord: hit.wakeWord,
                score: hit.score,
                rawScore: hit.rawScore,
                threshold: hit.threshold,
                source: hit.source,
                matched: hit.matched,
                latencyMs: hit.latencyMs,
                hit,
              }),
            );
          } catch {
            // ignore closed socket
          }
        },
        onSpeechActivity: (speaking) => {
          vl.setSpeechInProgress(speaking);
          try {
            ws.send(
              JSON.stringify({
                type: "voice_stream_event",
                kind: speaking ? "speech_start" : "speech_end",
              }),
            );
          } catch {
            // ignore closed socket
          }
        },
        onSegmentReady: async (seg) => {
          const result = await vl.processDualTrackSegment(seg, {
            lang,
            bypassWakeWord,
            preferredEngine,
            asyncDispatch: vl.config.asyncVoicePipeline !== false,
            duringTtsPlayback: seg.duringTtsPlayback,
          });
          try {
            ws.send(
              JSON.stringify({
                type: "voice_stream_event",
                kind: "result",
                text: result.text,
                matched: result.matched,
                wokeOnly: result.wokeOnly,
                dispatchedAsync: result.dispatchedAsync === true,
                taskId: result.taskId,
                entryId: result.entryId,
                command: result.command,
                reply: result.reply,
                attention: result.attention,
                voiceprint: result.voiceprint,
                acousticWake: result.acousticWake,
                snrGainDb: result.snrGainDb,
                asrEngine: result.asrEngine,
                detectedSoundTypes: result.detectedSoundTypes,
                detectedSpeakerCount: result.detectedSpeakerCount,
                separatedStreams: result.separatedStreams,
                timings: result.timings,
                agent: runtime.piAgent ? runtime.piAgent.snapshot() : null,
                voiceState: result.voiceState,
              }),
            );
          } catch {
            // ignore closed socket
          }
          return result;
        },
      });
      ws.data.voiceStream = session;
      activeVoiceStreams.add(session);
      ws.send(
        JSON.stringify({
          type: "voice_stream_event",
          kind: "started",
          denoiseEngine: session.denoiseEngine,
        }),
      );
    } else if (parsed.type === "voice_stream_flush") {
      void ws.data.voiceStream?.flush();
    } else if (parsed.type === "voice_stream_stop") {
      if (ws.data.voiceStream) {
        activeVoiceStreams.delete(ws.data.voiceStream);
        ws.data.voiceStream.dispose();
        ws.data.voiceStream = null;
      }
      runtime.voiceListener?.setSpeechInProgress(false);
      if (ws.data.ttsSpeaking) {
        ws.data.ttsSpeaking = false;
        runtime.voiceListener?.handleTtsClientState({ speaking: false, phase: "cancel" });
      }
    } else if (parsed.type === "voice_dialog_control") {
      const vl = runtime.voiceListener;
      if (!vl) return;
      const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
      const speakAck = parsed.speakAck === true;
      if (action === "enter") {
        vl.enterConversation("ws_control", { speakAck });
      } else if (action === "exit") {
        vl.exitConversation("ws_control", { speakAck });
      } else if (action === "toggle") {
        vl.toggleConversation();
      }
    } else if (parsed.type === "voice_tts_state") {
      const vl = runtime.voiceListener;
      if (!vl) return;
      const speaking = typeof parsed.speaking === "boolean" ? parsed.speaking : undefined;
      const phaseRaw = typeof parsed.phase === "string" ? parsed.phase.trim() : undefined;
      const phase =
        phaseRaw === "start" ||
        phaseRaw === "end" ||
        phaseRaw === "cancel" ||
        phaseRaw === "duck" ||
        phaseRaw === "unduck" ||
        phaseRaw === "telemetry"
          ? phaseRaw
          : undefined;
      if (speaking !== undefined) {
        ws.data.ttsSpeaking = speaking;
      }
      const clientAecFlag = typeof parsed.aecActive === "boolean" ? parsed.aecActive : undefined;
      if (clientAecFlag !== undefined) {
        ws.data.voiceStream?.setClientAecActive(clientAecFlag);
      }
      const uttText = typeof parsed.text === "string" ? parsed.text : undefined;
      if (phase === "cancel") {
        ws.data.voiceStream?.clearFarEndReference();
      } else if (
        ws.data.voiceStream &&
        !ws.data.voiceStream.clientAecActive &&
        uttText &&
        (phase === "start" || (speaking === true && phase !== "telemetry"))
      ) {
        const cfg = vl.config;
        const cachedRef = vl.localEngine.tts.getCachedPcm16k(uttText, {
          voice: cfg.ttsVoice,
          speed: cfg.ttsSpeed,
        });
        if (cachedRef && cachedRef.length > 0) {
          ws.data.voiceStream.pushFarEndReference(cachedRef, 16000);
        }
      }
      vl.handleTtsClientState({
        speaking,
        phase,
        utteranceId: typeof parsed.utteranceId === "string" ? parsed.utteranceId : undefined,
        text: uttText,
        queueLength: typeof parsed.queueLength === "number" ? parsed.queueLength : undefined,
        ducked: typeof parsed.ducked === "boolean" ? parsed.ducked : undefined,
        aecActive: clientAecFlag,
        erleDb: typeof parsed.erleDb === "number" ? parsed.erleDb : undefined,
        doubleTalk: typeof parsed.doubleTalk === "boolean" ? parsed.doubleTalk : undefined,
      });
      if (speaking !== undefined) {
        if (vl.config.asyncVoicePipeline !== false) {
          ws.data.voiceStream?.notifyTtsState(speaking);
        } else {
          ws.data.voiceStream?.resetAfterTts();
        }
      }
    } else if (parsed.type === "voice_cancel_task") {
      const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
      if (taskId) {
        runtime.piAgent?.abortTask(taskId);
      } else {
        runtime.piAgent?.abort();
      }
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
  const activeVoiceStreams = new Set<VoiceStreamSession>();
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
    reloadVoiceStreams: (wakeWords, threshold, streamOpts) => {
      for (const stream of activeVoiceStreams) {
        if (typeof streamOpts?.wakeWordEnabled === "boolean") {
          stream.setWakeWordEnabled(streamOpts.wakeWordEnabled);
        }
        if (typeof streamOpts?.owwEnabled === "boolean") {
          stream.setOwwEnabled(streamOpts.owwEnabled);
        }
        stream.reloadWakeWords(wakeWords, threshold);
        if (typeof streamOpts?.streamingAsrEnabled === "boolean") {
          stream.setStreamingAsrEnabled(streamOpts.streamingAsrEnabled);
        }
        if (
          streamOpts?.voicePipelineMode === "legacy" ||
          streamOpts?.voicePipelineMode === "xfyun" ||
          streamOpts?.voicePipelineMode === "voice-ws"
        ) {
          stream.setVoicePipelineMode(streamOpts.voicePipelineMode);
        }
        if (streamOpts?.noiseSuppressionMode !== undefined) {
          stream.setNoiseMode(streamOpts.noiseSuppressionMode);
        }
        if (streamOpts?.echoCancellationMode !== undefined) {
          stream.setEchoCancellationMode(streamOpts.echoCancellationMode);
        }
        if (
          typeof streamOpts?.vadSilenceMs === "number" ||
          streamOpts?.vadSensitivity !== undefined
        ) {
          stream.updateVadTiming({
            vadSilenceMs: streamOpts?.vadSilenceMs,
            vadSensitivity: streamOpts?.vadSensitivity,
          });
        }
      }
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
    ...(options.systemOneFetcher ? { systemOneFetcher: options.systemOneFetcher } : {}),
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
      const inConv = voiceSnapshot.dialogState === "conversation";
      const transitionReason = voiceSnapshot.lastTransitionReason ?? undefined;
      for (const stream of activeVoiceStreams) {
        stream.syncDialogState(inConv, transitionReason);
      }
      broadcaster.broadcast({
        type: "voice_state",
        data: voiceSnapshot,
      });
    }),
    voiceListener.on("speakRequested", (text, meta) => {
      broadcaster.broadcast({
        type: "agent_speak",
        text,
        ...(meta?.utteranceId ? { utteranceId: meta.utteranceId } : {}),
        ...(meta?.priority ? { priority: meta.priority } : {}),
        ...(meta?.taskId ? { taskId: meta.taskId } : {}),
        ...(meta?.interrupt !== undefined ? { interrupt: meta.interrupt } : {}),
        data: {
          text,
          ...(meta?.utteranceId ? { utteranceId: meta.utteranceId } : {}),
          ...(meta?.priority ? { priority: meta.priority } : {}),
          ...(meta?.taskId ? { taskId: meta.taskId } : {}),
          ...(meta?.interrupt !== undefined ? { interrupt: meta.interrupt } : {}),
        },
      });
    }),
    voiceListener.on("speakChunkRequested", ({ text, final, utteranceId, priority, taskId }) => {
      broadcaster.broadcast({
        type: "agent_speak_chunk",
        text,
        final,
        ...(utteranceId ? { utteranceId } : {}),
        ...(priority ? { priority } : {}),
        ...(taskId ? { taskId } : {}),
        data: {
          text,
          final,
          ...(utteranceId ? { utteranceId } : {}),
          ...(priority ? { priority } : {}),
          ...(taskId ? { taskId } : {}),
        },
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
    modelFetcher: options.modelFetcher,
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
        handleWsMessage(ws, message, runtime, activeVoiceStreams);
      },
      close(ws) {
        if (ws.data.voiceStream) {
          activeVoiceStreams.delete(ws.data.voiceStream);
          ws.data.voiceStream.dispose();
          ws.data.voiceStream = null;
          runtime.voiceListener?.setSpeechInProgress(false);
        }
        if (ws.data.ttsSpeaking) {
          ws.data.ttsSpeaking = false;
          runtime.voiceListener?.handleTtsClientState({ speaking: false, phase: "cancel" });
        }
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
    for (const stream of activeVoiceStreams) {
      stream.dispose();
    }
    activeVoiceStreams.clear();
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
    if (isMultiPlatformService(service) && typeof service.dispose === "function") {
      try {
        await service.dispose();
      } catch {
        // ignore provider dispose errors on shutdown
      }
    }
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
