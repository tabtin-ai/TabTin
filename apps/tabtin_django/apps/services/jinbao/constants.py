"""进宝固定身份常量。

JINBAO_USER_ID 是一个固定的 UUID-shape 标识，永远代表「进宝」。
P0-2 修正：原 'jb01' 后缀非 hex，仓内多处 `uuid.UUID(user_id)` 会抛错；
改用纯 hex 后缀 'ba001'（ba = "bot a"）。
"""

# 纯 hex 全小写 UUID 形状，保证 uuid.UUID(JINBAO_USER_ID) 可解析。
JINBAO_USER_ID = '00000000-0000-0000-0000-0000000ba001'
JINBAO_EMAIL = 'jinbao@tabtin.bot'

# nickname 显式标注 Echo Bot，避免用户在「私信」tab 看到一个陌生「进宝」困惑（review 反馈）。
JINBAO_NICKNAME = '进宝 · Echo Bot'

# bio 明确「不是 AI Agent」，防止产品概念混淆（review 反馈）。
JINBAO_BIO = (
    '我是进宝，dev 环境用的 Echo 机器人——给我发什么我都回什么（加 🔁 前缀）。'
    '我不是 AI Agent，没有在线状态，仅用于验证 IM 通道。'
)
JINBAO_AVATAR = ''

# 回声内容前缀，调试友好——人能一眼区分「我发的」vs「进宝回的」。
ECHO_PREFIX = '🔁 '

# 回声「思考」时长（Celery 任务内 sleep）。
ECHO_THINK_SECONDS = 1.2
