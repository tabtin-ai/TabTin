"""
Gunicorn配置文件（遗留 WSGI，仅供历史参考）

注意：WS-first 需要 ASGI（Daphne/Uvicorn），此配置不支持 WebSocket。

R5-21 修复（Prometheus multi-process）：
    生产 multi-worker 部署必须设 env `PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus_multiproc`
    （或同 K8s ConfigMap 注入），由本配置的 `when_ready` / `child_exit` 钩子
    管理 worker 文件生命周期，让 `apps.services.common.ws.metrics.metrics_view`
    通过 MultiProcessCollector 正确聚合。
"""

import multiprocessing
import os
import shutil

# ✅ Gevent monkey patch（必须在最开始）
def post_fork(server, worker):
    """Worker 启动后的回调"""
    # 在每个 worker 进程中应用 gevent monkey patch
    from gevent import monkey
    monkey.patch_all()
    server.log.info(f"Worker {worker.pid} 已启动（gevent patched）")

# 基本配置
bind = "0.0.0.0:6060"
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = "gevent"  # 遗留配置（SSE 场景），WS 不可用
worker_connections = 1000
max_requests = 5000  # ✅ 增加到 5000，减少 worker 重启频率
max_requests_jitter = 100
timeout = 120
keepalive = 2

# 日志配置
accesslog = "/www/wwwroot/tabtin/logs/gunicorn_access.log"
errorlog = "/www/wwwroot/tabtin/logs/gunicorn_error.log"
loglevel = "info"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)s'

# 进程配置
preload_app = False  # ✅ 改为 False，避免 gevent 与 logging 冲突
daemon = False
pidfile = "/www/wwwroot/tabtin/logs/gunicorn.pid"
user = "www"
group = "www"

# 性能优化
worker_tmp_dir = "/dev/shm"

# 安全配置
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

def when_ready(server):
    """master 进程就绪回调。

    R5-21 修复：清理上轮残留的 prometheus_multiproc/*.db 并重建目录，
    确保 worker fork 后写入的指标 db 是新一代实例的，不会与上次部署
    的脏数据混合。
    """
    multiproc_dir = os.environ.get('PROMETHEUS_MULTIPROC_DIR', '').strip()
    if multiproc_dir:
        try:
            if os.path.exists(multiproc_dir):
                shutil.rmtree(multiproc_dir)
            os.makedirs(multiproc_dir, exist_ok=True)
            server.log.info(
                f"[Prom multiproc] cleaned + recreated {multiproc_dir}"
            )
        except OSError as exc:
            server.log.error(
                f"[Prom multiproc] init {multiproc_dir} failed: {exc}; "
                f"metrics may be incomplete"
            )
    server.log.info("Gunicorn服务器已准备就绪")

def worker_int(worker):
    worker.log.info("Worker收到中断信号")

def pre_fork(server, worker):
    server.log.info(f"Worker {worker.pid} 即将启动")

def worker_abort(worker):
    worker.log.info(f"Worker {worker.pid} 被终止")

def child_exit(server, worker):
    """Worker 退出时清理它的 prometheus 指标文件。

    R5-21 修复：worker 死亡后必须 mark_process_dead，否则它的 db file
    会被 MultiProcessCollector 当作"还活着"持续聚合 → 数据漂移。
    livesum 模式下尤其严重（活跃连接数会"虚高"）。
    """
    if not os.environ.get('PROMETHEUS_MULTIPROC_DIR'):
        return
    try:
        from prometheus_client import multiprocess
        multiprocess.mark_process_dead(worker.pid)
        server.log.info(f"[Prom multiproc] mark_process_dead pid={worker.pid}")
    except Exception as exc:
        server.log.error(
            f"[Prom multiproc] mark_process_dead pid={worker.pid} failed: {exc}"
        )
