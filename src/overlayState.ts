/**
 * 屏上叠层(示意光标、点击环、边缘光)随每条 act / actBatch 带给 helper 的可选字段(helper 协议 20,Forsion patch)。
 * 字段的意思见 native/macos/agent_overlay_model.swift 的 OverlayActOptions;老 helper 不认识的字段一律忽略。
 */

/** PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL=0:点击照旧立刻投递、不等示意光标飞到(「先到再点」的负对照,
 *  照 PI_COMPUTER_USE_WEB_FLUSH 的先例;也是哪天等待惹出问题时的退路)。缺省 true。 */
export function clickAfterArrival(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL !== '0';
}

/** 每条 act(actBatch 是每一步)要并进请求的字段。 */
export function overlayActExtras(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return { clickAfterArrival: clickAfterArrival(env) };
}
