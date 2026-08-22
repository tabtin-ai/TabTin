# Elasticsearch 8.x 本地开发镜像（内置 analysis-icu 插件）
#
# 用途：TabTin 统一搜索引擎（apps/fts）本地开发基础设施。
# 与生产保持一致：生产使用阿里云 Elasticsearch 8.x 托管服务。
# ICU 插件是 PRD 4.5 的中文分词基础，必须预装。
FROM docker.elastic.co/elasticsearch/elasticsearch:8.13.4

# analysis-icu：基于 ICU 的 tokenizer + 分词过滤器，是 tabtin_text_* 分析器的基础。
# 本地一次构建，避免首次启动再下载（网络不稳情况更稳定）。
RUN bin/elasticsearch-plugin install --batch analysis-icu
