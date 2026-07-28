/**
 * native helper 是否已安装的诚实检查。
 *
 * 为什么需要:vendor 的 ensureComputerUseSetup 只 checkPermissions(走系统 AX API,可能借到父进程的
 * 授权)+ 不校验 helper 二进制在不在 → 没装 helper 时也可能报「就绪」(假阳性)。真正 observe/act 才连
 * helper socket、那时才失败。故在惰性 setup / doctor 前先查 helper 可执行文件存在,缺则直接给指导文本。
 *
 * 路径**直接 import vendor 真正 spawn 用的常量**,不手抄——手抄副本曾和 vendor 失配过一次(品牌路径
 * P0:native 已品牌化而 vendor 常量还是 pi,doctor 查 tangu 路径报就绪、vendor spawn pi 路径必失败)。
 */
import { existsSync } from 'node:fs';
import { HELPER_APP_EXECUTABLE_PATH } from './vendor/platform/macos/helper.ts';
import { WINDOWS_HELPER_PATH } from './vendor/platform/windows/helper.ts';
import { LINUX_HELPER_PATH } from './vendor/platform/linux/helper.ts';

/** CU 支持的平台:macOS / Windows / Linux(vendor 的 platform/index.ts 各有原生后端)。 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
}

/** helper 可执行文件路径 = vendor 运行时用的同一常量(mac:.app 内 bridge;win/linux:bridge 可执行文件)。 */
export function helperExecutablePath(): string {
  if (process.platform === 'win32') return WINDOWS_HELPER_PATH;
  if (process.platform === 'linux') return LINUX_HELPER_PATH;
  return HELPER_APP_EXECUTABLE_PATH;
}

/** helper 是否已安装(可执行文件存在)。不支持的平台恒 false。 */
export function helperInstalled(): boolean {
  return isSupportedPlatform() && existsSync(helperExecutablePath());
}
