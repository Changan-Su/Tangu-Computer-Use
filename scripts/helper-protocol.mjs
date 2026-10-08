/**
 * macOS helper 的协议号,从源文件里读出来给各个检查用。
 *
 * 为什么不在检查里直接写数字:写死的那个数每涨一次协议就过期一次。check:blindclick / check:liveview
 * 曾写死 11、check:recorder 写死 13,协议涨上去之后 `npm run check:live` 一直红在第一步,没人发现。
 *
 * 这个号在两处各写了一遍、必须一致(UPSTREAM.md「Helper protocol version」),platform-contract.check.mjs 钉着。
 * 本文件不 import 任何平台相关的东西,非 macOS 也能加载。
 */
import { readFileSync } from 'node:fs';

function read(file, pattern) {
  const match = pattern.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  if (!match) throw new Error(`${file} 里找不到协议号(${pattern})—— 写法变了,同步改 scripts/helper-protocol.mjs`);
  return Number(match[1]);
}

/** 插件运行时认的协议号:daemon 报的数和它不等就拒绝服务(helper.ts 的 ensureProtocol)。 */
export const runtimeProtocolVersion = () => read('src/vendor/platform/macos/helper.ts', /^const HELPER_PROTOCOL_VERSION = (\d+);/m);

/** helper 源码自报的协议号:diagnostics 和 recordSubscribe 的回包里带的就是它。 */
export const nativeProtocolVersion = () => read('native/macos/bridge.swift', /^\s*private let protocolVersion = (\d+)\s*$/m);
