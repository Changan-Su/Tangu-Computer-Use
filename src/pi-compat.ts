/**
 * pi(@earendil-works/pi-coding-agent)兼容垫片。
 *
 * vendor/ 下的 pi-computer-use 源码对 pi 的耦合极小(全量 grep 核对):只有 ExtensionContext(type-only)、
 * AgentToolResult / AgentToolUpdateCallback(type-only)、getAgentDir(唯一运行时函数)。tsconfig paths +
 * esbuild alias 把 `@earendil-works/pi-coding-agent` 映射到本文件,**vendor 文件逐字节不改**。
 *
 * 本文件只提供 vendor 实际用到的形状:
 *   permissions.ts / platform/*  → ExtensionContext(hasUI / ui.select / ui.notify)
 *   bridge.ts                     → ExtensionContext(cwd / sessionManager.getBranch)+ AgentToolResult + AgentToolUpdateCallback
 *   config.ts                     → getAgentDir()
 */
import os from 'node:os';
import path from 'node:path';

export interface ExtensionUI {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  select(prompt: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export interface ExtensionContext {
  cwd: string;
  hasUI: boolean;
  ui: ExtensionUI;
  /** reconstructStateFromBranch 用;引擎侧无会话分支概念 → 给返回空数组的 stub(非可选,免 vendor possibly-undefined)。 */
  sessionManager: { getBranch(): unknown[] };
  signal?: AbortSignal;
}

export interface AgentToolResultTextContent { type: 'text'; text: string }
export interface AgentToolResultImageContent { type: 'image'; data: string; mimeType?: string }
export type AgentToolResultContent = AgentToolResultTextContent | AgentToolResultImageContent;

export interface AgentToolResult<TDetails = unknown> {
  content: AgentToolResultContent[];
  /** 上游 bridge.ts 假设 details 恒存在(每个 perform 都返回),故非可选。 */
  details: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (update: TDetails) => void;

/**
 * helper 状态 / 本地签名证书等的落点。引擎数据目录(TANGU_HOME;桌面托管 = ~/.forsion/tangu)。
 * 注:Tangu 侧不走 pi 的 pi-computer-use.json 配置文件(config 靠 pluginStore 3 键就地注入 activeConfig,
 * 见 settings.ts),故 config.ts 里用它拼配置路径的那条分支实际不活;保留仅为满足 vendor 编译。
 */
export function getAgentDir(): string {
  return process.env.TANGU_HOME || path.join(os.homedir(), '.tangu');
}
