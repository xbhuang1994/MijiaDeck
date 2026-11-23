// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 右下角小爱语音悬浮球、打字机占位提示与轻量 Toast 布局控制器。
 * 精确 1:1 移植自 app/ui/voice_fab.py、app/ui/typewriter.py 与 app/ui/toast.py。
 */

import { type Rect, TypedEmitter } from "../../core/contracts.ts";

export interface HostSize {
  width: number;
  height: number;
}

// 面板与球的观感尺寸：球为圆形，面板高度含上下留白恰好包住输入行
export const BALL_SIZE = 64;
export const PANEL_W = 368;
export const PANEL_H = 62;
export const GAP = 14;
export const MARGIN = 20;
export const BOTTOM_MARGIN = 20;
export const SHADOW_PAD = 22;
export const BOTTOM_RESERVED_HEIGHT = 40;
export const HINT_FULL = "对小爱同学下指令，如“打开卧室灯”，回车执行";

export const TYPE_INTERVAL_MS = 80;
export const HOLD_BEFORE_REPLAY_MS = 1800;

function unrefTimer(handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    const maybe = handle as { unref?: () => void };
    maybe.unref?.();
  }
}

// ----------------------------------------------------------------------------
// 打字机占位提示控制器（自 app/ui/typewriter.py）
// ----------------------------------------------------------------------------

export interface TypewriterOptions {
  isVisible?: () => boolean;
  onPlaceholderChange?: (placeholder: string) => void;
  typeIntervalMs?: number;
  holdBeforeReplayMs?: number;
}

export type TypewriterEvents = {
  placeholderChanged: [string];
};

export class TypewriterController extends TypedEmitter<TypewriterEvents> {
  readonly fullText: string;
  readonly typeIntervalMs: number;
  readonly holdBeforeReplayMs: number;
  placeholder: string = "";

  private _pos: number = 0;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _replayTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _isVisible: () => boolean;
  private readonly _onPlaceholderChange?: (placeholder: string) => void;

  constructor(text: string = HINT_FULL, options: TypewriterOptions = {}) {
    super();
    this.fullText = text;
    this.typeIntervalMs = options.typeIntervalMs ?? TYPE_INTERVAL_MS;
    this.holdBeforeReplayMs = options.holdBeforeReplayMs ?? HOLD_BEFORE_REPLAY_MS;
    this._isVisible = options.isVisible ?? (() => true);
    this._onPlaceholderChange = options.onPlaceholderChange;
  }

  start(): void {
    this._clearTimers();
    this._pos = 0;
    this._setPlaceholder("");
    const timer = setInterval(() => this.tick(), this.typeIntervalMs);
    unrefTimer(timer);
    this._tickTimer = timer;
  }

  stop(clear = false): void {
    this._clearTimers();
    if (clear) {
      this._setPlaceholder("");
    }
  }

  isActive(): boolean {
    return this._tickTimer !== null;
  }

  tick(): void {
    this._pos += 1;
    if (this._pos >= this.fullText.length) {
      this._setPlaceholder(this.fullText);
      this._pos = 0;
      if (this._tickTimer !== null) {
        clearInterval(this._tickTimer);
        this._tickTimer = null;
      }
      const timer = setTimeout(() => {
        this._replayTimer = null;
        this.replay();
      }, this.holdBeforeReplayMs);
      unrefTimer(timer);
      this._replayTimer = timer;
      return;
    }
    this._setPlaceholder(this.fullText.slice(0, this._pos));
  }

  replay(): void {
    if (this._isVisible()) {
      this.start();
    }
  }

  dispose(): void {
    this.stop(false);
  }

  private _clearTimers(): void {
    if (this._tickTimer !== null) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._replayTimer !== null) {
      clearTimeout(this._replayTimer);
      this._replayTimer = null;
    }
  }

  private _setPlaceholder(text: string): void {
    this.placeholder = text;
    this._onPlaceholderChange?.(text);
    this.emit("placeholderChanged", text);
  }
}

// ----------------------------------------------------------------------------
// 语音悬浮球控制器（自 app/ui/voice_fab.py）
// ----------------------------------------------------------------------------

export interface VoiceFabState {
  visible: boolean;
  expanded: boolean;
  reveal: number;
  inputText: string;
  placeholder: string;
  panelVisible: boolean;
  hostSize: HostSize;
  containerRect: Rect;
  ballRect: Rect;
  panelRect: Rect;
  ballLocalRect: Rect;
  panelLocalRect: Rect;
}

export type VoiceFabEvents = {
  submitted: [string];
  changed: [VoiceFabState];
};

export class VoiceFabController extends TypedEmitter<VoiceFabEvents> {
  visible: boolean = false;
  expanded: boolean = false;
  reveal: number = 0;
  inputText: string = "";
  panelVisible: boolean = false;
  hostSize: HostSize;
  containerRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  ballRect: Rect = { x: 0, y: 0, width: BALL_SIZE, height: BALL_SIZE };
  panelRect: Rect = { x: 0, y: 0, width: 0, height: PANEL_H };
  ballLocalRect: Rect = { x: 0, y: 0, width: BALL_SIZE, height: BALL_SIZE };
  panelLocalRect: Rect = { x: 0, y: 0, width: 0, height: PANEL_H };

  readonly typewriter: TypewriterController;

  constructor(hostSize: HostSize = { width: 1160, height: 740 }) {
    super();
    this.hostSize = { width: hostSize.width, height: hostSize.height };
    this.typewriter = new TypewriterController(HINT_FULL, {
      isVisible: () => this.visible && this.expanded && this.panelVisible,
      onPlaceholderChange: () => {
        this.emit("changed", this.snapshot());
      },
    });
    this._applyGeometry();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.typewriter.stop(false);
    }
    this.emit("changed", this.snapshot());
  }

  toggle(): void {
    if (this.expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  expand(): void {
    this.expanded = true;
    this.inputText = "";
    this.setReveal(1.0);
    this.typewriter.start();
  }

  collapse(): void {
    this.expanded = false;
    this.typewriter.stop(true);
    this.inputText = "";
    this.setReveal(0.0);
  }

  setInputText(text: string): void {
    this.inputText = text;
    this.emit("changed", this.snapshot());
  }

  setReveal(value: number): void {
    const clamped = Math.max(0, Math.min(1, Number(value)));
    this.reveal = Number.isFinite(clamped) ? clamped : 0;
    this._applyGeometry();
    this.emit("changed", this.snapshot());
  }

  reposition(hostSize: HostSize): void {
    this.hostSize = { width: hostSize.width, height: hostSize.height };
    this._applyGeometry();
    this.emit("changed", this.snapshot());
  }

  submit(rawText?: string): boolean {
    const source = rawText !== undefined ? rawText : this.inputText;
    const text = source.trim();
    if (!text) {
      return false;
    }
    this.collapse();
    this.emit("submitted", text);
    return true;
  }

  handleEscape(): boolean {
    if (!this.expanded) {
      return false;
    }
    this.collapse();
    return true;
  }

  dispose(): void {
    this.typewriter.dispose();
  }

  snapshot(): VoiceFabState {
    return {
      visible: this.visible,
      expanded: this.expanded,
      reveal: this.reveal,
      inputText: this.inputText,
      placeholder: this.typewriter.placeholder,
      panelVisible: this.panelVisible,
      hostSize: { ...this.hostSize },
      containerRect: { ...this.containerRect },
      ballRect: { ...this.ballRect },
      panelRect: { ...this.panelRect },
      ballLocalRect: { ...this.ballLocalRect },
      panelLocalRect: { ...this.panelLocalRect },
    };
  }

  private _applyGeometry(): void {
    const hostW = this.hostSize.width;
    const hostH = this.hostSize.height;
    const available = Math.max(0, hostW - 2 * MARGIN - BALL_SIZE - GAP);
    const panelWidth = Math.round(Math.min(PANEL_W, available) * this.reveal);
    const gap = panelWidth > 0 ? GAP : 0;
    const w = BALL_SIZE + panelWidth + gap + 2 * SHADOW_PAD;
    const h = BALL_SIZE + 2 * SHADOW_PAD;

    const containerX = hostW - MARGIN - w + SHADOW_PAD;
    const containerY = hostH - BOTTOM_RESERVED_HEIGHT - BOTTOM_MARGIN - h + SHADOW_PAD;

    const ballLocalX = w - SHADOW_PAD - BALL_SIZE;
    const ballLocalY = h - SHADOW_PAD - BALL_SIZE;
    const panelLocalX = SHADOW_PAD;
    const panelLocalY = SHADOW_PAD + Math.floor((BALL_SIZE - PANEL_H) / 2);

    this.containerRect = { x: containerX, y: containerY, width: w, height: h };
    this.ballLocalRect = { x: ballLocalX, y: ballLocalY, width: BALL_SIZE, height: BALL_SIZE };
    this.panelLocalRect = { x: panelLocalX, y: panelLocalY, width: panelWidth, height: PANEL_H };

    this.ballRect = {
      x: containerX + ballLocalX,
      y: containerY + ballLocalY,
      width: BALL_SIZE,
      height: BALL_SIZE,
    };
    this.panelRect = {
      x: Math.max(0, containerX + panelLocalX),
      y: containerY + panelLocalY,
      width: panelWidth,
      height: PANEL_H,
    };
    this.panelVisible = panelWidth > 0;
  }
}

// ----------------------------------------------------------------------------
// Toast 布局控制器（自 app/ui/toast.py）
// ----------------------------------------------------------------------------

export interface ToastFabAnchor {
  visible: boolean;
  ballRect: Rect;
}

export interface ToastState {
  visible: boolean;
  text: string;
  textWidth: number;
  rect: Rect;
}

export type ToastLayoutEvents = {
  changed: [ToastState | null];
};

const TOAST_MIN_WIDTH = 80;
const TOAST_MAX_WIDTH = 420;
const TOAST_H_PAD = 38;
const TOAST_V_PAD = 24;
const TOAST_LINE_HEIGHT = 20;

export function computeToastRect(
  hostSize: HostSize,
  textWidth: number,
  fabState?: ToastFabAnchor | null,
  toastHeight?: number,
): Rect {
  const besideFab = Boolean(fabState && fabState.visible);
  const maximum = besideFab
    ? Math.max(TOAST_MIN_WIDTH, Math.min(TOAST_MAX_WIDTH, fabState!.ballRect.x - GAP - MARGIN))
    : Math.max(TOAST_MIN_WIDTH, Math.min(TOAST_MAX_WIDTH, hostSize.width - 40));

  const natural = Math.ceil(Math.max(0, textWidth)) + TOAST_H_PAD;
  const width = Math.min(maximum, Math.max(TOAST_MIN_WIDTH, natural));
  const innerWidth = Math.max(1, width - TOAST_H_PAD);
  const lines = Math.max(1, Math.ceil(Math.max(1, textWidth) / innerWidth));
  const height = toastHeight ?? TOAST_V_PAD + lines * TOAST_LINE_HEIGHT;

  if (besideFab && fabState) {
    const x = Math.max(16, fabState.ballRect.x - GAP - width);
    const y = Math.max(16, fabState.ballRect.y + Math.floor((fabState.ballRect.height - height) / 2));
    return { x, y, width, height };
  }

  const bottom = fabState !== undefined && fabState !== null ? BOTTOM_RESERVED_HEIGHT : 0;
  const x = Math.max(16, hostSize.width - width - MARGIN);
  const y = Math.max(16, hostSize.height - bottom - height - 16);
  return { x, y, width, height };
}

export class ToastLayoutController extends TypedEmitter<ToastLayoutEvents> {
  current: ToastState | null = null;
  private _hideTimer: ReturnType<typeof setTimeout> | null = null;
  private _toastHeight?: number;

  computeToastRect(
    hostSize: HostSize,
    textWidth: number,
    fabState?: ToastFabAnchor | null,
    toastHeight?: number,
  ): Rect {
    return computeToastRect(hostSize, textWidth, fabState, toastHeight);
  }

  show(
    text: string,
    hostSize: HostSize,
    options: {
      textWidth?: number;
      fabState?: ToastFabAnchor | null;
      durationMs?: number;
      toastHeight?: number;
    } = {},
  ): ToastState {
    this._clearTimer();
    const textWidth = options.textWidth ?? text.length * 14;
    this._toastHeight = options.toastHeight;
    const rect = this.computeToastRect(hostSize, textWidth, options.fabState, options.toastHeight);
    this.current = {
      visible: true,
      text,
      textWidth,
      rect,
    };
    this.emit("changed", this.snapshot());

    const durationMs = options.durationMs ?? 4000;
    if (durationMs > 0) {
      const timer = setTimeout(() => {
        this._hideTimer = null;
        this.dismiss();
      }, durationMs);
      unrefTimer(timer);
      this._hideTimer = timer;
    }
    return this.current;
  }

  reposition(hostSize: HostSize, fabState?: ToastFabAnchor | null): Rect | null {
    if (!this.current || !this.current.visible) {
      return null;
    }
    const rect = this.computeToastRect(
      hostSize,
      this.current.textWidth,
      fabState,
      this._toastHeight,
    );
    this.current = {
      ...this.current,
      rect,
    };
    this.emit("changed", this.snapshot());
    return rect;
  }

  dismiss(): void {
    this._clearTimer();
    if (this.current === null) return;
    this.current = null;
    this.emit("changed", null);
  }

  snapshot(): ToastState | null {
    return this.current ? { ...this.current, rect: { ...this.current.rect } } : null;
  }

  private _clearTimer(): void {
    if (this._hideTimer !== null) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  }
}
