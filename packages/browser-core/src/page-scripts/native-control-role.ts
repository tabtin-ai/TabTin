/**
 * 原生表单控件角色推导（页面内执行）。
 *
 * SoM 采集与 ref 语义重定位必须注入同一份规则，避免 observe 生成的指纹
 * 在 selector 失效后无法按相同 role 找回元素。
 */
export const NATIVE_CONTROL_ROLE_HELPERS_SNIPPET = `
  function __tabtinNativeControlRole(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag !== 'input') return '';
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    return 'textbox';
  }
`;
