/** 设置项(→ 桌面「设置 → 插件」现成表单;值经 syncSettings 注入 vendor activeConfig)。 */
import type { PluginSettingsSchema } from '@forsion/tangu-agent';
import { JEV_API_URL } from './jev.ts';

export const SETTINGS: PluginSettingsSchema = {
  fields: [
    { key: 'jev_enabled', type: 'toggle', label: 'Jev 实验加速（macOS）', labelEn: 'Jev experimental acceleration (macOS)', default: false, help: '开启后可用 jev_ui 连续定位并操作。目标窗口的元素信息会发送到下方配置的服务；自动或视觉模式还会发送截图。使用 Jev 1.14，低置信度时停止。请在下方填写 API 地址和密钥。', helpEn: 'Enables jev_ui for short sequences. Target-window element information is sent to the configured service; auto and vision modes can also send screenshots. Uses Jev 1.14 and stops on low confidence. Enter the API URL and key below.' },
    { key: 'jev_api_url', type: 'text', label: 'Jev API 地址', labelEn: 'Jev API URL', default: JEV_API_URL, placeholder: JEV_API_URL },
    { key: 'jev_api_key', type: 'text', secret: true, label: 'Jev API 密钥', labelEn: 'Jev API key', default: '', placeholder: 'TypeSafe API key' },
    { key: 'jev_mode', type: 'select', label: 'Jev 定位方式', labelEn: 'Jev targeting mode', default: 'auto', options: [{ value: 'auto', label: '自动：元素优先，视觉补充', labelEn: 'Auto: elements, then vision' }, { value: 'elements', label: '仅元素选择（不发截图）', labelEn: 'Elements only (no screenshots)' }, { value: 'vision', label: '仅视觉 Box', labelEn: 'Visual Box only' }] },
    { key: 'jev_threshold', type: 'number', label: 'Jev 最低置信度（0.5–0.99，默认 0.85）', labelEn: 'Jev minimum confidence (0.5–0.99, default 0.85)', default: 0.85, min: 0.5, max: 0.99 },
    { key: 'browser_use', type: 'toggle', label: '浏览器工具', labelEn: 'Browser tools', default: true, help: '允许 launch/navigate/evaluate_browser(操作 CDP 浏览器页)。', helpEn: 'Allow launch/navigate/evaluate_browser (CDP browser pages).' },
    { key: 'headless', type: 'toggle', label: '严格后台(绝不抢前台)', labelEn: 'Strict background (never take foreground)', default: false, help: '开启后动作只走后台(AX/定向输入),绝不抢前台焦点或移动光标;后台做不到的操作(部分网页/Electron 输入框)会直接报失败而非夺取前台。关闭时:先试后台,仅在必要时升级到前台,并在结果里明示。', helpEn: 'Actions use only the background path (AX / targeted input) and never grab foreground focus or move the cursor; anything the background cannot do (some web/Electron inputs) fails instead of stealing the foreground. When off: background is tried first and the foreground is only used when required — and the result says so.' },
    { key: 'cursor_overlay', type: 'toggle', label: '操作可视化', labelEn: 'Show what the agent is doing', default: true, help: 'macOS 上把 agent 的动作画出来:指针动作画一个点击穿透的示意光标(不移动系统指针),并给正在被操控的窗口加一圈边缘光效。都不吃鼠标事件、不抢焦点。', helpEn: 'On macOS, draw the agent\'s actions: a click-through cursor for pointer actions (the real pointer never moves) and a glowing edge around the window being controlled. Both are click-through and never take focus.' },
    { key: 'managed_browser', type: 'select', label: '受管浏览器', labelEn: 'Managed browser', default: 'chrome', options: [{ value: 'chrome', label: 'Chrome' }, { value: 'helium', label: 'Helium' }], help: 'launch_browser 启动哪个浏览器建立 CDP 上下文。', helpEn: 'Which browser launch_browser starts for its CDP context.' },
  ],
};
