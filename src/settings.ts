/** 设置项(→ 桌面「设置 → 插件」现成表单;值经 syncSettings 注入 vendor activeConfig)。 */
import type { PluginSettingsSchema } from '@forsion/tangu-agent';

export const SETTINGS: PluginSettingsSchema = {
  fields: [
    { key: 'browser_use', type: 'toggle', label: '浏览器工具', labelEn: 'Browser tools', default: true, help: '允许 launch/navigate/evaluate_browser(操作 CDP 浏览器页)。', helpEn: 'Allow launch/navigate/evaluate_browser (CDP browser pages).' },
    { key: 'headless', type: 'toggle', label: '严格后台(绝不抢前台)', labelEn: 'Strict background (never take foreground)', default: false, help: '开启后动作只走后台(AX/定向输入),绝不抢前台焦点或移动光标;后台做不到的操作(部分网页/Electron 输入框)会直接报失败而非夺取前台。关闭时:先试后台,仅在必要时升级到前台,并在结果里明示。', helpEn: 'Actions use only the background path (AX / targeted input) and never grab foreground focus or move the cursor; anything the background cannot do (some web/Electron inputs) fails instead of stealing the foreground. When off: background is tried first and the foreground is only used when required — and the result says so.' },
    { key: 'cursor_overlay', type: 'toggle', label: '操作可视化', labelEn: 'Show what the agent is doing', default: true, help: 'macOS 上把 agent 的动作画出来:指针动作画一个点击穿透的示意光标(不移动系统指针),并给正在被操控的窗口加一圈边缘光效。都不吃鼠标事件、不抢焦点。', helpEn: 'On macOS, draw the agent\'s actions: a click-through cursor for pointer actions (the real pointer never moves) and a glowing edge around the window being controlled. Both are click-through and never take focus.' },
    { key: 'managed_browser', type: 'select', label: '受管浏览器', labelEn: 'Managed browser', default: 'chrome', options: [{ value: 'chrome', label: 'Chrome' }, { value: 'helium', label: 'Helium' }], help: 'launch_browser 启动哪个浏览器建立 CDP 上下文。', helpEn: 'Which browser launch_browser starts for its CDP context.' },
  ],
};
