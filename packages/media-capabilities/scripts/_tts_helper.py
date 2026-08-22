"""TTS helper — 直接调用 Django service 层合成语音，输出 JSON"""
import os, sys, json

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'apps', 'tabtin_django'))

import django
django.setup()

from apps.services.speech.tts.factory import get_tts_service, run_async

text = sys.argv[1]
output_path = sys.argv[2]
speaker = sys.argv[3] if len(sys.argv) > 3 else 'zh_male_ruyayichen_saturn_bigtts'

svc = get_tts_service(provider='bytedance', mode='http')
result = run_async(svc.synthesize(
    text,
    speaker=speaker,
    format='pcm',
    sample_rate=24000,
    enable_timestamp=True,
))

data = result.to_dict()
print(json.dumps(data, ensure_ascii=False))
