/** Computer Use fields rendered by the desktop settings page. */
import type { PluginSettingsSchema } from '@forsion/tangu-agent';
import { JEV_API_URL, DEFAULT_THRESHOLD } from './jev.ts';

export const SETTINGS: PluginSettingsSchema = {
  fields: [
    { key: 'cursor_overlay', type: 'toggle', label: '操作可视化', labelEn: 'Show what the agent is doing', default: true, help: 'macOS 上把 Agent 的动作画出来：指针动作画一个点击穿透的示意光标（不移动系统指针），并给正在被操控的窗口加一圈边缘光效。都不吃鼠标事件、不抢焦点。', helpEn: 'On macOS, draw the agent\'s actions: a click-through cursor for pointer actions (the real pointer never moves) and a glowing edge around the window being controlled. Both are click-through and never take focus.' },
    { key: 'browser_use', type: 'toggle', label: '浏览器工具', labelEn: 'Browser tools', default: true, help: '允许 launch / navigate / evaluate_browser（操作 CDP 浏览器页）。', helpEn: 'Allow launch/navigate/evaluate_browser (CDP browser pages).' },
    { key: 'managed_browser', type: 'select', label: '受管浏览器', labelEn: 'Managed browser', default: 'chrome', options: [{ value: 'chrome', label: 'Chrome' }, { value: 'helium', label: 'Helium' }], help: 'launch_browser 启动哪个浏览器建立 CDP 上下文。', helpEn: 'Which browser launch_browser starts for its CDP context.' },
    { key: 'compact_browser_controls', type: 'toggle', label: '简短截图点击（实验）', labelEn: 'Compact screenshot clicks (experimental)', default: false, help: '浏览器截图提供短句柄，模型可直接点击全图或局部图中的坐标。', helpEn: 'Give the model a short handle to click a point in a full browser screenshot or detail.' },
    { key: 'browser_panel_zoom', type: 'toggle', label: '浏览器面板放大（实验）', labelEn: 'Browser panel zoom (experimental)', default: false, help: '启用简短截图点击，并让模型先查看工具栏或面板，再放大其中的小控件。', helpEn: 'Enable compact screenshot clicks and let the model inspect a panel before focusing on a smaller control.' },
    { key: 'jev_enabled', type: 'toggle', label: 'Jev 实验加速（macOS）', labelEn: 'Jev experimental acceleration (macOS)', default: false, help: '开启后可用 jev_ui 连续定位并操作。目标窗口的元素信息会发送到下方配置的服务；自动或视觉模式还会发送截图。使用 Jev 1.14，低置信度时停止。请在下方填写 API 地址和密钥。', helpEn: 'Enables jev_ui for short sequences. Target-window element information is sent to the configured service; auto and vision modes can also send screenshots. Uses Jev 1.14 and stops on low confidence. Enter the API URL and key below.' },
    { key: 'jev_api_url', type: 'text', label: 'Jev API 地址', labelEn: 'Jev API URL', default: JEV_API_URL, placeholder: JEV_API_URL },
    { key: 'jev_api_key', type: 'text', secret: true, label: 'Jev API 密钥', labelEn: 'Jev API key', default: '', placeholder: 'TypeSafe API key' },
    { key: 'jev_mode', type: 'select', label: 'Jev 定位方式', labelEn: 'Jev targeting mode', default: 'auto', options: [{ value: 'auto', label: '自动：元素优先，视觉补充', labelEn: 'Auto: elements, then vision' }, { value: 'elements', label: '仅元素选择（不发截图）', labelEn: 'Elements only (no screenshots)' }, { value: 'vision', label: '仅视觉 Box', labelEn: 'Visual Box only' }] },
    { key: 'jev_threshold', type: 'number', label: `Jev 最低置信度（0.5–0.99，默认 ${DEFAULT_THRESHOLD}）`, labelEn: `Jev minimum confidence (0.5–0.99, default ${DEFAULT_THRESHOLD})`, default: DEFAULT_THRESHOLD, min: 0.5, max: 0.99, help: 'Jev 有多确定目标就在画面上，才去点。调低会更少中途停下来；点错了由每步结果确认兜住（那一步至少按 0.8 判，确认错了会在错的画面上接着做）。框贴不贴合只挡明显的坏框。', helpEn: 'How sure Jev must be that the target is on screen before clicking. Lower values stop less often; a wrong click is caught by the per-step result check, which never goes below 0.8 (a false confirmation would carry on on the wrong screen). Box fit only filters obviously broken boxes.' },
  ],
};
