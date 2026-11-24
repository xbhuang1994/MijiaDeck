// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * HTTP REST API、静态资源服务、前端 TS 按需打包与 WebSocket 状态广播器。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PiAgentService } from "../agent/piAgentService.ts";
import type { VoiceListenerController, VoiceListenMode } from "../agent/voiceListenerController.ts";
import type { AppMode } from "../cli/startup.ts";
import * as agentConfigStoreModule from "../core/agentConfigStore.ts";
import { APP_NAME, APP_VERSION, projectRoot } from "../core/appMeta.ts";
import { MESSAGES, speakerHint } from "../core/availability.ts";
import { CameraPreviewError } from "../core/cameraPreview.ts";
import type {
  IJobExecutor,
  IMijiaService,
  QrLoginData,
  TrayOrderItem,
  TraySceneSnapshot,
} from "../core/contracts.ts";
import { isCamera, isLight, lightControls, supportsCardPower, trayEligible } from "../core/deviceControls.ts";
import { JobExecutor } from "../core/jobs.ts";
import {
  createSceneInfo,
  isSpeaker,
  type ActionInfo,
  type DeviceInfo,
  type PropInfo,
} from "../core/models.ts";
import { formatMetricsText, ServiceError } from "../core/service.ts";
import { isSensitivePropertyName } from "../core/specZh.ts";
import * as settingsStoreModule from "../core/settingsStore.ts";
import * as trayStoreModule from "../core/trayStore.ts";
import { fetchLatestRelease, isNewer, type ReleaseInfo } from "../core/updateChecker.ts";
import {
  coercePropWriteValue,
  deviceCategoryLabel,
  type DeviceChannelState,
} from "../core/deviceDetailModel.ts";
import {
  ALL_HOMES,
  ALL_ROOMS,
  MainWindowController,
  SCENE_TAB,
  refreshSummary,
} from "../ui/controllers/mainWindowController.ts";
import { renderQrSvg } from "../ui/qrSvg.ts";
import {
  buildCss,
  currentAccent,
  currentTheme,
  palette,
  type ThemeController,
} from "../ui/theme.ts";

export type SettingsStoreModule = typeof settingsStoreModule;
export type TrayStoreModule = typeof trayStoreModule;
export type AgentConfigStoreModule = typeof agentConfigStoreModule;

export interface WsClient {
  send(data: string | ArrayBuffer | Uint8Array): number | void;
}

export class StateBroadcaster {
  private readonly _clients = new Set<WsClient>();

  add(client: WsClient): void {
    this._clients.add(client);
  }

  remove(client: WsClient): void {
    this._clients.delete(client);
  }

  get size(): number {
    return this._clients.size;
  }

  broadcast(payload: unknown): void {
    if (this._clients.size === 0) {
      return;
    }
    const serialized = JSON.stringify(payload);
    for (const client of [...this._clients]) {
      try {
        client.send(serialized);
      } catch {
        this._clients.delete(client);
      }
    }
  }

  clear(): void {
    this._clients.clear();
  }
}

export interface AppRuntime {
  mode: AppMode;
  service: IMijiaService;
  jobs: IJobExecutor;
  mainWindow: MainWindowController;
  themeCtrl: ThemeController;
  settingsStore: SettingsStoreModule;
  trayStore: TrayStoreModule;
  agentConfigStore?: AgentConfigStoreModule;
  piAgent?: PiAgentService;
  voiceListener?: VoiceListenerController;
  broadcaster?: StateBroadcaster;
  broadcastState?: () => void;
  speakerAudioProps?: Map<string, { volName: string; muteName: string }>;
}

export interface RequestHandlerOptions {
  rootDir?: string;
  updateFetcher?: typeof fetch;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /(serviceToken|ssecurity|passToken|cUserId|userId|p2p_id|init_string|authorization|cookie|api[_-]?key|sttApiKey)\s*[:=]\s*[^\s,;'"&}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-[A-Za-z0-9_\-]{8,}/g,
];

/**
 * 清洗面向前端的错误信息：绝不泄露调用栈、凭据、令牌或私有会话字段。
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  let cleaned = firstLine.replace(/\s+at\s+\S+.*$/g, "").trim();
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }
  if (!cleaned) {
    return "操作失败，请稍后重试";
  }
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

function errorStatusFor(err: unknown): number {
  if (err instanceof HttpError) {
    return err.status;
  }
  if (err instanceof ServiceError || err instanceof CameraPreviewError) {
    const msg = err.message;
    if (msg.includes("未找到")) {
      return 404;
    }
    if (
      msg.includes("无效") ||
      msg.includes("超出范围") ||
      msg.includes("不支持") ||
      msg.includes("缺少") ||
      msg.includes("需要文本") ||
      msg.includes("免登录") ||
      msg.includes("仅展示")
    ) {
      return 400;
    }
    return 500;
  }
  return 500;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是有效的 JSON");
  }
  if (!isPlainRecord(parsed)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return parsed;
}

function runInJobs<T>(jobs: IJobExecutor, fn: () => T | Promise<T>, priority = 5): Promise<T> {
  if (jobs instanceof JobExecutor && jobs.isClosed) {
    return Promise.reject(new ServiceError("后台任务执行器已关闭"));
  }
  return new Promise<T>((resolve, reject) => {
    jobs.submit(fn, {
      priority,
      onSuccess: (result) => resolve(result),
      onError: (error) => reject(error),
    });
  });
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "无效的 URL 参数编码");
  }
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

interface BundleCacheEntry {
  sourcePath: string;
  mtimeMs: number;
  code: string;
}

let cachedAppBundle: BundleCacheEntry | null = null;

export function invalidateAppBundleCache(): void {
  cachedAppBundle = null;
}

function latestWebMtimeMs(appTsPath: string): number {
  let latest = statSync(appTsPath).mtimeMs;
  const webDir = path.dirname(appTsPath);
  try {
    for (const entry of readdirSync(webDir)) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const mtime = statSync(path.join(webDir, entry)).mtimeMs;
      if (mtime > latest) {
        latest = mtime;
      }
    }
  } catch {
    // fallback to entry mtime
  }
  return latest;
}

async function buildAppBundle(appTsPath: string): Promise<string> {
  if (!existsSync(appTsPath)) {
    throw new HttpError(404, "前端脚本入口不存在");
  }
  const latestMtime = latestWebMtimeMs(appTsPath);
  if (
    cachedAppBundle !== null &&
    cachedAppBundle.sourcePath === appTsPath &&
    cachedAppBundle.mtimeMs === latestMtime
  ) {
    return cachedAppBundle.code;
  }

  const built = await Bun.build({
    entrypoints: [appTsPath],
    target: "browser",
    format: "esm",
  });

  if (!built.success || built.outputs.length === 0) {
    throw new HttpError(500, "前端脚本构建失败");
  }
  const code = await built.outputs[0]!.text();
  cachedAppBundle = {
    sourcePath: appTsPath,
    mtimeMs: latestMtime,
    code,
  };
  return code;
}

function serializeTheme(runtime: AppRuntime): Record<string, unknown> {
  return {
    mode: runtime.themeCtrl.mode(),
    effective: currentTheme(),
    accent: currentAccent(),
    customAccent: runtime.settingsStore.getCustomThemeColor(),
    palette: palette(),
  };
}

function serializeSettings(runtime: AppRuntime): Record<string, unknown> {
  const s = runtime.settingsStore;
  return {
    minimize_to_tray: s.getMinimizeToTray(),
    start_minimized: s.getStartMinimized(),
    voice_fab_enabled: s.getVoiceFabEnabled(),
    theme: s.getThemeMode(),
    theme_color: s.getThemeColor(),
    custom_theme_color: s.getCustomThemeColor(),
    hide_no_func_devices: s.getHideNoFuncDevices(),
    show_scene_tab: s.getShowSceneTab(),
    default_speaker_did: s.getDefaultSpeakerDid(),
    ui_scale: s.getUiScale(),
    tray_columns: s.getTrayColumns(),
    check_update_enabled: s.getCheckUpdateEnabled(),
    tray_intro_seen: s.getTrayIntroSeen(),
    autostart: s.getAutostart(),
    autostart_supported: s.autostartSupported(),
  };
}

function sortedSpeakers(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return devices
    .filter((d) => isSpeaker(d))
    .sort((a, b) => {
      const onlineDiff = (a.online ? 0 : 1) - (b.online ? 0 : 1);
      if (onlineDiff !== 0) {
        return onlineDiff;
      }
      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }
      return a.did < b.did ? -1 : a.did > b.did ? 1 : 0;
    });
}

function resolveSelectedSpeaker(
  devices: readonly DeviceInfo[],
  preferredDid: string,
): DeviceInfo | null {
  if (preferredDid) {
    const preferred = devices.find((d) => d.did === preferredDid && isSpeaker(d) && d.online);
    if (preferred) {
      return preferred;
    }
  }
  return devices.find((d) => isSpeaker(d) && d.online) ?? null;
}

/**
 * 序列化完整应用状态快照，供 GET /api/state 与 WebSocket 广播共用。
 */
export function serializeState(runtime: AppRuntime): Record<string, unknown> {
  const mw = runtime.mainWindow;
  const s = runtime.settingsStore;
  const ts = runtime.trayStore;
  const accessState = mw.accessState();
  const loggedIn = !mw.loggedOut;
  const allDevices = mw.allDevices;
  const visibleDevices = mw.visibleDevices();
  const roomMenu = mw.buildRoomMenu().entries;

  const speakers = sortedSpeakers(allDevices);
  const savedSpeakerDid = s.getDefaultSpeakerDid();
  const activeSpeaker = accessState === "ready" ? resolveSelectedSpeaker(allDevices, savedSpeakerDid) : null;
  const hint = accessState === "ready" ? speakerHint(allDevices) : "";
  const voiceAvailable = accessState === "ready" && activeSpeaker !== null;
  const audioBase = mw.tray ? mw.tray.quick.audioBar.snapshot() : null;
  const audioProps = activeSpeaker ? runtime.speakerAudioProps?.get(activeSpeaker.did) : undefined;
  const audioSnapshot = audioBase
    ? {
        ...audioBase,
        min: audioBase.sliderMin,
        max: audioBase.sliderMax,
        volName: audioProps?.volName ?? "volume",
        muteName: audioProps?.muteName ?? "mute-2",
      }
    : null;
  const footerSnapshot = mw.footer.snapshot();
  const apiVersion = runtime.service.apiVersion();

  return {
    ok: true,
    mode: runtime.mode,
    demo: runtime.mode !== "live",
    version: APP_VERSION,
    apiVersion,
    accessState,
    loggedIn,
    networkOnline: mw.networkOnline,
    theme: serializeTheme(runtime),
    homes: [...mw.homes],
    currentHome: mw.currentHome || ALL_HOMES,
    rooms: [...mw.tabNames],
    currentRoom: mw.currentRoom || ALL_ROOMS,
    roomMenu,
    devices: allDevices.map((d) => ({ ...d })),
    visibleDevices: visibleDevices.map((d) => ({ ...d })),
    knownPower: { ...mw.knownPower },
    metrics: { ...mw.metrics },
    scenes: (mw.scenes ?? []).map((sc) => ({ ...sc })),
    loading: {
      active: mw.loadActive,
      fullPage: mw.loadFullPage,
      showFooter: mw.loadShowFooter,
      value: mw.loadValue,
      progress: mw.loadValue,
      text: mw.loadingPageText,
      stage: mw.loadingPageText,
      loadingDevices: mw.loadingDevices,
    },
    footer: footerSnapshot,
    statusText: footerSnapshot.statusText,
    tray: {
      columns: s.getTrayColumns(),
      devices: ts.load(),
      scenes: ts.loadScenes(),
      order: ts.loadOrder(),
      audio: audioSnapshot,
      voiceAvailable,
      speakerHint: hint,
      speakers: speakers.map((sp) => ({
        did: sp.did,
        name: sp.name,
        room_name: sp.room_name,
        online: sp.online,
      })),
      selectedSpeakerDid: savedSpeakerDid,
      activeSpeakerDid: activeSpeaker?.did ?? null,
    },
    settings: serializeSettings(runtime),
    trayIntroSeen: s.getTrayIntroSeen(),
    app: {
      name: APP_NAME,
      version: APP_VERSION,
      apiVersion,
    },
    release: mw.footer.release,
    update: {
      release: mw.footer.release,
    },
    piAgent: runtime.piAgent ? runtime.piAgent.snapshot() : null,
    voiceListen: runtime.voiceListener ? runtime.voiceListener.snapshot() : null,
  };
}

function emitBroadcast(runtime: AppRuntime): void {
  if (runtime.broadcastState) {
    runtime.broadcastState();
  } else if (runtime.broadcaster) {
    const snapshot = serializeState(runtime);
    runtime.broadcaster.broadcast({
      type: "state",
      data: snapshot,
      state: snapshot,
    });
  }
}

function findPowerProp(props: readonly PropInfo[]): PropInfo | null {
  return (
    props.find(
      (p) =>
        p.type === "bool" &&
        p.writable &&
        (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
    ) ?? null
  );
}

async function awaitRefreshCompletion(mw: MainWindowController, timeoutMs = 30_000): Promise<{
  summary: string;
  error: string | null;
}> {
  let summary = "";
  let loadError: string | null = null;

  const donePromise = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubToast();
      unsubError();
      unsubState();
      resolve();
    };

    const unsubToast = mw.on("toastRequested", (text) => {
      summary = text;
    });
    const unsubError = mw.on("criticalError", (_title, message) => {
      loadError = message;
      finish();
    });
    const unsubState = mw.on("stateChanged", () => {
      if (!mw.loadActive && !mw.loadingDevices) {
        finish();
      }
    });

    const timer = setTimeout(() => {
      finish();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    mw.loadDevices({ manual: true });
    if (!mw.loadActive && !mw.loadingDevices) {
      finish();
    }
  });

  await donePromise;
  return {
    summary: summary || refreshSummary(mw.allDevices.length, 0, 0),
    error: loadError,
  };
}

function serveStaticFile(filePath: string, cacheControl = "no-cache"): Response {
  if (!existsSync(filePath)) {
    throw new HttpError(404, "资源文件不存在");
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new HttpError(404, "资源文件不存在");
  }
  return new Response(Bun.file(filePath), {
    status: 200,
    headers: {
      "Content-Type": mimeTypeFor(filePath),
      "Cache-Control": cacheControl,
    },
  });
}

function serveAssetPath(assetsRoot: string, rawSubPath: string): Response {
  if (rawSubPath.includes("\0") || rawSubPath.includes("\\") || rawSubPath.includes("..")) {
    throw new HttpError(403, "禁止访问该路径");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSubPath);
  } catch {
    throw new HttpError(400, "无效的资产路径编码");
  }
  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").includes("..")
  ) {
    throw new HttpError(403, "禁止访问该路径");
  }

  const rootResolved = path.resolve(assetsRoot);
  const target = path.resolve(rootResolved, decoded);
  const relative = path.relative(rootResolved, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(403, "禁止访问该路径");
  }

  return serveStaticFile(target, "public, max-age=3600");
}

function getBooleanField(
  body: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): boolean | undefined {
  const raw = snakeKey in body ? body[snakeKey] : body[camelKey];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    throw new HttpError(400, `参数 ${snakeKey} 必须为布尔值`);
  }
  return raw;
}

function getStringField(
  body: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const raw = snakeKey in body ? body[snakeKey] : body[camelKey];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new HttpError(400, `参数 ${snakeKey} 必须为字符串`);
  }
  return raw;
}

/**
 * 创建 MijiaDeck HTTP 请求处理器（覆盖全部静态页面与 /api/* 路由）。
 */
export function createRequestHandler(
  runtime: AppRuntime,
  options: RequestHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const rootDir = path.resolve(options.rootDir ?? projectRoot());
  const webDir = path.join(rootDir, "src", "web");
  const assetsDir = path.join(rootDir, "assets");

  return async (req: Request): Promise<Response> => {
    try {
      const rawPathMatch = /^https?:\/\/[^/?#]+([^?#]*)/.exec(req.url);
      const rawPathname = rawPathMatch ? rawPathMatch[1]! : "";
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      // 优先检查原始未规范化路径，防止 /assets/../ 或 /assets/%2e%2e/ 被 URL 解析器折叠绕过 403
      if (method === "GET" && rawPathname.startsWith("/assets/")) {
        const rawSubPath = rawPathname.slice("/assets/".length);
        return serveAssetPath(assetsDir, rawSubPath);
      }

      // ---------- 静态页面、主题 CSS、前端打包脚本与资产 ----------

      if (method === "GET" && pathname === "/") {
        return serveStaticFile(path.join(webDir, "index.html"), "no-cache");
      }

      if (method === "GET" && pathname === "/styles.css") {
        return serveStaticFile(path.join(webDir, "styles.css"), "no-cache");
      }

      if (method === "GET" && pathname === "/theme.css") {
        return new Response(buildCss(), {
          status: 200,
          headers: {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (method === "GET" && pathname === "/app.js") {
        const code = await buildAppBundle(path.join(webDir, "app.ts"));
        return new Response(code, {
          status: 200,
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      if (method === "GET" && pathname.startsWith("/assets/")) {
        const subPath = pathname.slice("/assets/".length);
        return serveAssetPath(assetsDir, subPath);
      }

      // ---------- 健康检查与完整状态快照 ----------

      if (method === "GET" && pathname === "/api/health") {
        return jsonResponse({
          ok: true,
          app: APP_NAME,
          version: APP_VERSION,
          mode: runtime.mode,
        });
      }

      if (method === "GET" && pathname === "/api/state") {
        return jsonResponse(serializeState(runtime));
      }

      // ---------- 设备刷新、电源、灯光、属性与动作 ----------

      if (method === "POST" && pathname === "/api/devices/refresh") {
        const mw = runtime.mainWindow;
        if (!mw.networkOnline) {
          throw new HttpError(400, MESSAGES.offline);
        }
        if (mw.loggedOut) {
          const loggedIn = await runInJobs(runtime.jobs, () => runtime.service.loginStatus(), 0);
          if (!loggedIn) {
            throw new HttpError(400, MESSAGES.signed_out);
          }
          mw.loggedOut = false;
          mw.footer.setLoggedIn(true);
          mw.syncAccessUi();
        }
        const { summary, error } = await awaitRefreshCompletion(mw);
        if (error !== null) {
          throw new HttpError(500, sanitizeErrorMessage(error));
        }
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          summary,
          state,
        });
      }

      const powerMatch = /^\/api\/devices\/([^/]+)\/power$/.exec(pathname);
      if (method === "POST" && powerMatch) {
        const did = decodeSegment(powerMatch[1]!);
        const body = await readJsonBody(req);
        let newState: boolean;
        if (body.state !== undefined) {
          if (typeof body.state !== "boolean") {
            throw new HttpError(400, "电源状态参数 state 必须为布尔值");
          }
          const target = body.state;
          await runInJobs(runtime.jobs, () => runtime.service.setPowerState(did, target), 1);
          newState = target;
        } else {
          newState = await runInJobs(runtime.jobs, () => runtime.service.togglePower(did), 1);
        }
        runtime.mainWindow.applyPowerState(did, newState);
        runtime.mainWindow.updateTrayDevices();
        emitBroadcast(runtime);
        const device = runtime.mainWindow.allDevices.find((d) => d.did === did);
        const message = device
          ? `已${newState ? "打开" : "关闭"}「${device.name}」`
          : `已${newState ? "打开" : "关闭"}设备`;
        return jsonResponse({
          ok: true,
          did,
          state: newState,
          power: newState,
          message,
        });
      }

      const detailMatch = /^\/api\/devices\/([^/]+)\/detail$/.exec(pathname);
      if (method === "GET" && detailMatch) {
        const did = decodeSegment(detailMatch[1]!);
        const mw = runtime.mainWindow;
        const device = mw.allDevices.find((d) => d.did === did);
        if (!device) {
          throw new HttpError(404, "未找到指定设备");
        }

        const isSplitParent = device.switch_channels.length > 0;
        const canCardPower = supportsCardPower(device);
        let props: PropInfo[] = [];
        let actions: ActionInfo[] = [];
        let values: Record<string, unknown> = {};
        let specError: string | null = null;
        let readWarning: string | null = null;
        let powerProp: PropInfo | null = null;
        let controls: Partial<Record<"brightness" | "temperature" | "color", PropInfo>> = {};

        try {
          const detail = await runInJobs(runtime.jobs, () => runtime.service.deviceDetail(did), 2);
          props = detail.props;
          actions = detail.actions;
          powerProp = canCardPower || isCamera(device) ? findPowerProp(props) : null;
          controls = isLight(device) ? lightControls(props) : {};

          if (device.online && mw.accessState() === "ready") {
            const readableNames = props
              .filter((p) => p.readable && !isSensitivePropertyName(p.name))
              .map((p) => p.name);
            if (readableNames.length > 0) {
              try {
                values = await runInJobs(
                  runtime.jobs,
                  () => runtime.service.readProps(did, readableNames),
                  2,
                );
              } catch (readErr) {
                readWarning = sanitizeErrorMessage(readErr);
              }
            }
          }
        } catch (err) {
          specError = sanitizeErrorMessage(err);
        }

        // Sync fresh power & metrics back to main grid / tray
        let stateMutated = false;
        if (powerProp && typeof values[powerProp.name] === "boolean") {
          const freshPower = values[powerProp.name] as boolean;
          if (canCardPower || isCamera(device)) {
            if (mw.knownPower[did] !== freshPower) {
              mw.applyPowerState(did, freshPower);
              mw.updateTrayDevices();
              stateMutated = true;
            }
          }
        }

        const freshMetrics = formatMetricsText(
          values["temperature"],
          values["relative-humidity"] ?? values["humidity"],
        );
        if (freshMetrics && mw.metrics[did] !== freshMetrics) {
          mw.metrics[did] = freshMetrics;
          stateMutated = true;
        }

        // Split switch panel: gather & refresh child channels
        const channels: DeviceChannelState[] = [];
        if (isSplitParent) {
          const onlineChildDids = device.switch_channels.filter((childDid) => {
            const ch = mw.allDevices.find((d) => d.did === childDid);
            return Boolean(ch?.online);
          });
          if (onlineChildDids.length > 0 && mw.accessState() === "ready") {
            try {
              const states = await runInJobs(
                runtime.jobs,
                () => runtime.service.powerStates(onlineChildDids),
                2,
              );
              for (const [childDid, st] of Object.entries(states)) {
                if (typeof st === "boolean" && mw.knownPower[childDid] !== st) {
                  mw.applyPowerState(childDid, st);
                  stateMutated = true;
                }
              }
              if (stateMutated) {
                mw.updateTrayDevices();
              }
            } catch {
              // keep cached channel power states on transient read error
            }
          }
          for (const childDid of device.switch_channels) {
            const ch = mw.allDevices.find((d) => d.did === childDid);
            channels.push({
              did: childDid,
              name: ch?.name ?? childDid,
              room_name: ch?.room_name ?? device.room_name,
              online: ch?.online ?? device.online,
              power: typeof mw.knownPower[childDid] === "boolean" ? mw.knownPower[childDid]! : null,
            });
          }
        }

        if (stateMutated) {
          emitBroadcast(runtime);
        }

        const resolvedPowerState =
          powerProp && typeof values[powerProp.name] === "boolean"
            ? (values[powerProp.name] as boolean)
            : typeof mw.knownPower[did] === "boolean"
              ? mw.knownPower[did]!
              : null;

        return jsonResponse({
          ok: true,
          did,
          device: { ...device },
          category: deviceCategoryLabel(device),
          online: device.online,
          supportsPower: canCardPower || (isCamera(device) && powerProp !== null),
          powerState: resolvedPowerState,
          powerProp,
          isSplitParent,
          channels,
          lightControls: controls,
          props,
          actions,
          values,
          specError,
          readWarning,
          inTray: runtime.trayStore.load().includes(did),
          trayEligible: trayEligible(device),
          metrics: mw.metrics[did] ?? null,
          fetchedAt: Date.now(),
        });
      }

      const lightMatch = /^\/api\/devices\/([^/]+)\/light$/.exec(pathname);
      if (method === "GET" && lightMatch) {
        const did = decodeSegment(lightMatch[1]!);
        const detail = await runInJobs(runtime.jobs, () => runtime.service.deviceDetail(did), 2);
        const controls = lightControls(detail.props);
        const powerProp = findPowerProp(detail.props);
        const propNames = new Set<string>();
        if (powerProp && powerProp.readable) {
          propNames.add(powerProp.name);
        }
        for (const prop of Object.values(controls)) {
          if (prop && prop.readable) {
            propNames.add(prop.name);
          }
        }
        const names = [...propNames];
        const values =
          names.length > 0
            ? await runInJobs(runtime.jobs, () => runtime.service.readProps(did, names), 2)
            : {};
        if (powerProp && typeof values[powerProp.name] === "boolean") {
          runtime.mainWindow.applyPowerState(did, values[powerProp.name] as boolean);
          runtime.mainWindow.updateTrayDevices();
        }
        return jsonResponse({
          ok: true,
          did,
          name: detail.name,
          model: detail.model,
          powerProp,
          controls,
          props: detail.props,
          values,
        });
      }

      const propMatch = /^\/api\/devices\/([^/]+)\/prop$/.exec(pathname);
      if (method === "POST" && propMatch) {
        const did = decodeSegment(propMatch[1]!);
        const body = await readJsonBody(req);
        const propName = typeof body.name === "string" ? body.name.trim() : "";
        if (!propName) {
          throw new HttpError(400, "缺少属性名参数 name");
        }
        if (!("value" in body) || body.value === undefined) {
          throw new HttpError(400, "缺少属性值参数 value");
        }

        let cachedDetail: { props: PropInfo[] } | null = null;
        try {
          cachedDetail = await runInJobs(runtime.jobs, () => runtime.service.deviceDetail(did), 2);
        } catch {
          cachedDetail = null;
        }
        const targetProp = cachedDetail?.props.find(
          (p) => p.name === propName || p.name === propName.replaceAll("_", "-"),
        );
        const coerced = coercePropWriteValue(targetProp, body.value);
        if (!coerced.ok) {
          throw new HttpError(400, coerced.error);
        }

        await runInJobs(runtime.jobs, () => runtime.service.writeProp(did, propName, coerced.value), 1);

        // 回读设备最新状态（调亮度可能自动开灯、调风速档位可能切换模式等）
        let values: Record<string, unknown> = { [propName]: coerced.value };
        let powerPropName: string | null = null;
        try {
          const detail = cachedDetail ?? (await runInJobs(runtime.jobs, () => runtime.service.deviceDetail(did), 2));
          const powerProp = findPowerProp(detail.props);
          powerPropName = powerProp?.name ?? null;
          const controls = lightControls(detail.props);
          const toRead = new Set<string>();
          if (!targetProp || (targetProp.readable && !isSensitivePropertyName(targetProp.name))) {
            toRead.add(targetProp?.name ?? propName);
          }
          if (powerProp && powerProp.readable) {
            toRead.add(powerProp.name);
          }
          for (const p of Object.values(controls)) {
            if (p && p.readable) {
              toRead.add(p.name);
            }
          }
          for (const p of detail.props) {
            if (
              p.readable &&
              !isSensitivePropertyName(p.name) &&
              (p.name === "volume" ||
                p.name.startsWith("mute") ||
                p.name === "mode" ||
                p.name === "status" ||
                p.name === "fan-level" ||
                p.name === "playing-state" ||
                p.name === "temperature" ||
                p.name === "relative-humidity" ||
                p.name === "feed-plan" ||
                p.name === "skiped-plan" ||
                p.name === "plan-ctrl")
            ) {
              toRead.add(p.name);
            }
          }
          if (toRead.size > 0) {
            values = await runInJobs(
              runtime.jobs,
              () => runtime.service.readProps(did, [...toRead]),
              2,
            );
          }
        } catch {
          values = { [propName]: coerced.value };
        }

        const device = runtime.mainWindow.allDevices.find((d) => d.did === did);
        const powerVal = powerPropName ? values[powerPropName] : values["on"];
        if (typeof powerVal === "boolean" && (!device || supportsCardPower(device) || isCamera(device))) {
          runtime.mainWindow.applyPowerState(did, powerVal);
          runtime.mainWindow.updateTrayDevices();
        }
        const freshMetrics = formatMetricsText(
          values["temperature"],
          values["relative-humidity"] ?? values["humidity"],
        );
        if (freshMetrics) {
          runtime.mainWindow.metrics[did] = freshMetrics;
        }
        if (runtime.mainWindow.tray !== null && runtime.mainWindow.tray.quick.audioBar.did === did) {
          runtime.mainWindow.tray.quick.audioBar.refreshAfterCommand(did);
        }
        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          did,
          name: propName,
          value: coerced.value,
          values,
        });
      }

      const actionMatch = /^\/api\/devices\/([^/]+)\/action$/.exec(pathname);
      if (method === "POST" && actionMatch) {
        const did = decodeSegment(actionMatch[1]!);
        const body = await readJsonBody(req);
        const actionName = typeof body.name === "string" ? body.name.trim() : "";
        if (!actionName) {
          throw new HttpError(400, "缺少动作名参数 name");
        }
        await runInJobs(
          runtime.jobs,
          () => runtime.service.runAction(did, actionName, body.params),
          1,
        );

        let values: Record<string, unknown> = {};
        let actionLabel = actionName;
        try {
          const detail = await runInJobs(runtime.jobs, () => runtime.service.deviceDetail(did), 2);
          const matchedAct = detail.actions.find(
            (a) => a.name === actionName || a.name === actionName.replaceAll("_", "-"),
          );
          if (matchedAct?.desc) {
            actionLabel = matchedAct.desc;
          }
          const powerProp = findPowerProp(detail.props);
          const targetSiid = matchedAct?.siid;
          const readableProps = detail.props.filter(
            (p) => p.readable && !isSensitivePropertyName(p.name),
          );
          const prioritized = [
            ...readableProps.filter((p) => targetSiid !== undefined && p.siid === targetSiid),
            ...readableProps.filter((p) => targetSiid === undefined || p.siid !== targetSiid),
          ].map((p) => p.name);
          if (prioritized.length > 0) {
            values = await runInJobs(
              runtime.jobs,
              () => runtime.service.readProps(did, prioritized.slice(0, 30)),
              2,
            );
          }
          const device = runtime.mainWindow.allDevices.find((d) => d.did === did);
          if (
            powerProp &&
            typeof values[powerProp.name] === "boolean" &&
            (!device || supportsCardPower(device) || isCamera(device))
          ) {
            runtime.mainWindow.applyPowerState(did, values[powerProp.name] as boolean);
            runtime.mainWindow.updateTrayDevices();
          }
        } catch {
          // best-effort readback after action
        }

        if (runtime.mainWindow.tray !== null && runtime.mainWindow.tray.quick.audioBar.did === did) {
          runtime.mainWindow.tray.quick.audioBar.refreshAfterCommand(did);
        }
        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          did,
          name: actionName,
          values,
          message: `已执行「${actionLabel}」`,
        });
      }

      // ---------- 场景执行 ----------

      const sceneMatch = /^\/api\/scenes\/([^/]+)\/run$/.exec(pathname);
      if (method === "POST" && sceneMatch) {
        const sceneId = decodeSegment(sceneMatch[1]!);
        const body = await readJsonBody(req);
        const knownScene =
          (runtime.mainWindow.scenes ?? []).find((s) => s.scene_id === sceneId) ??
          runtime.trayStore.loadScenes().find((s) => s.scene_id === sceneId) ??
          null;
        const homeId = String(body.homeId ?? body.home_id ?? knownScene?.home_id ?? "");
        const sceneName = String(body.name ?? knownScene?.name ?? sceneId);
        const homeName = String(body.homeName ?? body.home_name ?? knownScene?.home_name ?? "");
        const scene = createSceneInfo({
          scene_id: sceneId,
          name: sceneName,
          home_id: homeId,
          home_name: homeName,
        });
        await runInJobs(runtime.jobs, () => runtime.service.runScene(scene), 1);

        // 场景可能联动改变灯光/开关状态，尝试回读最新电源状态
        const onlineDids = runtime.mainWindow.allDevices.filter((d) => d.online).map((d) => d.did);
        if (onlineDids.length > 0) {
          try {
            const states = await runInJobs(
              runtime.jobs,
              () => runtime.service.powerStates(onlineDids),
              5,
            );
            for (const [did, st] of Object.entries(states)) {
              runtime.mainWindow.applyPowerState(did, st);
            }
            runtime.mainWindow.updateTrayDevices();
          } catch {
            // 回读失败不影响场景执行成功结果
          }
        }

        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          sceneId,
          message: `已执行场景「${scene.name}」`,
        });
      }

      // ---------- 小爱语音指令 ----------

      if (method === "POST" && pathname === "/api/voice") {
        const body = await readJsonBody(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          throw new HttpError(400, "请输入小爱指令内容");
        }
        const devices = runtime.mainWindow.allDevices;
        const onlineSpeakers = devices.filter((d) => isSpeaker(d) && d.online);
        const requestedDid = typeof body.did === "string" ? body.did.trim() : "";
        const preferredDid = runtime.settingsStore.getDefaultSpeakerDid();

        let speaker: DeviceInfo | null = null;
        if (requestedDid) {
          speaker = onlineSpeakers.find((d) => d.did === requestedDid) ?? null;
        }
        if (speaker === null && preferredDid) {
          speaker = onlineSpeakers.find((d) => d.did === preferredDid) ?? null;
        }
        if (speaker === null) {
          speaker = onlineSpeakers[0] ?? null;
        }
        if (speaker === null) {
          throw new HttpError(400, speakerHint(devices) || "当前没有可用的在线小爱音箱");
        }

        let fallbackNote = "";
        if (requestedDid && requestedDid !== speaker.did) {
          fallbackNote = `（首选音箱离线，已由「${speaker.name}」代答）`;
        } else if (!requestedDid && preferredDid && preferredDid !== speaker.did) {
          fallbackNote = `（首选音箱离线，已由「${speaker.name}」代答）`;
          runtime.settingsStore.setDefaultSpeakerDid("");
        }

        const targetDid = speaker.did;
        await runInJobs(
          runtime.jobs,
          () => runtime.service.runAction(targetDid, "execute-text-directive", [text]),
          1,
        );
        if (runtime.mainWindow.tray !== null) {
          runtime.mainWindow.tray.refreshAudioAfterCommand(targetDid);
        }
        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          message: `已告诉小爱同学：${text}${fallbackNote}`,
          did: targetDid,
        });
      }

      // ---------- 家庭与房间筛选 ----------

      if (method === "POST" && pathname === "/api/home") {
        const body = await readJsonBody(req);
        if (typeof body.home !== "string") {
          throw new HttpError(400, "缺少家庭名称参数 home");
        }
        const home = body.home.trim() === "" ? ALL_HOMES : body.home.trim();
        if (runtime.mainWindow.homes.length > 0 && !runtime.mainWindow.homes.includes(home)) {
          throw new HttpError(404, `未找到家庭「${home}」`);
        }
        runtime.mainWindow.selectHome(home);
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          home: runtime.mainWindow.currentHome,
          state,
        });
      }

      if (method === "POST" && pathname === "/api/room") {
        const body = await readJsonBody(req);
        const room = typeof body.room === "string" ? body.room.trim() : "";
        if (!room) {
          throw new HttpError(400, "缺少房间名称参数 room");
        }
        if (runtime.mainWindow.tabNames.length > 0 && !runtime.mainWindow.tabNames.includes(room)) {
          throw new HttpError(404, `未找到房间「${room}」`);
        }
        runtime.mainWindow.selectRoom(room);
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          room: runtime.mainWindow.currentRoom,
          state,
        });
      }

      // ---------- 托盘管理与配置 ----------

      if (method === "POST" && pathname === "/api/tray/membership") {
        const body = await readJsonBody(req);
        const kind = body.kind;
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const selected = body.selected;
        if (kind !== "device" && kind !== "scene") {
          throw new HttpError(400, "参数 kind 必须为 device 或 scene");
        }
        if (!id) {
          throw new HttpError(400, "缺少项目标识参数 id");
        }
        if (typeof selected !== "boolean") {
          throw new HttpError(400, "参数 selected 必须为布尔值");
        }

        if (kind === "device") {
          if (selected) {
            const dev = runtime.mainWindow.allDevices.find((d) => d.did === id);
            if (dev && !trayEligible(dev)) {
              throw new HttpError(400, "该设备不支持添加到托盘快捷窗口");
            }
          }
          runtime.trayStore.setDeviceSelected(id, selected);
        } else {
          if (selected) {
            const scenes = runtime.trayStore.loadScenes();
            const order = runtime.trayStore.loadOrder();
            if (!scenes.some((s) => s.scene_id === id)) {
              const found = (runtime.mainWindow.scenes ?? []).find((s) => s.scene_id === id);
              scenes.push({
                scene_id: id,
                name: String(body.name ?? found?.name ?? id),
                home_id: String(body.homeId ?? body.home_id ?? found?.home_id ?? ""),
                home_name: String(body.homeName ?? body.home_name ?? found?.home_name ?? ""),
              });
              runtime.trayStore.saveScenes(scenes);
            }
            if (!order.some((it) => it.type === "scene" && it.id === id)) {
              order.push({ type: "scene", id });
              runtime.trayStore.saveOrder(order);
            }
          } else {
            runtime.trayStore.removeItem("scene", id);
          }
        }
        runtime.mainWindow.updateTrayDevices();
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          message: selected ? "已添加到托盘窗口" : "已从托盘窗口移除",
          state,
        });
      }

      if (method === "POST" && pathname === "/api/tray/save") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.devices)) {
          throw new HttpError(400, "参数 devices 必须为数组");
        }
        if (!Array.isArray(body.scenes)) {
          throw new HttpError(400, "参数 scenes 必须为数组");
        }
        if (!Array.isArray(body.order)) {
          throw new HttpError(400, "参数 order 必须为数组");
        }
        const devices = body.devices.map((d) => String(d));
        const scenes: Array<Partial<TraySceneSnapshot>> = body.scenes
          .filter(isPlainRecord)
          .map((item) => ({
            scene_id: item.scene_id ? String(item.scene_id) : "",
            name: item.name ? String(item.name) : "",
            home_id: item.home_id ? String(item.home_id) : "",
            home_name: item.home_name ? String(item.home_name) : "",
          }));
        const order: TrayOrderItem[] = body.order
          .filter(isPlainRecord)
          .filter((item) => (item.type === "device" || item.type === "scene") && Boolean(item.id))
          .map((item) => ({
            type: item.type as "device" | "scene",
            id: String(item.id),
          }));

        runtime.trayStore.save(devices);
        runtime.trayStore.saveScenes(scenes);
        runtime.trayStore.saveOrder(order);
        runtime.mainWindow.updateTrayDevices();
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          message: "托盘项目已更新",
          state,
        });
      }

      if (method === "POST" && pathname === "/api/tray/columns") {
        const body = await readJsonBody(req);
        const columns = body.columns;
        if (columns !== 1 && columns !== 2) {
          throw new HttpError(400, "托盘列数 columns 仅支持 1 或 2");
        }
        runtime.settingsStore.setTrayColumns(columns);
        if (runtime.mainWindow.tray !== null) {
          runtime.mainWindow.tray.quick.columns = columns;
          runtime.mainWindow.tray.quick.rebuild();
        }
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          columns,
          state,
        });
      }

      if (method === "POST" && pathname === "/api/tray/speaker") {
        const body = await readJsonBody(req);
        if (typeof body.did !== "string") {
          throw new HttpError(400, "音箱标识参数 did 必须为字符串");
        }
        const did = body.did.trim();
        if (did !== "") {
          const speaker = runtime.mainWindow.allDevices.find(
            (d) => d.did === did && isSpeaker(d) && d.online,
          );
          if (!speaker) {
            throw new HttpError(404, "未找到该在线小爱音箱");
          }
        }
        runtime.settingsStore.setDefaultSpeakerDid(did);
        runtime.mainWindow.updateVoiceFab();
        if (runtime.mainWindow.tray !== null) {
          runtime.mainWindow.tray.refreshSpeaker();
        }
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          did,
          state,
        });
      }

      if (method === "POST" && pathname === "/api/tray/intro/dismiss") {
        runtime.settingsStore.setTrayIntroSeen(true);
        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          trayIntroSeen: true,
        });
      }

      // ---------- 应用设置与实时主题预览 ----------

      if (method === "GET" && pathname === "/api/settings") {
        return jsonResponse({
          ok: true,
          settings: serializeSettings(runtime),
        });
      }

      if (method === "POST" && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        const s = runtime.settingsStore;
        const mw = runtime.mainWindow;
        const oldScale = s.getUiScale();

        const themeMode = getStringField(body, "theme", "themeMode");
        if (themeMode !== undefined) {
          if (themeMode !== "system" && themeMode !== "light" && themeMode !== "dark") {
            throw new HttpError(400, "无效的外观模式，仅支持 system / light / dark");
          }
          s.setThemeMode(themeMode);
        }

        const customColor = getStringField(body, "custom_theme_color", "customThemeColor");
        if (customColor !== undefined) {
          const normalized = s.normalizeThemeColor(customColor);
          if (!normalized || !normalized.startsWith("#")) {
            throw new HttpError(400, "请输入 #RRGGBB 格式的色值");
          }
          s.setCustomThemeColor(normalized);
        }

        const themeColor = getStringField(body, "theme_color", "themeColor");
        if (themeColor !== undefined) {
          const normalized = s.normalizeThemeColor(themeColor);
          if (!normalized) {
            throw new HttpError(400, "无效的主题色，请输入预设色名或 #RRGGBB 色值");
          }
          s.setThemeColor(normalized);
          if (normalized.startsWith("#") && customColor === undefined) {
            s.setCustomThemeColor(normalized);
          }
        }

        const minimizeToTray = getBooleanField(body, "minimize_to_tray", "minimizeToTray");
        if (minimizeToTray !== undefined) {
          s.setMinimizeToTray(minimizeToTray);
        }
        const effectiveMinimize = s.getMinimizeToTray();
        const startMinimized = getBooleanField(body, "start_minimized", "startMinimized");
        if (!effectiveMinimize) {
          s.setStartMinimized(false);
        } else if (startMinimized !== undefined) {
          s.setStartMinimized(startMinimized);
        }

        const voiceFabEnabled = getBooleanField(body, "voice_fab_enabled", "voiceFabEnabled");
        if (voiceFabEnabled !== undefined) {
          s.setVoiceFabEnabled(voiceFabEnabled);
        }

        const hideNoFunc = getBooleanField(body, "hide_no_func_devices", "hideNoFuncDevices");
        if (hideNoFunc !== undefined) {
          s.setHideNoFuncDevices(hideNoFunc);
        }

        const showSceneTab = getBooleanField(body, "show_scene_tab", "showSceneTab");
        if (showSceneTab !== undefined) {
          s.setShowSceneTab(showSceneTab);
        }

        const checkUpdateEnabled = getBooleanField(
          body,
          "check_update_enabled",
          "checkUpdateEnabled",
        );
        if (checkUpdateEnabled !== undefined) {
          s.setCheckUpdateEnabled(checkUpdateEnabled);
        }

        const trayIntroSeen = getBooleanField(body, "tray_intro_seen", "trayIntroSeen");
        if (trayIntroSeen !== undefined) {
          s.setTrayIntroSeen(trayIntroSeen);
        }

        const defaultSpeakerDid = getStringField(
          body,
          "default_speaker_did",
          "defaultSpeakerDid",
        );
        if (defaultSpeakerDid !== undefined) {
          s.setDefaultSpeakerDid(defaultSpeakerDid);
        }

        const rawScale = "ui_scale" in body ? body.ui_scale : body.uiScale;
        if (rawScale !== undefined) {
          const parsedScale = Number(rawScale);
          if (!Number.isFinite(parsedScale) || parsedScale <= 0) {
            throw new HttpError(400, "无效的界面缩放比例");
          }
          s.setUiScale(parsedScale);
        }

        const rawColumns = "tray_columns" in body ? body.tray_columns : body.trayColumns;
        if (rawColumns !== undefined) {
          if (rawColumns !== 1 && rawColumns !== 2) {
            throw new HttpError(400, "托盘列数仅支持 1 或 2");
          }
          s.setTrayColumns(rawColumns);
        }

        const autostart = getBooleanField(body, "autostart", "autostart");
        if (autostart !== undefined) {
          try {
            s.setAutostart(autostart);
          } catch {
            // 开机自启动写入失败不阻断其余设置保存
          }
        }

        // 应用主题模式与主题色
        runtime.themeCtrl.setMode(s.getThemeMode());
        runtime.themeCtrl.setAccent(s.getThemeColor());

        // 同步主窗口相关状态
        if (mw.tray !== null) {
          mw.tray.setTrayVisible(s.getMinimizeToTray());
        }
        const newHide = s.getHideNoFuncDevices();
        if (newHide !== mw.hideNoFunc) {
          mw.hideNoFunc = newHide;
          mw.rebuildTabs();
          mw.rebuildGrid();
          mw.updateCountLabel();
          mw.updateTrayDevices();
        }
        const newShow = s.getShowSceneTab();
        if (newShow !== mw.showSceneTab) {
          mw.showSceneTab = newShow;
          if (!newShow && mw.currentRoom === SCENE_TAB) {
            mw.currentRoom = ALL_ROOMS;
          }
          mw.rebuildTabs();
          mw.rebuildGrid();
          mw.updateCountLabel();
        }
        mw.updateVoiceFab();
        if (mw.tray !== null) {
          mw.tray.refreshSpeaker();
        }

        const scaleChanged = Math.abs(s.getUiScale() - oldScale) >= 1e-6;
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          scaleChanged,
          settings: serializeSettings(runtime),
          state,
        });
      }

      if (method === "POST" && pathname === "/api/theme/preview") {
        const body = await readJsonBody(req);
        const mode = typeof body.mode === "string" ? body.mode.trim() : undefined;
        const colorRaw =
          typeof body.color === "string"
            ? body.color.trim()
            : typeof body.accent === "string"
              ? body.accent.trim()
              : undefined;

        if (mode !== undefined) {
          if (mode !== "system" && mode !== "light" && mode !== "dark") {
            throw new HttpError(400, "无效的外观模式，仅支持 system / light / dark");
          }
          runtime.themeCtrl.setMode(mode);
        }
        if (colorRaw !== undefined) {
          const normalized = runtime.settingsStore.normalizeThemeColor(colorRaw);
          if (!normalized) {
            throw new HttpError(400, "无效的主题色，请输入预设色名或 #RRGGBB 色值");
          }
          runtime.themeCtrl.setAccent(normalized);
        }

        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          theme: serializeTheme(runtime),
        });
      }

      // ---------- 扫码登录与退出账号 ----------

      if (method === "POST" && pathname === "/api/auth/qr/begin") {
        const data = await runInJobs(runtime.jobs, () => runtime.service.qrLoginBegin(), 0);
        if (data === null) {
          runtime.mainWindow.completeLogin(true);
          emitBroadcast(runtime);
          return jsonResponse({
            ok: true,
            refreshed: true,
            loginData: null,
            qrSvg: null,
          });
        }
        const qrSvg =
          typeof data.loginUrl === "string" && data.loginUrl.length > 0
            ? renderQrSvg(data.loginUrl)
            : null;
        return jsonResponse({
          ok: true,
          refreshed: false,
          loginData: data,
          qrSvg,
        });
      }

      if (method === "POST" && pathname === "/api/auth/qr/wait") {
        const body = await readJsonBody(req);
        const rawLoginData = isPlainRecord(body.loginData)
          ? body.loginData
          : typeof body.lp === "string" || typeof body.loginUrl === "string"
            ? body
            : null;
        if (rawLoginData === null) {
          throw new HttpError(400, "缺少有效的扫码登录数据 loginData");
        }
        const loginData = rawLoginData as QrLoginData;
        await runInJobs(runtime.jobs, () => runtime.service.qrLoginWait(loginData), 0);
        runtime.mainWindow.completeLogin(true);
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          loggedIn: !runtime.mainWindow.loggedOut,
          state,
        });
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        runtime.jobs.cancelPending();
        await runInJobs(runtime.jobs, () => runtime.service.logout(), 0);
        runtime.mainWindow.accountSignedOut();
        emitBroadcast(runtime);
        const state = serializeState(runtime);
        return jsonResponse({
          ...state,
          ok: true,
          loggedIn: false,
          state,
        });
      }

      // ---------- 单设备诊断报告 ----------

      if (method === "POST" && pathname === "/api/diagnostics") {
        const body = await readJsonBody(req);
        const did = typeof body.did === "string" ? body.did.trim() : "";
        if (!did) {
          throw new HttpError(400, "缺少设备标识参数 did");
        }
        const device = runtime.mainWindow.allDevices.find((d) => d.did === did);
        if (!device) {
          throw new HttpError(404, "未找到指定设备");
        }
        const report = await runInJobs(
          runtime.jobs,
          () => runtime.service.deviceDiagnosticReport(device),
          2,
        );
        return jsonResponse({
          ok: true,
          did,
          report,
        });
      }

      // ---------- 新版本检查 ----------

      if (method === "GET" && pathname === "/api/update/check") {
        try {
          const release: ReleaseInfo = await fetchLatestRelease(options.updateFetcher);
          const hasUpdate = isNewer(release.tag, APP_VERSION);
          runtime.mainWindow.onUpdateAvailable(hasUpdate ? release : null);
          emitBroadcast(runtime);
          return jsonResponse({
            ok: true,
            hasUpdate,
            currentVersion: APP_VERSION,
            release,
          });
        } catch (err) {
          return jsonResponse({
            ok: false,
            hasUpdate: false,
            currentVersion: APP_VERSION,
            release: null,
            error: sanitizeErrorMessage(err),
          });
        }
      }

      // ---------- 内置 Pi Agent 与语音监听 ----------

      if (method === "GET" && pathname === "/api/agent/state") {
        if (!runtime.piAgent) {
          throw new HttpError(503, "Pi Agent 服务未初始化");
        }
        return jsonResponse({
          ok: true,
          agent: runtime.piAgent.snapshot(),
          voice: runtime.voiceListener ? runtime.voiceListener.snapshot() : null,
        });
      }

      if (method === "POST" && pathname === "/api/agent/prompt") {
        if (!runtime.piAgent) {
          throw new HttpError(503, "Pi Agent 服务未初始化");
        }
        const body = await readJsonBody(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          throw new HttpError(400, "请输入要发送给 Pi Agent 的指令内容");
        }
        const source = body.source === "voice" ? "voice" : "text";
        const result = await runtime.piAgent.prompt(text, { source });
        return jsonResponse({
          ok: result.ok,
          entryId: result.entryId,
          reply: result.reply,
          toolCalls: result.toolCalls,
          ...(result.error ? { error: result.error } : {}),
          agent: runtime.piAgent.snapshot(),
        });
      }

      if (method === "POST" && pathname === "/api/agent/abort") {
        if (!runtime.piAgent) {
          throw new HttpError(503, "Pi Agent 服务未初始化");
        }
        const aborted = runtime.piAgent.abort();
        return jsonResponse({
          ok: true,
          aborted,
          agent: runtime.piAgent.snapshot(),
        });
      }

      if (method === "POST" && pathname === "/api/agent/reset") {
        if (!runtime.piAgent) {
          throw new HttpError(503, "Pi Agent 服务未初始化");
        }
        runtime.piAgent.reset();
        return jsonResponse({
          ok: true,
          agent: runtime.piAgent.snapshot(),
        });
      }

      if (method === "GET" && pathname === "/api/agent/config") {
        const cfgStore = runtime.agentConfigStore ?? agentConfigStoreModule;
        const cfg = runtime.piAgent ? runtime.piAgent.config : cfgStore.loadAgentVoiceConfig();
        return jsonResponse({
          ok: true,
          config: cfgStore.toPublicAgentVoiceConfig(cfg),
          providers: cfgStore.PROVIDER_PRESETS,
        });
      }

      if (method === "POST" && pathname === "/api/agent/config") {
        const cfgStore = runtime.agentConfigStore ?? agentConfigStoreModule;
        const body = await readJsonBody(req);
        let updated: agentConfigStoreModule.AgentVoiceConfig;
        try {
          updated = cfgStore.updateAgentVoiceConfig(body);
        } catch (err) {
          throw new HttpError(400, sanitizeErrorMessage(err));
        }
        if (runtime.piAgent) {
          runtime.piAgent.reconfigure(updated);
        }
        if (runtime.voiceListener) {
          runtime.voiceListener.updateRuntimeState({});
        }
        emitBroadcast(runtime);
        return jsonResponse({
          ok: true,
          config: cfgStore.toPublicAgentVoiceConfig(updated),
          agent: runtime.piAgent ? runtime.piAgent.snapshot() : null,
          voice: runtime.voiceListener ? runtime.voiceListener.snapshot() : null,
        });
      }

      if (method === "GET" && pathname === "/api/voice-listen/state") {
        if (!runtime.voiceListener) {
          throw new HttpError(503, "语音监听服务未初始化");
        }
        return jsonResponse({
          ok: true,
          voice: runtime.voiceListener.snapshot(),
        });
      }

      if (method === "POST" && pathname === "/api/voice-listen/state") {
        if (!runtime.voiceListener) {
          throw new HttpError(503, "语音监听服务未初始化");
        }
        const body = await readJsonBody(req);
        const validModes = new Set(["idle", "listening", "awake", "processing", "speaking", "error"]);
        const validEngines = new Set(["browser", "whisper", "manual"]);
        const patch: {
          active?: boolean;
          mode?: VoiceListenMode;
          engine?: "browser" | "whisper" | "manual";
          interimTranscript?: string;
          error?: string | null;
        } = {};
        if (typeof body.active === "boolean") patch.active = body.active;
        if (typeof body.mode === "string" && validModes.has(body.mode)) {
          patch.mode = body.mode as VoiceListenMode;
        }
        if (typeof body.engine === "string" && validEngines.has(body.engine)) {
          patch.engine = body.engine as "browser" | "whisper" | "manual";
        }
        if (typeof body.interimTranscript === "string") {
          patch.interimTranscript = body.interimTranscript;
        }
        if (body.error === null || typeof body.error === "string") {
          patch.error = body.error;
        }
        const voice = runtime.voiceListener.updateRuntimeState(patch);
        return jsonResponse({ ok: true, voice });
      }

      if (method === "POST" && pathname === "/api/voice-listen/transcript") {
        if (!runtime.voiceListener) {
          throw new HttpError(503, "语音监听服务未初始化");
        }
        const body = await readJsonBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        const isFinal = body.isFinal !== false;
        const bypassWakeWord = body.bypassWakeWord === true;
        const engine =
          body.engine === "whisper" || body.engine === "manual" ? body.engine : "browser";
        const result = await runtime.voiceListener.handleTranscript(text, {
          isFinal,
          bypassWakeWord,
          engine,
        });
        return jsonResponse({
          ...result,
          agent: runtime.piAgent ? runtime.piAgent.snapshot() : null,
        });
      }

      if (method === "POST" && pathname === "/api/voice-listen/transcribe") {
        if (!runtime.voiceListener) {
          throw new HttpError(503, "语音监听服务未初始化");
        }
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("multipart/form-data")) {
          throw new HttpError(400, "请使用 multipart/form-data 上传音频文件");
        }
        const form = await req.formData();
        const audio = form.get("audio") ?? form.get("file");
        if (!(audio instanceof Blob) || audio.size === 0) {
          throw new HttpError(400, "缺少有效的音频数据 audio");
        }
        const lang = typeof form.get("lang") === "string" ? String(form.get("lang")) : undefined;
        const bypassWakeWord = String(form.get("bypassWakeWord") ?? "").toLowerCase() === "true";
        const autoDispatch = String(form.get("autoDispatch") ?? "true").toLowerCase() !== "false";
        const filename = audio instanceof File && audio.name ? audio.name : "voice.webm";

        let transcript: string;
        try {
          transcript = await runtime.voiceListener.transcribeAudio(audio, { filename, lang });
        } catch (err) {
          throw new HttpError(400, sanitizeErrorMessage(err));
        }

        if (!autoDispatch) {
          return jsonResponse({
            ok: true,
            text: transcript,
            matched: false,
            wokeOnly: false,
            command: "",
            voiceState: runtime.voiceListener.snapshot(),
          });
        }

        const dispatched = await runtime.voiceListener.handleTranscript(transcript, {
          isFinal: true,
          bypassWakeWord,
          engine: "whisper",
        });
        return jsonResponse({
          ...dispatched,
          text: transcript,
          agent: runtime.piAgent ? runtime.piAgent.snapshot() : null,
        });
      }

      // ---------- 摄像头云台方向控制 ----------

      const ptzMatch = /^\/api\/camera\/([^/]+)\/ptz$/.exec(pathname);
      if (method === "POST" && ptzMatch) {
        const did = decodeSegment(ptzMatch[1]!);
        const body = await readJsonBody(req);
        const direction = body.direction;
        if (direction !== 1 && direction !== 2 && direction !== 3 && direction !== 4) {
          throw new HttpError(400, "无效的云台方向参数，仅支持 1-4");
        }
        return jsonResponse({
          ok: true,
          did,
          direction,
        });
      }

      return jsonResponse({ ok: false, error: "未找到请求的接口或资源" }, 404);
    } catch (err) {
      const status = errorStatusFor(err);
      const message = sanitizeErrorMessage(err);
      return jsonResponse({ ok: false, error: message }, status);
    }
  };
}
