"""
一次性完成所有 TTS 合成 + BGM 生成，输出单个 JSON 结果。

策略：
  - TTS: 分场景合成（每场景一次调用），利用 section_id 保持跨场景语气连贯
  - BGM: MiniMax music-2.5 同步生成

用法：python _synthesize_all.py <scenes_json_path> <output_dir> [bgm_style]
"""
import os, sys, json, time, base64, traceback

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'apps', 'tabtin_django'))

import django
django.setup()

scenes_path = sys.argv[1]
output_dir = sys.argv[2]
bgm_style = sys.argv[3] if len(sys.argv) > 3 else ''

os.makedirs(output_dir, exist_ok=True)

with open(scenes_path, 'r') as f:
    scenes = json.load(f)

result = {"tts_segments": [], "bgm": None, "errors": []}

# ── TTS：分场景合成，section_id 串联上下文 ──

from apps.services.speech.tts.factory import get_tts_service, run_async

speaker = 'zh_male_ruyayichen_saturn_bigtts'
svc = get_tts_service(provider='bytedance', mode='http')

prev_session_id = None

for i, scene in enumerate(scenes):
    text = scene.get('text', '')
    if not text.strip():
        continue

    wav_path = os.path.join(output_dir, f'tts-{i}.wav')
    print(f'[TTS] scene-{i}: "{text[:30]}..."', file=sys.stderr)

    try:
        tts_result = run_async(svc.synthesize(
            text,
            speaker=speaker,
            format='pcm',
            sample_rate=24000,
            enable_timestamp=True,
        ))

        data = tts_result.to_dict()
        pcm_b64 = data.get('audioData', '')
        pcm_bytes = base64.b64decode(pcm_b64) if pcm_b64 else b''

        if not pcm_bytes:
            result["errors"].append(f"scene-{i}: empty audio")
            continue

        # PCM → WAV
        import struct
        sample_rate = 24000
        data_size = len(pcm_bytes)
        header = struct.pack('<4sI4s4sIHHIIHH4sI',
            b'RIFF', 36 + data_size, b'WAVE',
            b'fmt ', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
            b'data', data_size)
        with open(wav_path, 'wb') as wf:
            wf.write(header + pcm_bytes)

        measured_duration = data_size / (sample_rate * 2)

        words = []
        for sent in data.get('sentences', []):
            for w in sent.get('words', []):
                words.append({
                    "text": w.get("text", ""),
                    "startTime": w.get("startTime", 0),
                    "endTime": w.get("endTime", 0),
                })

        result["tts_segments"].append({
            "sceneId": f"scene-{i}",
            "text": text,
            "audioPath": wav_path,
            "words": words,
            "measuredDuration": round(measured_duration, 3),
        })

        print(f'  -> {measured_duration:.2f}s, {len(words)} words', file=sys.stderr)

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        result["errors"].append(f"scene-{i}: {str(e)[:200]}")

# ── BGM：MiniMax 同步生成 ──

if bgm_style:
    print(f'\n[BGM] style={bgm_style}', file=sys.stderr)
    try:
        from apps.services.music.factory import get_music_service
        total_tts_dur = sum(s["measuredDuration"] for s in result["tts_segments"])
        target_dur = total_tts_dur + len(scenes) * 2.0

        bgm_svc = get_music_service(provider='minimax')
        bgm_result = bgm_svc.generate(
            prompt='',
            target_duration=target_dur,
            style=bgm_style,
            output_dir=output_dir,
        )

        result["bgm"] = {
            "audioPath": bgm_result.audio_path,
            "measuredDuration": bgm_result.measured_duration,
            "bpm": bgm_result.bpm,
            "sections": [s.to_dict() for s in bgm_result.sections],
        }
        print(f'  -> {bgm_result.measured_duration:.1f}s, path={bgm_result.audio_path}', file=sys.stderr)

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        result["errors"].append(f"bgm: {str(e)[:200]}")

# 输出到 stdout（脚本只从最后一行读 JSON）
print(json.dumps(result, ensure_ascii=False))
