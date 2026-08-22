"""
Runtime Registry / 运行时任务台账

本文件是 TabTin Runtime / Celery / Beat / Worker / Queue 的统一维护台账。

维护目的：
1. 说明每个 Queue 是做什么的。
2. 说明每个 Worker 消费哪些 Queue。
3. 说明每个 Celery Task 做什么、由谁触发、进入哪个 Queue、哪个 Worker 消费。
4. 说明每个 Beat 定时任务多久执行一次、是不是主链路、是不是兜底。
5. 防止 realtime task 悄悄落到 default。
6. 防止 RAG / TabData / DocMerge 悄悄落到 heavy。
7. 为 settings.py、worker 脚本、AdminDash、运维文档提供统一事实源。

QUEUE_REGISTRY 字段说明：
- display_name：队列中文名称。
- description：队列用途说明。
- domain：业务域，例如 channel_gateway、rag、tabdata、tabdoc、fts。
- priority：优先级，例如 p0、p1、p1_5、p2。
- allow_backlog：是否允许积压。
- expected_workers：预期消费该队列的 Worker。
- latency_target_seconds：目标延迟，单位秒。
- notes：维护备注，必须说明禁止混入的任务类型。

WORKER_REGISTRY 字段说明：
- display_name：Worker 中文名称。
- queues：Worker 消费的队列列表。
- command：标准启动命令。
- concurrency_default：默认并发。
- concurrency_env：控制并发的环境变量。
- prefetch_multiplier：Celery prefetch 参数。
- notes：维护备注，必须说明该 Worker 不能消费哪些任务。

TASK_REGISTRY 字段说明：
- display_name：任务中文名称。
- description：任务用途说明。
- trigger：触发方式，例如 transaction_on_commit、beat、manual、signal、api。
- queue：任务投递队列。
- worker：消费该任务的 Worker。
- args：任务参数。
- idempotency_key：幂等 key。
- time_limit_seconds：hard time limit，单位秒。
- max_retries：最大重试次数。
- failure_record：失败记录位置。
- feature_flag：控制新链路的功能开关。
- notes：维护备注，必须说明风险、幂等、禁止事项。

BEAT_REGISTRY 字段说明：
- display_name：定时任务中文名称。
- task：Beat 触发的 Celery task。
- schedule_seconds：固定间隔秒数。
- crontab：crontab 配置，和 schedule_seconds 二选一。
- queue：Beat 投递队列。
- role：Beat 角色，只能是 main_path、fallback_sweep、retry、recovery、cleanup、archive、stats、report、health_probe、polling。
- is_main_path：是否业务主链路。
- expires_seconds：任务过期时间，避免 Beat 堆积。
- notes：维护备注，必须说明该 Beat 是否允许作为主链路。

维护规则：
1. 新增 queue 必须登记 QUEUE_REGISTRY。
2. 新增 worker 必须登记 WORKER_REGISTRY。
3. 新增重要 task 必须登记 TASK_REGISTRY。
4. 新增 Beat 必须登记 BEAT_REGISTRY。
5. realtime task 不允许进 default。
6. RAG / Embedding 不允许进 heavy。
7. TabData compute 不允许进 heavy。
8. DocMerge 不允许进 heavy。
9. cleanup 不允许进 realtime_delivery / critical。
10. 高频 Beat 不允许作为实时主链路。
11. 未登记但落 default 的 task 必须进入 LEGACY_DEFAULT_QUEUE_ALLOWLIST。
12. 未登记但落 heavy 的 task 必须进入 LEGACY_HEAVY_QUEUE_ALLOWLIST。
"""

from __future__ import annotations


QUEUE_REGISTRY = {
    "critical": {
        "display_name": "关键业务队列",
        "description": "负责 billing、payment、wallet、membership、sms 等关键短任务。",
        "domain": "core",
        "priority": "p0",
        "allow_backlog": False,
        "expected_workers": ["worker-critical"],
        "latency_target_seconds": 5,
        "notes": "不允许混入 media、docparse、cleanup、RAG 重任务。",
    },
    "default": {
        "display_name": "默认轻量任务队列",
        "description": "负责普通轻量后台任务和已登记 legacy 任务。",
        "domain": "general",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-default"],
        "latency_target_seconds": 60,
        "notes": "不允许 realtime delivery、RAG、TabData compute、DocMerge、media/docparse 重任务进入。",
    },
    "realtime_delivery": {
        "display_name": "实时消息投递队列",
        "description": "负责 Channel Gateway 出站投递、入站 polling、失败重试。",
        "domain": "channel_gateway",
        "priority": "p0",
        "allow_backlog": False,
        "expected_workers": ["worker-realtime"],
        "latency_target_seconds": 3,
        "notes": "从 default 拆出。实时-ish 链路，不允许 cleanup、RAG、media、docparse 混入。",
    },
    "search_indexing": {
        "display_name": "搜索索引队列",
        "description": "负责 FTS Outbox、ES indexing、search health probe。",
        "domain": "fts",
        "priority": "p1",
        "allow_backlog": True,
        "expected_workers": ["worker-search"],
        "latency_target_seconds": 30,
        "notes": "保留现有 FTS 专用队列。",
    },
    "rag_indexing": {
        "display_name": "RAG / Embedding 队列",
        "description": "负责 RAG embedding、table indexing、document embedding。",
        "domain": "rag",
        "priority": "p1",
        "allow_backlog": True,
        "expected_workers": ["worker-data-ai"],
        "latency_target_seconds": 60,
        "notes": "从 heavy 拆出，避免被 media/docparse/OSS 重任务拖慢。",
    },
    "doc_merge": {
        "display_name": "文档合并队列",
        "description": "负责 TabDoc DocUpdate 合并和文档快照更新。",
        "domain": "tabdoc",
        "priority": "p1",
        "allow_backlog": True,
        "expected_workers": ["worker-data-ai"],
        "latency_target_seconds": 15,
        "notes": "从 30s 全局 Beat 扫描改为 per-doc debounce + queue。",
    },
    "heavy": {
        "display_name": "重任务队列",
        "description": "负责仍未拆分的重任务、低并发长耗时任务。",
        "domain": "heavy",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-heavy"],
        "latency_target_seconds": 300,
        "notes": "不再承载 RAG、TabData compute、DocMerge 主链路；P0 起 Memory LLM 改走 ai_background。",
    },
    "media": {
        "display_name": "媒体生成队列",
        "description": "负责图片、视频、音频等媒体生成任务。",
        "domain": "media",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-heavy"],
        "latency_target_seconds": 300,
        "notes": "可以暂时由 worker-heavy 消费，未来压力大再单独拆 worker-media。",
    },
    "docparse": {
        "display_name": "文档解析队列",
        "description": "负责文档解析、OCR、文件转换、OSS heavy 文件处理。",
        "domain": "docparse",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-heavy"],
        "latency_target_seconds": 300,
        "notes": "可以暂时由 worker-heavy 消费，未来压力大再单独拆 worker-docparse。",
    },
    "tabdata_conversion": {
        "display_name": "TabData 字段转换队列",
        "description": "负责 TabData 字段类型转换。",
        "domain": "tabdata",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-heavy"],
        "latency_target_seconds": 300,
        "notes": "保留现有队列，由 worker-heavy 顺带消费。",
    },
    "pptx_import_oss": {
        "display_name": "PPTX OSS 导入队列",
        "description": "负责从临时 OSS 对象下载并导入 PPTX。",
        "domain": "tabslide",
        "priority": "p1",
        "allow_backlog": True,
        "expected_workers": ["worker-heavy"],
        "latency_target_seconds": 300,
        "notes": "滚动发布隔离队列；旧 worker 禁止消费，新 worker-heavy 上线后消费。",
    },
    "tracker_agent": {
        "display_name": "Tracker / Agent 调度队列",
        "description": "负责 Tracker / Agent scheduler 执行。",
        "domain": "tracker_agent",
        "priority": "p1",
        "allow_backlog": True,
        "expected_workers": ["worker-tracker"],
        "latency_target_seconds": 60,
        "notes": "保留现有 tracker_agent 隔离。",
    },
    "ai_background": {
        "display_name": "AI 后台处理队列",
        "description": "负责 Memory 抽取/压缩、任务摘要、日记蒸馏等非实时 LLM 后台任务。",
        "domain": "ai_background",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-ai-background"],
        "latency_target_seconds": 300,
        "notes": "P0 从 heavy 隔离；禁止混入文件 IO/docparse/media；禁止复用 tracker_agent。",
    },
    "low_priority": {
        "display_name": "低优先级队列",
        "description": "负责 cleanup、archive、report 等低优先级任务。",
        "domain": "maintenance",
        "priority": "p2",
        "allow_backlog": True,
        "expected_workers": ["worker-default"],
        "latency_target_seconds": 600,
        "notes": "创业公司版暂由 worker-default 消费，后续压力大再拆 worker-low。",
    },
}


WORKER_REGISTRY = {
    "worker-critical": {
        "display_name": "关键业务 Worker",
        "queues": ["critical"],
        "command": "celery -A tabtin worker -Q critical -c ${CELERY_CRITICAL_CONCURRENCY:-2} -n critical@%h",
        "concurrency_default": 2,
        "concurrency_env": "CELERY_CRITICAL_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "只消费 critical，不允许混入 heavy/media/docparse/cleanup。",
    },
    "worker-default": {
        "display_name": "默认轻量 Worker",
        "queues": ["default", "low_priority"],
        "command": "celery -A tabtin worker -Q default,low_priority -c ${CELERY_DEFAULT_CONCURRENCY:-4} -n default@%h",
        "concurrency_default": 4,
        "concurrency_env": "CELERY_DEFAULT_CONCURRENCY",
        "prefetch_multiplier": 4,
        "notes": "负责普通轻量任务和低优先级任务；不允许 realtime、RAG、TabData compute、DocMerge、media/docparse。",
    },
    "worker-realtime": {
        "display_name": "实时投递 Worker",
        "queues": ["realtime_delivery"],
        "command": "celery -A tabtin worker -Q realtime_delivery -c ${CELERY_REALTIME_CONCURRENCY:-4} -n realtime@%h --prefetch-multiplier=1",
        "concurrency_default": 4,
        "concurrency_env": "CELERY_REALTIME_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "负责 Channel Gateway 实时投递、polling、retry。禁止消费 default/heavy/media/docparse。",
    },
    "worker-search": {
        "display_name": "搜索索引 Worker",
        "queues": ["search_indexing"],
        "command": "celery -A tabtin worker -Q search_indexing -c ${CELERY_FTS_CONCURRENCY:-4} -n fts@%h",
        "concurrency_default": 4,
        "concurrency_env": "CELERY_FTS_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "保留现有 FTS worker。",
    },
    "worker-data-ai": {
        "display_name": "数据与 AI Worker",
        "queues": ["rag_indexing", "doc_merge"],
        "command": "celery -A tabtin worker -Q rag_indexing,doc_merge -c ${CELERY_DATA_AI_CONCURRENCY:-4} -n data_ai@%h --prefetch-multiplier=1",
        "concurrency_default": 4,
        "concurrency_env": "CELERY_DATA_AI_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "创业公司版合并承载 RAG、DocMerge；未来可拆成独立 worker。",
    },
    "worker-heavy": {
        "display_name": "重任务 Worker",
        "queues": ["heavy", "media", "docparse", "tabdata_conversion", "pptx_import_oss"],
        "command": "celery -A tabtin worker -Q heavy,media,docparse,tabdata_conversion,pptx_import_oss -c ${CELERY_HEAVY_CONCURRENCY:-1} -n heavy@%h --prefetch-multiplier=${CELERY_HEAVY_PREFETCH_MULTIPLIER:-1} --soft-time-limit=${CELERY_HEAVY_SOFT_TIME_LIMIT:-900} --time-limit=${CELERY_HEAVY_TIME_LIMIT:-960}",
        "concurrency_default": 1,
        "concurrency_env": "CELERY_HEAVY_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "负责 media/docparse/文件转换等重任务；Test 环境默认单副本/单并发/prefetch=1。进程回收阈值由部署环境变量提供，不能替代 PDF 页级子进程隔离。",
    },
    "worker-tracker": {
        "display_name": "Tracker / Agent Worker",
        "queues": ["tracker_agent"],
        "command": "celery -A tabtin worker -Q ${TRACKER_AGENT_QUEUE:-tracker_agent} -c ${CELERY_TRACKER_CONCURRENCY:-2} -n scheduler@%h",
        "concurrency_default": 2,
        "concurrency_env": "CELERY_TRACKER_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "保留现有 tracker / agent scheduler 隔离。",
    },
    "worker-ai-background": {
        "display_name": "AI 后台 Worker",
        "queues": ["ai_background"],
        "command": "celery -A tabtin worker -Q ai_background -c ${CELERY_AI_BACKGROUND_CONCURRENCY:-1} -n ai_background@%h --prefetch-multiplier=${CELERY_AI_BACKGROUND_PREFETCH_MULTIPLIER:-1}",
        "concurrency_default": 1,
        "concurrency_env": "CELERY_AI_BACKGROUND_CONCURRENCY",
        "prefetch_multiplier": 1,
        "notes": "P0 隔离 Memory/摘要/日记 LLM；concurrency=1 + prefetch=1，避免 session 级并发与超时占坑扩散到 heavy。",
    },
}


TASK_REGISTRY = {
    "tabslide.import_pptx_oss_task": {
        "display_name": "从 OSS 导入 PPTX",
        "description": "下载 API 暂存的 PPTX 对象并创建 TabSlide 项目。",
        "trigger": "api",
        "queue": "pptx_import_oss",
        "worker": "worker-heavy",
        "args": [
            "object_key",
            "organization_id",
            "space_id",
            "file_name",
            "user_id",
            "agent_run_id",
            "collection_id",
        ],
        "idempotency_key": None,
        "time_limit_seconds": 600,
        "max_retries": 0,
        "failure_record": "Redis import_pptx:{task_id}",
        "feature_flag": None,
        "notes": "仅接受服务端生成的 temp-parse/tabslide-import UUID 对象键；finally 主动清理，OSS lifecycle 兜底。",
    },
    "channel_gateway.deliver_one_outbox": {
        "display_name": "单条渠道消息投递",
        "description": "根据 outbox_id 投递一条 ChannelOutboundMessageRecord。",
        "trigger": "transaction_on_commit",
        "queue": "realtime_delivery",
        "worker": "worker-realtime",
        "args": ["outbox_id"],
        "idempotency_key": "ChannelOutboundMessageRecord.id",
        "time_limit_seconds": 120,
        "max_retries": 3,
        "failure_record": "ChannelOutboundMessageRecord.last_error + FailedTaskRecord",
        "feature_flag": "CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED",
        "notes": "实时消息主链路。重复执行必须 no-op 或按状态幂等处理。",
    },
    "channel_gateway.deliver_outbox_sweep": {
        "display_name": "渠道消息兜底扫描",
        "description": "扫描 missed pending / stale sending 的 ChannelOutboundMessageRecord。",
        "trigger": "beat",
        "queue": "realtime_delivery",
        "worker": "worker-realtime",
        "args": ["limit"],
        "idempotency_key": "ChannelOutboundMessageRecord.id",
        "time_limit_seconds": 120,
        "max_retries": 0,
        "failure_record": "FailedTaskRecord + ChannelOutboundMessageRecord.last_error",
        "feature_flag": "CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED",
        "notes": "只允许兜底，不允许作为唯一实时投递入口。",
    },
    "channel_gateway.retry_channel_outbox": {
        "display_name": "渠道失败消息重试",
        "description": "重试 failed_retryable 的渠道出站消息。",
        "trigger": "beat",
        "queue": "realtime_delivery",
        "worker": "worker-realtime",
        "args": [],
        "idempotency_key": "ChannelOutboundMessageRecord.id",
        "time_limit_seconds": 120,
        "max_retries": 0,
        "failure_record": "FailedTaskRecord + ChannelOutboundMessageRecord.last_error",
        "feature_flag": None,
        "notes": "保留为 retry 类 Beat。",
    },
    "channel_gateway.channel_poll": {
        "display_name": "外部渠道入站轮询",
        "description": "轮询支持 polling 的外部渠道入站消息。",
        "trigger": "beat",
        "queue": "realtime_delivery",
        "worker": "worker-realtime",
        "args": [],
        "idempotency_key": "provider_message_id",
        "time_limit_seconds": 120,
        "max_retries": 0,
        "failure_record": "FailedTaskRecord",
        "feature_flag": None,
        "notes": "如果 provider 只支持 polling，可以保留；但不能继续跑 default。",
    },
    "tabdoc.merge_doc_for_document": {
        "display_name": "单文档更新合并",
        "description": "根据 document_id 合并 DocUpdate 并更新 Document snapshot。",
        "trigger": "debounce",
        "queue": "doc_merge",
        "worker": "worker-data-ai",
        "args": ["document_id"],
        "idempotency_key": "document_id",
        "time_limit_seconds": 180,
        "max_retries": 1,
        "failure_record": "FailedTaskRecord",
        "feature_flag": "TABDOC_DEBOUNCE_MERGE_ENABLED",
        "notes": "per-doc debounce 后触发，替代 30s 全局主扫描。",
    },
    "tabdoc.merge_doc_updates_sweep": {
        "display_name": "文档合并兜底扫描",
        "description": "兜底扫描漏处理或 stale 的 DocUpdate。",
        "trigger": "beat",
        "queue": "doc_merge",
        "worker": "worker-data-ai",
        "args": ["limit"],
        "idempotency_key": "document_id",
        "time_limit_seconds": 180,
        "max_retries": 0,
        "failure_record": "FailedTaskRecord",
        "feature_flag": "TABDOC_DEBOUNCE_MERGE_ENABLED",
        "notes": "只做兜底，不能继续作为文档更新主链路。",
    },
    "tabdoc.index_document_embedding": {
        "display_name": "文档 Embedding 索引",
        "description": "文档快照更新后生成或刷新 DocumentEmbedding。",
        "trigger": "event",
        "queue": "rag_indexing",
        "worker": "worker-data-ai",
        "args": ["document_id"],
        "idempotency_key": "document_id + version",
        "time_limit_seconds": 900,
        "max_retries": 3,
        "failure_record": "EmbeddingTask + FailedTaskRecord",
        "feature_flag": "RAG_DEDICATED_QUEUE_ENABLED",
        "notes": "从 heavy 拆到 rag_indexing。",
    },
    "rag.index_table_task": {
        "display_name": "表格结构 RAG 索引",
        "description": "索引 Table / TableField 到 RAG。",
        "trigger": "on_commit/manual",
        "queue": "rag_indexing",
        "worker": "worker-data-ai",
        "args": ["table_id"],
        "idempotency_key": "table_id",
        "time_limit_seconds": 900,
        "max_retries": 3,
        "failure_record": "EmbeddingTask + FailedTaskRecord",
        "feature_flag": "RAG_DEDICATED_QUEUE_ENABLED",
        "notes": "从 heavy 拆出。",
    },
    "rag.index_table_records_task": {
        "display_name": "表格记录批量 RAG 索引",
        "description": "批量索引表格记录到 RAG。",
        "trigger": "manual/service",
        "queue": "rag_indexing",
        "worker": "worker-data-ai",
        "args": ["table_id", "record_ids"],
        "idempotency_key": "table_id + record_ids",
        "time_limit_seconds": 1800,
        "max_retries": 3,
        "failure_record": "EmbeddingTask + FailedTaskRecord",
        "feature_flag": "RAG_DEDICATED_QUEUE_ENABLED",
        "notes": "长耗时任务，从 heavy 拆出。",
    },
    "rag.embed_record_task": {
        "display_name": "单条记录 Embedding",
        "description": "对单条记录生成 embedding。",
        "trigger": "event/debounce",
        "queue": "rag_indexing",
        "worker": "worker-data-ai",
        "args": ["record_id"],
        "idempotency_key": "record_id + version",
        "time_limit_seconds": 900,
        "max_retries": 3,
        "failure_record": "EmbeddingTask + FailedTaskRecord",
        "feature_flag": "RAG_DEDICATED_QUEUE_ENABLED",
        "notes": "从 heavy 拆出。",
    },
    "rag.flush_record_batch": {
        "display_name": "记录批量 Embedding Flush",
        "description": "批量 flush debounce 后的记录 embedding。",
        "trigger": "debounce/beat",
        "queue": "rag_indexing",
        "worker": "worker-data-ai",
        "args": ["table_id"],
        "idempotency_key": "table_id + batch_window",
        "time_limit_seconds": 900,
        "max_retries": 3,
        "failure_record": "EmbeddingTask + FailedTaskRecord",
        "feature_flag": "RAG_DEDICATED_QUEUE_ENABLED",
        "notes": "从 heavy 拆出。",
    },
    "apps.fts.tasks.flush_outbox_task": {
        "display_name": "FTS Outbox Flush",
        "description": "业务更新后 on_commit 触发 FTS outbox flush。",
        "trigger": "transaction_on_commit",
        "queue": "search_indexing",
        "worker": "worker-search",
        "args": ["db"],
        "idempotency_key": "FTSOutbox.id",
        "time_limit_seconds": 300,
        "max_retries": 3,
        "failure_record": "FTSOutbox.last_error + FailedTaskRecord",
        "feature_flag": None,
        "notes": "保留现有事件驱动主链路。",
    },
    "apps.fts.tasks.scan_outbox_tick": {
        "display_name": "FTS Outbox 兜底扫描",
        "description": "兜底扫描 FTS pending outbox。",
        "trigger": "beat",
        "queue": "search_indexing",
        "worker": "worker-search",
        "args": [],
        "idempotency_key": "FTSOutbox.id",
        "time_limit_seconds": 300,
        "max_retries": 0,
        "failure_record": "FTSOutbox.last_error + FailedTaskRecord",
        "feature_flag": None,
        "notes": "保留为兜底扫描，不是主链路。",
    },
    "apps.fts.tasks.health_probe_task": {
        "display_name": "FTS 健康探测",
        "description": "探测搜索索引链路健康。",
        "trigger": "beat",
        "queue": "search_indexing",
        "worker": "worker-search",
        "args": [],
        "idempotency_key": None,
        "time_limit_seconds": 30,
        "max_retries": 0,
        "failure_record": "FailedTaskRecord",
        "feature_flag": None,
        "notes": "健康探测任务。",
    },
}


BEAT_REGISTRY = {
    "channel-gateway-channel-poll": {
        "display_name": "外部渠道入站轮询",
        "task": "channel_gateway.channel_poll",
        "schedule_seconds": 3,
        "crontab": None,
        "queue": "realtime_delivery",
        "role": "polling",
        "is_main_path": True,
        "expires_seconds": 2,
        "notes": "仅 provider 不支持 push 时允许保留 polling 主链路；必须从 default 移到 realtime_delivery。",
    },
    "channel-gateway-deliver-outbox-sweep": {
        "display_name": "渠道消息兜底扫描",
        "task": "channel_gateway.deliver_outbox_sweep",
        "schedule_seconds": 60,
        "crontab": None,
        "queue": "realtime_delivery",
        "role": "fallback_sweep",
        "is_main_path": False,
        "expires_seconds": 55,
        "notes": "不能再作为实时投递主链路。",
    },
    "channel-gateway-retry-outbox": {
        "display_name": "渠道失败消息重试",
        "task": "channel_gateway.retry_channel_outbox",
        "schedule_seconds": 60,
        "crontab": None,
        "queue": "realtime_delivery",
        "role": "retry",
        "is_main_path": False,
        "expires_seconds": 55,
        "notes": "保留重试兜底。",
    },
    "tabdoc-merge-doc-updates-sweep": {
        "display_name": "文档合并兜底扫描",
        "task": "tabdoc.merge_doc_updates_sweep",
        "schedule_seconds": 120,
        "crontab": None,
        "queue": "doc_merge",
        "role": "fallback_sweep",
        "is_main_path": False,
        "expires_seconds": 100,
        "notes": "替代旧 30s 全局主扫描。",
    },
    "fts-scan-outbox": {
        "display_name": "FTS Outbox 兜底扫描",
        "task": "apps.fts.tasks.scan_outbox_tick",
        "schedule_seconds": 5,
        "crontab": None,
        "queue": "search_indexing",
        "role": "fallback_sweep",
        "is_main_path": False,
        "expires_seconds": 4,
        "notes": "FTS 主链路已有 on_commit flush，该 Beat 保留为兜底。",
    },
    "fts-health-probe": {
        "display_name": "FTS 健康探测",
        "task": "apps.fts.tasks.health_probe_task",
        "schedule_seconds": 10,
        "crontab": None,
        "queue": "search_indexing",
        "role": "health_probe",
        "is_main_path": False,
        "expires_seconds": 9,
        "notes": "健康探测任务。",
    },
}


LEGACY_DEFAULT_QUEUE_ALLOWLIST = {}
LEGACY_HEAVY_QUEUE_ALLOWLIST = {}

RUNTIME_ROUTE_PATTERNS = {
    "channel_gateway.deliver_outbox": {"queue": "realtime_delivery"},
    "channel_gateway.deliver_one_outbox": {"queue": "realtime_delivery"},
    "channel_gateway.deliver_outbox_sweep": {"queue": "realtime_delivery"},
    "channel_gateway.retry_channel_outbox": {"queue": "realtime_delivery"},
    "channel_gateway.channel_poll": {"queue": "realtime_delivery"},
    "tabdoc.merge_doc_for_document": {"queue": "doc_merge"},
    "tabdoc.merge_doc_updates": {"queue": "doc_merge"},
    "tabdoc.merge_doc_updates_sweep": {"queue": "doc_merge"},
    "tabdoc.index_document_embedding": {"queue": "rag_indexing"},
    "rag.*": {"queue": "rag_indexing"},
    "apps.fts.tasks.*": {"queue": "search_indexing"},
}


RUNTIME_FEATURE_FLAGS = {
    "RUNTIME_REFACTOR_ENABLED": False,
    "CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED": False,
    "TABDOC_DEBOUNCE_MERGE_ENABLED": False,
    "RAG_DEDICATED_QUEUE_ENABLED": False,
    "WS_RUNTIME_SNAPSHOT_ENABLED": False,
    "WS_EVENT_SAMPLE_ENABLED": False,
    "CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED": False,
    "COLLAB_RUNTIME_SNAPSHOT_ENABLED": False,
    "COLLAB_EVENT_SAMPLE_ENABLED": False,
}


def build_registry_task_routes() -> dict[str, dict[str, str]]:
    """从台账生成重点 task route，并附加需要通配保护的域级 route。"""
    routes = {task_key: {"queue": spec["queue"]} for task_key, spec in TASK_REGISTRY.items()}
    routes.update(RUNTIME_ROUTE_PATTERNS)
    return routes
