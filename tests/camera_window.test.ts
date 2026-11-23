// SPDX-License-Identifier: GPL-3.0-or-later
/** Persistent standalone camera windows, resize hit zones, and quality defaults. */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { IJobExecutor, IMijiaService, JobSubmitOptions } from "../src/core/contracts.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import {
  CAPTION_BUTTON_WIDTH,
  CameraWindowController,
  type ICameraPlayer,
  type ICameraSession,
  type IScheduler,
} from "../src/ui/controllers/cameraPreviewController.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";

interface QueuedJob {
  fn: () => unknown | Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class TestJobs implements IJobExecutor {
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

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

class NoopScheduler implements IScheduler {
  private _nextId = 1;
  readonly activeTimers = new Set<number>();

  setTimeout(_fn: () => void, _ms: number): unknown {
    const id = this._nextId++;
    this.activeTimers.add(id);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.activeTimers.delete(handle);
    }
  }

  setInterval(_fn: () => void, _ms: number): unknown {
    const id = this._nextId++;
    this.activeTimers.add(id);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }
}

function createStubService(): IMijiaService & {
  powerState: ReturnType<typeof mock<(did: string) => Promise<boolean | null>>>;
  prepareCameraSource: ReturnType<typeof mock<(device: DeviceInfo) => Promise<unknown>>>;
} {
  return {
    setControlAccess: mock(() => {}),
    apiVersion: mock(() => "0.0.0"),
    accountId: mock(() => "test-account"),
    logout: mock(async () => {}),
    loginStatus: mock(async () => true),
    qrLoginBegin: mock(async () => null),
    qrLoginWait: mock(async () => {}),
    listDevices: mock(async () => []),
    deviceDetail: mock(async (did: string) => ({
      did,
      name: "门口",
      model: "chuangmi.camera.029a02",
      props: [],
      actions: [],
    })),
    readProp: mock(async () => null),
    readProps: mock(async () => ({})),
    writeProp: mock(async () => {}),
    runAction: mock(async () => {}),
    powerState: mock(async () => false as boolean | null),
    togglePower: mock(async () => true),
    setPowerState: mock(async () => {}),
    powerStates: mock(async () => ({})),
    readMetrics: mock(async () => ({})),
    sceneList: mock(async () => []),
    runScene: mock(async () => {}),
    iconUrls: mock(async () => ({})),
    iconFile: mock(async () => null),
    hasProductPageName: mock(() => true),
    cachedProductPageNames: mock(() => ({})),
    productPageName: mock(async () => null),
    specHasPublishedFunctions: mock(() => true),
    localizedProductNames: mock(() => ({})),
    prepareCameraSource: mock(async () => "test-source" as unknown),
    recordDeviceObservation: mock(() => {}),
    deviceDiagnosticReport: mock(async () => ""),
  };
}

describe("CameraWindow", () => {
  let jobs: TestJobs;
  let scheduler: NoopScheduler;
  let device: DeviceInfo;
  let service: ReturnType<typeof createStubService>;
  let player: ICameraPlayer & {
    setSource: ReturnType<typeof mock<(url: string) => void>>;
    play: ReturnType<typeof mock<() => void>>;
    stop: ReturnType<typeof mock<() => void>>;
  };
  let win: CameraWindowController;

  beforeEach(() => {
    jobs = new TestJobs();
    scheduler = new NoopScheduler();
    device = createDeviceInfo({
      did: "test-camera",
      name: "门口",
      home_name: "测试家",
      room_name: "玄关",
      model: "chuangmi.camera.029a02",
      online: true,
    });
    service = createStubService();
    player = {
      setSource: mock(() => {}),
      play: mock(() => {}),
      stop: mock(() => {}),
    };
    win = new CameraWindowController(service, jobs, device, {
      player,
      scheduler,
    });
    win.show();
  });

  afterEach(() => {
    win.close();
  });

  test("non-modal window stays open when leaving or deactivating", () => {
    expect(win.overlay).toBe(false);
    expect(win.modal).toBe(false);

    win.onLeave();
    win.onDeactivate();
    expect(win.visible).toBe(true);
    expect(win.closed).toBe(false);
  });

  test("window title '门口 - 玄关' and 16:9 aspect canvas stays inside window across resizes (650,430) & (980,650)", () => {
    expect(win.title).toBe("门口 - 玄关");
    expect([win.bodyMargins.left, win.bodyMargins.right]).toEqual([20, 20]);

    for (const [width, height] of [
      [650, 430],
      [980, 650],
    ] as const) {
      win.resize(width, height);
      expect(win.geometry.width).toBe(width);
      expect(win.geometry.height).toBe(height);

      const canvasRect = win.computeCanvasRect();
      const bodyWidth = width - 2 - win.bodyMargins.left - win.bodyMargins.right;
      const bodyHeight =
        height - 2 - win.captionHeight - win.bodyMargins.top - win.bodyMargins.bottom - 72;

      expect(canvasRect.x).toBeGreaterThanOrEqual(0);
      expect(canvasRect.y).toBeGreaterThanOrEqual(0);
      expect(canvasRect.x + canvasRect.width).toBeLessThanOrEqual(bodyWidth);
      expect(canvasRect.y + canvasRect.height).toBeLessThanOrEqual(bodyHeight);
      expect(canvasRect.width).toBeGreaterThan(0);
      expect(canvasRect.height).toBeGreaterThan(0);
      expect(Math.abs(canvasRect.width / canvasRect.height - 16 / 9)).toBeLessThanOrEqual(0.02);
    }
  });

  test("caption controls have width 46 and support maximize/restore/minimize/close", () => {
    expect(win.captionButtonWidth).toBe(46);
    expect(CAPTION_BUTTON_WIDTH).toBe(46);

    const originalGeometry = win.geometry;

    win.toggleMaximized();
    expect(win.maximized).toBe(true);
    expect(win.geometry).toEqual(win.screenAvailableGeometry);

    win.toggleMaximized();
    expect(win.maximized).toBe(false);
    expect(win.geometry).toEqual(originalGeometry);

    win.showMinimized();
    expect(win.minimized).toBe(true);

    win.showNormal();
    expect(win.minimized).toBe(false);
    expect(win.visible).toBe(true);

    win.close();
    expect(win.visible).toBe(false);
    expect(win.closed).toBe(true);
  });

  test("native resize edges (13, 17) and title drag (2) exclude power button (1)", () => {
    expect(win.hitTest(1, 1)).toBe(13);
    expect(win.hitTest(win.geometry.width - 1, win.geometry.height - 1)).toBe(17);
    expect(win.hitTest(60, 30)).toBe(2);
    expect(win.hitTest(60, 30, { overButton: true })).toBe(1);
  });

  test("minimize, restore, and resize keep the same session and generation without stopping player or re-authorizing", () => {
    const camera = win.camera;
    const session: ICameraSession & {
      command: ReturnType<typeof mock<() => boolean>>;
      stop: ReturnType<typeof mock<() => void>>;
    } = {
      cancelled: false,
      start: mock(() => "rtsp://127.0.0.1:1/test"),
      command: mock(() => true),
      stop: mock(() => {}),
    };
    camera.attachSession(session, {
      playing: true,
      attempted: true,
      loaded: true,
      powerState: true,
    });
    const generation = camera.generation;

    for (let i = 0; i < 2; i += 1) {
      win.showMinimized();
      expect(camera.session).toBe(session);

      win.showNormal();
      win.resize(850, 580);
      expect(camera.session).toBe(session);
      expect(camera.generation).toBe(generation);
      expect(camera.attempted).toBe(true);
    }

    expect(session.stop).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.setSource).not.toHaveBeenCalled();
    expect(service.prepareCameraSource).not.toHaveBeenCalled();
    expect(jobs.pending.some((job) => job.fn.name === "prepare")).toBe(false);
  });

  test("closing minimized window releases session and stops polling", () => {
    win.load();
    const camera = win.camera;
    expect(camera.pollActive).toBe(true);

    const session: ICameraSession & { stop: ReturnType<typeof mock<() => void>> } = {
      cancelled: false,
      start: mock(() => "rtsp://127.0.0.1:1/test"),
      command: mock(() => true),
      stop: mock(() => {}),
    };
    camera.attachSession(session);

    win.showMinimized();
    expect(win.minimized).toBe(true);
    expect(camera.session).toBe(session);

    win.close();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(camera.session).toBeNull();
    expect(camera.pollActive).toBe(false);
  });

  test("minimize during connection keeps pending authorization alive", async () => {
    const session: ICameraSession & {
      cancelled: boolean;
      stop: ReturnType<typeof mock<() => void>>;
    } = {
      cancelled: false,
      start: mock(() => "rtsp://127.0.0.1:1/test"),
      command: mock(() => true),
      stop: mock(() => {
        session.cancelled = true;
      }),
    };
    const pendingWin = new CameraWindowController(service, jobs, device, {
      sessionFactory: () => session,
      player,
      scheduler,
    });
    pendingWin.show();

    try {
      const camera = pendingWin.camera;
      camera.start();
      const prepareJob = jobs.pending[jobs.pending.length - 1]!;
      const generation = camera.generation;

      pendingWin.showMinimized();
      expect(await prepareJob.fn()).toBe("test-source");
      expect(camera.generation).toBe(generation);
      expect(session.stop).not.toHaveBeenCalled();

      pendingWin.showNormal();
      expect(camera.session).toBe(session);
    } finally {
      pendingWin.close();
    }
  });

  test("quality menu has [0, 1, 2] and fresh window always defaults to quality 1 (never persisted)", () => {
    const camera = win.camera;
    expect(camera.quality).toBe(1);

    const menu = camera.buildQualityMenu();
    expect(menu.map((item) => item.value)).toEqual([0, 1, 2]);
    expect(menu[1]!.checked).toBe(true);

    const session: ICameraSession = {
      cancelled: false,
      start: mock(() => "rtsp://127.0.0.1:1/test"),
      command: mock(() => true),
      stop: mock(() => {}),
    };
    camera.attachSession(session);
    camera.selectQuality(2);
    expect(camera.quality).toBe(2);

    const other = new CameraWindowController(service, jobs, device, { scheduler });
    try {
      expect(other.camera.quality).toBe(1);
    } finally {
      other.close();
    }
  });

  test("MainWindowController opening same camera reuses non-modal window and explicit close removes it and triggers refreshClosedDetail", () => {
    const main = new MainWindowController({
      service,
      jobs,
      tray: null,
      autoStartTimers: false,
    });
    const refreshSpy = spyOn(main, "refreshClosedDetail");

    try {
      const first = main.openCameraWindow(device);
      expect(main.cameraWindows.get(device.did)).toBe(first);

      const second = main.openCameraWindow(device);
      expect(second).toBe(first);
      expect(main.cameraWindows.get(device.did)).toBe(first);
      expect(first.modal).toBe(false);

      first.reject();
      expect(main.cameraWindows.has(device.did)).toBe(false);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledWith(device.did);
    } finally {
      main.dispose();
    }
  });
});
