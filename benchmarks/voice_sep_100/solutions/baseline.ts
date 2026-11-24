// SPDX-License-Identifier: GPL-3.0-or-later
// Baseline: 现有 HEAD 8c473bf 语音管线（GTCRN -> Silero VAD -> openWakeWord -> 双轨 SenseVoice -> voiceAttentionGate）

import { evaluateVoiceAttention } from "../../../src/agent/voiceAttentionGate.ts";
import type { SoundTypeLabel } from "../generate_dataset.ts";
import type { SolutionRunInput, SolutionRunOutput, VoiceSolution } from "../evaluator.ts";
import type { SharedVoiceModelPool } from "../shared_models.ts";

export function createBaselineSolution(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "baseline_8c473bf",
    name: "Baseline (MijiaDeck HEAD 8c473bf)",
    description:
      "现有生产管线基线：单级 GTCRN 降噪 -> Silero VAD -> openWakeWord 句首打分 -> 双轨 SenseVoice ASR -> 确定性 DDSD 注意力门控（无声源分离、无并行场景分类、无说话人分离）。",

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const engine = pool.localEngine;
      const { clip, pcm16k, wakeWords } = input;

      // 1. GTCRN Denoise
      const den = engine.denoise(pcm16k, 16000, "auto");

      // 2. Silero VAD
      const vad = engine.detectSpeechSegments(den.samples, 16000, { mode: "silero" });
      if (!vad.hasSpeech || vad.speechSamples.length < 1600) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: ["noise"],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "vad-skip",
          attentionReason: "Silero VAD 未检测到有效语音",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs: { denoiseMs: den.durationMs, vadMs: vad.durationMs },
        };
      }

      // 3. openWakeWord head scoring
      let acousticWake = engine.scoreWakeWordAudio(vad.speechSamples, wakeWords, {
        threshold: 0.6,
        headOnlySec: 2.0,
      });
      if (!acousticWake || !acousticWake.matched) {
        const rawHit = engine.scoreWakeWordAudio(pcm16k, wakeWords, {
          threshold: 0.6,
          headOnlySec: 2.0,
        });
        if (rawHit && (!acousticWake || rawHit.score > acousticWake.score)) {
          acousticWake = rawHit;
        }
      }

      // 4. Dual-track SenseVoice ASR
      const sv = await engine.transcribeDualTrack(pcm16k, vad.speechSamples, {
        voiceLang: "zh-CN",
        wakeWords,
        inputSnrDb: den.inputSnrDb,
        acousticWake,
      });

      // 5. Voice attention gate (using clip's dialog state / recent history / echo context)
      const now = 1_764_000_000_000;
      const decision = await evaluateVoiceAttention({
        rawText: sv.text,
        altText: sv.altText,
        wakeWordEnabled: true,
        wakeWords,
        attentionMode: "smart",
        dialogState: clip.dialogState,
        inConversation: clip.dialogState === "conversation",
        recentTurns: clip.recentHistory.map((h, idx) => ({
          role: h.role,
          text: h.text,
          timestamp: now - (clip.recentHistory.length - idx) * 2000,
        })),
        lastSpokenReply: clip.lastSpokenReply,
        lastSpokenAt: clip.lastSpokenReply ? now - 1200 : undefined,
        now,
        acousticEvent: sv.event,
        acousticWake,
        owwActiveForWord: engine.openWakeWord.isReady,
      });

      const soundTypes: SoundTypeLabel[] = ["speech"];
      if (sv.event.toUpperCase().includes("BGM")) {
        soundTypes.push("bgm");
      }

      return {
        isNeoCommand: decision.accept,
        wokeOnly: decision.wokeOnly,
        command: decision.command,
        rawTranscript: sv.text,
        detectedSoundTypes: soundTypes,
        detectedSpeakerCount: 1,
        separatedStreams: [
          {
            streamId: "mixed_denoised",
            kind: "speech",
            transcript: sv.text,
          },
        ],
        attentionStage: decision.stage,
        attentionReason: decision.reason,
        latencyMs: Math.round(performance.now() - t0),
        stageTimingsMs: {
          denoiseMs: den.durationMs,
          vadMs: vad.durationMs,
          asrMs: sv.durationMs,
          attentionMs: decision.latencyMs,
        },
      };
    },
  };
}
