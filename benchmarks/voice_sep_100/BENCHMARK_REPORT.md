# MijiaDeck 100 条嘈杂环境声源分离与语音识别评测报告

> 本报告与 [`docs/VOICE_SEPARATION_BENCHMARK_REPORT.md`](../../docs/VOICE_SEPARATION_BENCHMARK_REPORT.md) 内容同步，保留在评测目录以便就地查阅与复现。

## 一、核心验收结论

- **数据集**：[`audio/clip_001.wav` .. `audio/clip_100.wav`](./audio/)，标注见 [`manifest.json`](./manifest.json) 与 [`labels.csv`](./labels.csv)（严格 50 条 Neo 指令 / 50 条非指令，总时长 388.49s）。
- **最终选定并落地的方案**：五方案融合架构 **S_Fused** -> 生产实现 [`src/agent/audioSourceSeparator.ts`](../../src/agent/audioSourceSeparator.ts)。
- **生产全量验收指标**：
  - 严格端到端准确率：**96.0%（96/100）** —— **通过 ≥95% 达标线**
  - 路由准确率：**97.0%（97/100）**
  - 误触发（FP）：**0**（精确率 100%，FPR = 0%）
  - 5 类并行声源识别 Macro-F1：**88.17%**（较基线 41.55% 提升 +46.62 pp）
  - 延迟与实时率：**Mean 4377 ms / P50 3551 ms / P95 11231 ms / RTF 1.13**（较最优单方案 S5 快 16.5%）

## 二、全方案横向评测结果

| 方案 | 严格准确率 | 路由准确率 | FP / FN / CmdErr | 声源 Macro-F1 | 平均延迟 (ms) | P95 (ms) | RTF | ≥95% | 结果文件 |
|---|---:|---:|---|---:|---:|---:|---:|:---:|---|
| Baseline (`HEAD 8c473bf`) | 80.0% | 81.0% | 3 / 16 / 1 | 41.55% | 2449 | 3839 | 0.63 | ❌ | [`baseline_8c473bf.json`](./results/baseline_8c473bf.json) |
| S1: CED 自适应路由 | 87.0% | 87.0% | 0 / 13 / 0 | 79.98% | 4414 | 9149 | 1.14 | ❌ | [`s1_ced_adaptive_router.json`](./results/s1_ced_adaptive_router.json) |
| S2: 音乐分离优先 (Spleeter First) | 81.0% | 81.0% | 0 / 19 / 0 | 82.10% | 6085 | 9167 | 1.57 | ❌ | [`s2_music_separation_first.json`](./results/s2_music_separation_first.json) |
| S3: 说话人分离优先 (Pyannote+CAM++) | 86.0% | 87.0% | 0 / 13 / 1 | 85.78% | 7893 | 11646 | 2.03 | ❌ | [`s3_speaker_diarization_first.json`](./results/s3_speaker_diarization_first.json) |
| S4: VoxLock TSE 并行提取 | 88.0% | 90.0% | 3 / 7 / 2 | 83.88% | 9091 | 13641 | 2.34 | ❌ | [`s4_voxlock_tse_parallel.json`](./results/s4_voxlock_tse_parallel.json) |
| S5: 多流增强+双语滑窗（最优单方案） | 90.0% | 91.0% | 1 / 8 / 1 | 87.93% | 5240 | 10527 | 1.35 | ❌ | [`s5_multistream_harmonic_verifier.json`](./results/s5_multistream_harmonic_verifier.json) |
| S_Fused（融合原型） | **96.0%** | **97.0%** | **0** / 3 / 1 | **88.17%** | 4621 | 12284 | 1.19 | ✅ | [`s_fused_hybrid.json`](./results/s_fused_hybrid.json) |
| **Production（生产落地版）** | **96.0%** | **97.0%** | **0** / 3 / 1 | **88.17%** | **4377** | **11231** | **1.13** | ✅ | [`prod_audio_source_separator.json`](./results/prod_audio_source_separator.json) |

## 三、六大场景分项准确率（Production 落地版）

- `clean_no_bgm`（无背景音，14 条）：**14/14（100.0%）**，均耗 3728 ms
- `song_singing`（歌曲演唱，22 条）：**22/22（100.0%）**，均耗 4334 ms
- `instrumental_bgm`（纯乐器 BGM，16 条）：**16/16（100.0%）**，均耗 4010 ms
- `ambient_noise`（环境噪声，18 条）：**16/18（88.9%）**，均耗 4604 ms
- `multi_speaker`（多人讲话，18 条）：**16/18（88.9%）**，均耗 6673 ms
- `conversation_scenes`（多轮会话，12 条）：**12/12（100.0%）**，均耗 1916 ms

## 四、一键复现命令

```bash
# 运行生产代码 100 条音频验收评测
bun run benchmarks/voice_sep_100/run_benchmark.ts prod

# 运行指定单方案或全套评测（baseline / s1 / s2 / s3 / s4 / s5 / fused / prod）
bun run benchmarks/voice_sep_100/run_benchmark.ts baseline s1 s2 s3 s4 s5 fused prod
```

完整架构解析、5 方案优缺点剖析及生产改造细节请参阅 [`docs/VOICE_SEPARATION_BENCHMARK_REPORT.md`](../../docs/VOICE_SEPARATION_BENCHMARK_REPORT.md)。
