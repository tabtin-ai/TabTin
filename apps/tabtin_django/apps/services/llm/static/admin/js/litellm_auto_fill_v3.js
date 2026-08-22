/**
 * LiteLLM 自动填充功能
 *
 * 功能：
 * 1. 列表页：添加"同步 LiteLLM 数据库"按钮
 * 2. 编辑页：在 model_name 字段右侧添加"获取配置"按钮
 */

(function() {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        const pathname = window.location.pathname;

        // 列表页
        if (pathname.match(/\/admin\/llm\/llmmodel\/$/) || pathname.match(/\/admin\/llm\/llmmodel\/\?/)) {
            initListPage();
        }
        // 添加/编辑页
        else if (pathname.includes('/llm/llmmodel/')) {
            initEditPage();
        }
    }

    // ==================== CSRF Token ====================

    function getCsrfToken() {
        // 从 cookie 中获取 CSRF token
        const name = 'csrftoken';
        let cookieValue = null;
        if (document.cookie && document.cookie !== '') {
            const cookies = document.cookie.split(';');
            for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i].trim();
                if (cookie.substring(0, name.length + 1) === (name + '=')) {
                    cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                    break;
                }
            }
        }
        return cookieValue;
    }

    // ==================== 列表页 ====================

    function initListPage() {
        // 在 object-tools 工具栏中添加同步按钮
        const objectTools = document.querySelector('.object-tools');

        if (!objectTools) return;

        // 创建一个 li 元素，使用 Django Admin 原生样式
        const li = document.createElement('li');

        const syncLink = document.createElement('a');
        syncLink.href = '#';
        syncLink.className = 'historylink';  // 使用 Django Admin 原生类
        syncLink.innerHTML = '同步 LiteLLM';
        syncLink.title = '将 LiteLLM 的 2000+ 模型配置同步到本地数据库';
        syncLink.onclick = function(e) {
            e.preventDefault();
            syncLiteLLMDatabase();
        };

        li.appendChild(syncLink);

        // 插入到工具栏第一个位置（在"增加"按钮之前）
        objectTools.insertBefore(li, objectTools.firstChild);
    }

    function syncLiteLLMDatabase() {
        const syncLink = event.target;
        const originalText = syncLink.innerHTML;

        if (!confirm('确认同步 LiteLLM 数据库？\n\n这将：\n1. 清除旧的缓存数据\n2. 下载最新的模型配置（2000+ 模型）\n3. 保存到本地数据库\n\n预计耗时：10-30 秒')) {
            return;
        }

        syncLink.innerHTML = '同步中...';
        syncLink.classList.add('litellm-loading');

        fetch('/api/llm-admin/sync-database/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCsrfToken()
            }
        })
        .then(response => response.json())
        .then(data => {
            syncLink.innerHTML = originalText;
            syncLink.classList.remove('litellm-loading');

            if (data.success) {
                alert(`✅ ${data.message}\n\n同步了 ${data.count} 个模型配置`);
            } else {
                alert('❌ ' + data.error);
            }
        })
        .catch(error => {
            syncLink.innerHTML = originalText;
            syncLink.classList.remove('litellm-loading');
            alert('❌ 同步失败: ' + error.message);
        });
    }

    // ==================== 编辑页 ====================

    function initEditPage() {
        const modelNameField = document.querySelector('#id_model_name');
        if (!modelNameField) return;

        createInlineButton(modelNameField);
    }

    function createInlineButton(modelNameField) {
        // 创建按钮容器（放在input右侧）
        const buttonContainer = document.createElement('span');

        // 创建"获取配置"按钮
        const fetchButton = document.createElement('button');
        fetchButton.type = 'button';
        fetchButton.className = 'button';
        fetchButton.innerHTML = '🔄 获取配置';
        fetchButton.title = '从 LiteLLM 数据库获取模型配置';
        fetchButton.onclick = function() {
            fetchModelConfig(modelNameField.value.trim());
        };

        // 创建"搜索"按钮
        const searchButton = document.createElement('button');
        searchButton.type = 'button';
        searchButton.className = 'button';
        searchButton.innerHTML = '🔍 搜索';
        searchButton.title = '搜索模型';
        searchButton.onclick = function() {
            showSearchDialog(modelNameField);
        };

        buttonContainer.appendChild(fetchButton);
        buttonContainer.appendChild(searchButton);

        // 插入到 input 后面
        modelNameField.parentNode.insertBefore(buttonContainer, modelNameField.nextSibling);
    }

    function fetchModelConfig(modelName) {
        if (!modelName) {
            alert('❌ 请先填写模型名称');
            return;
        }

        const fetchButton = event.target;
        const originalText = fetchButton.innerHTML;
        fetchButton.innerHTML = '⏳ 获取中...';
        fetchButton.disabled = true;

        fetch(`/api/llm-admin/model-info/?model_name=${encodeURIComponent(modelName)}`)
            .then(response => response.json())
            .then(data => {
                fetchButton.innerHTML = originalText;
                fetchButton.disabled = false;

                if (data.success) {
                    fillFormFields(data.data);
                    alert(`✅ ${data.message}\n\n已自动填充配置信息，请检查并保存`);
                } else {
                    alert(`❌ ${data.error}\n\n提示：\n1. 确认模型名称正确\n2. 尝试使用"搜索"功能\n3. 如确实不存在，请手动填写`);
                }
            })
            .catch(error => {
                fetchButton.innerHTML = originalText;
                fetchButton.disabled = false;
                alert('❌ 获取配置失败: ' + error.message);
            });
    }

    function fillFormFields(data) {
        const fields = [
            { id: 'id_max_tokens', value: data.max_tokens, label: '上下文窗口' },
            { id: 'id_max_input_tokens', value: data.max_input_tokens, label: '最大输入' },
            { id: 'id_max_output_tokens', value: data.max_output_tokens, label: '最大输出' },
            { id: 'id_input_price_per_1k', value: data.input_price_per_1k, label: '输入价格' },
            { id: 'id_output_price_per_1k', value: data.output_price_per_1k, label: '输出价格' }
        ];

        fields.forEach(field => {
            if (field.value !== null && field.value !== undefined) {
                setFieldValue(field.id, field.value);
            }
        });

        // 设置复选框
        if (data.supports_function_calling !== null) {
            setCheckboxValue('id_supports_function_calling', data.supports_function_calling);
        }
        if (data.supports_vision !== null) {
            setCheckboxValue('id_supports_vision', data.supports_vision);
        }

        // 设置扩展能力配置（JSON 字段）
        if (data.capabilities_config && Object.keys(data.capabilities_config).length > 0) {
            const capabilitiesField = document.getElementById('id_capabilities_config');
            if (capabilitiesField) {
                capabilitiesField.value = JSON.stringify(data.capabilities_config, null, 2);
                // 高亮效果
                capabilitiesField.classList.add('litellm-field-highlight');
                setTimeout(() => {
                    capabilitiesField.classList.remove('litellm-field-highlight');
                }, 2000);
            }
        }

        // 设置多模态限制配置（JSON 字段）
        if (data.multimodal_limits && Object.keys(data.multimodal_limits).length > 0) {
            const multimodalField = document.getElementById('id_multimodal_limits');
            if (multimodalField) {
                multimodalField.value = JSON.stringify(data.multimodal_limits, null, 2);
                // 高亮效果
                multimodalField.classList.add('litellm-field-highlight');
                setTimeout(() => {
                    multimodalField.classList.remove('litellm-field-highlight');
                }, 2000);
            }
        }
    }

    function setFieldValue(fieldId, value) {
        const field = document.getElementById(fieldId);
        if (field) {
            field.value = value;
            // 高亮效果
            field.classList.add('litellm-field-highlight');
            setTimeout(() => {
                field.classList.remove('litellm-field-highlight');
            }, 2000);
        }
    }

    function setCheckboxValue(fieldId, checked) {
        const field = document.getElementById(fieldId);
        if (field) {
            field.checked = checked;
        }
    }

    function showSearchDialog(modelNameField) {
        const keyword = prompt('🔍 搜索模型\n\n请输入关键词（如: gpt-4, claude, qwen）:');

        if (!keyword || keyword.trim() === '') return;

        // 显示加载提示
        const searchButton = event.target;
        const originalText = searchButton.innerHTML;
        searchButton.innerHTML = '⏳ 搜索中...';
        searchButton.disabled = true;

        fetch(`/api/llm-admin/search-models/?keyword=${encodeURIComponent(keyword)}`)
            .then(response => response.json())
            .then(data => {
                searchButton.innerHTML = originalText;
                searchButton.disabled = false;

                if (data.success) {
                    const models = data.data.models;
                    if (models.length === 0) {
                        alert('❌ 未找到匹配的模型');
                        return;
                    }

                    // 构建选择对话框
                    let message = `找到 ${data.data.total} 个模型（显示前 ${models.length} 个）\n\n`;
                    message += '请输入序号选择模型:\n\n';
                    models.slice(0, 20).forEach((model, index) => {
                        message += `${index + 1}. ${model}\n`;
                    });
                    if (models.length > 20) {
                        message += `\n... 还有 ${models.length - 20} 个模型`;
                    }

                    const selection = prompt(message);
                    if (selection) {
                        const index = parseInt(selection) - 1;
                        if (index >= 0 && index < models.length) {
                            modelNameField.value = models[index];
                            // 自动触发获取配置
                            setTimeout(() => {
                                fetchModelConfig(models[index]);
                            }, 300);
                        } else {
                            alert('❌ 无效的序号');
                        }
                    }
                } else {
                    alert('❌ ' + data.error);
                }
            })
            .catch(error => {
                searchButton.innerHTML = originalText;
                searchButton.disabled = false;
                alert('❌ 搜索失败: ' + error.message);
            });
    }

})();
