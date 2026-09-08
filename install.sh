#!/usr/bin/env bash
# 装/更新「电脑操作(Computer Use)」捆绑包到 Forsion 家目录。
#   用法:sh install.sh [dev|prod]     缺省 dev(~/.forsion-dev);prod=~/.forsion
#
# 本仓即 bundle 本体,整目录拷到 <home>/plugins/tangu-computer-use/ 一处即完成:
#   桌面识别 manifest.json + main.js(「被操控的窗口」实时画面视图);
#   引擎(tangu-agent bundles.ts)原地读 tangu-plugins/computer-use/(12 个工具)与 skills/(配套技能)。
# native helper 不在这里装,但**也不用人管**:随包的 prebuilt 二进制会在第一次用工具时自动装/更新
# (src/onboarding.ts)。只有系统授权(辅助功能/屏幕录制)必须用户自己拨 —— agent 会替他打开面板。
set -euo pipefail
MODE="${1:-dev}"
case "$MODE" in
  dev)  HOME_DIR="$HOME/.forsion-dev" ;;
  prod) HOME_DIR="$HOME/.forsion" ;;
  *) echo "用法:sh install.sh [dev|prod]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME_DIR/plugins/tangu-computer-use"

# 不许从已安装目录内自更新:下面的 rm -rf 会先删掉复制源(自己),把插件卸成空壳
if [ "$HERE" = "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
  echo "❌ 正在从已安装目录运行,请从源码仓的 tangu-computer-use/ 目录执行 install.sh" >&2
  exit 2
fi

# 引擎入口必须先构建出来,否则装过去是个不会激活的空壳
if [ ! -f "$HERE/tangu-plugins/computer-use/dist/index.js" ]; then
  echo "❌ 缺少 tangu-plugins/computer-use/dist/index.js,先跑 npm install && npm run build" >&2
  exit 2
fi

# 原子落位:先拷进同盘 staging,拷成功了再换掉旧的。
# 直接 `rm -rf $DEST && cp` 的话,中途失败(磁盘满、拷贝被打断)就把用户装好的插件删成了空壳,
# 而空壳是会被宿主扫到的——比"没装"更糟。同 bundles.ts 的播种纪律。
mkdir -p "$HOME_DIR/plugins"
# 互斥锁:mkdir 是原子的。两个 install 同时跑会互相把对方的 staging 塞进对方刚装好的目录里。
LOCK="$DEST.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "❌ 另一个安装正在进行($LOCK 已存在)。确认没有别的 install.sh 在跑后,删掉它再试。" >&2
  exit 2
fi
STAGING="$DEST.staging.$$"
OLD="$DEST.old.$$"
cleanup() { rm -rf "$STAGING"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT
rm -rf "$STAGING"
mkdir -p "$STAGING"
# node_modules / .git 不进 bundle(运行时零依赖,dist 是单文件)
tar -C "$HERE" --exclude='./node_modules' --exclude='./.git' --exclude='./.idea' --exclude='.DS_Store' -cf - . | tar -C "$STAGING" -xf -
# 校验:关键三件缺一件就当拷贝失败,旧的原样留着
for REQUIRED in manifest.json main.js tangu-plugins/computer-use/dist/index.js; do
  if [ ! -f "$STAGING/$REQUIRED" ]; then
    echo "❌ 拷贝不完整(缺 $REQUIRED),已保留原安装不动" >&2
    exit 1
  fi
done
if [ -e "$DEST" ]; then mv "$DEST" "$OLD"; fi
if ! mv "$STAGING" "$DEST"; then
  [ -e "$OLD" ] && mv "$OLD" "$DEST"   # 换不过去就把旧的放回来
  echo "❌ 落位失败,已回滚到原安装" >&2
  exit 1
fi
rm -rf "$OLD"

echo "✅ 已安装 bundle → $DEST"

# 旧形态残留处理:0.1.x 是走 `tangu install` 的**独立引擎插件**,装在 <home>/tangu/plugins/ 或 ~/.tangu/plugins/。
# 它和 bundle 内嵌的那份是**同一个插件 id**(computer-use),而用户插件目录的优先级**高于** bundle 内嵌根
# —— 所以旧的那份会**赢**,新功能全部装不上,还会因协议版本对不上把整个 CU 卡死(2026-07-27 真事)。
# 因此这里主动挪走,不是只报告一句让人自己看见。
#
# ⚠️ 两条纪律:
#   1. **必须挪出扫描根**,光改名没用 —— 加载器认的是 manifest 里的 id,不是目录名。
#   2. **挪不是删**:落到 <home>/tangu/_disabled-plugins/,随时能搬回来。软链只删链接本身。
# ⚠️ 这一段发生在 bundle 已经装好之后,任何一步失败都**不许**中断脚本 —— 装好的东西不能因为
# 清理失败而回滚成"没装"。所以整段包在 `|| true` 语义里,失败只报告。
LEGACY=""
DISABLED="$HOME_DIR/tangu/_disabled-plugins"
# 顶层 id 必须**解析 JSON** 来取:grep 会误中嵌套字段里的 "id":"computer-use",
# 把一个完全无关的插件当成旧副本挪走。node 一定在(前面已要求先 npm run build)。
topLevelId() { node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id||""))}catch(e){}' "$1" 2>/dev/null; }
for ROOT in "$HOME_DIR/tangu/plugins" "$HOME/.tangu/plugins"; do
  [ -d "$ROOT" ] || continue
  for ENTRY in "$ROOT"/*; do
    [ -e "$ENTRY" ] || continue
    [ -f "$ENTRY/tangu-plugin.json" ] || continue
    [ "$(topLevelId "$ENTRY/tangu-plugin.json")" = "computer-use" ] || continue
    if [ -L "$ENTRY" ]; then
      rm "$ENTRY" && LEGACY="$LEGACY\n     已删软链 $ENTRY"
    else
      # 目标名带时间戳:**绝不 rm -rf 一个已存在的同名目录** —— 那可能是上次挪走的、
      # 或干脆是用户自己放在这儿的别的东西。
      TARGET="$DISABLED/$(basename "$ENTRY").$(date +%Y%m%d%H%M%S).$$"
      if mkdir -p "$DISABLED" && mv "$ENTRY" "$TARGET"; then
        LEGACY="$LEGACY\n     已挪走 $ENTRY → $TARGET"
      else
        LEGACY="$LEGACY\n     ⚠️ 挪不动 $ENTRY(权限?)—— 它会遮蔽 bundle,请手动移出 $ROOT"
      fi
    fi
  done
done
echo "   引擎插件:$DEST/tangu-plugins/computer-use(12 个工具)"
echo "   配套技能:$DEST/skills/computer-use"
echo "重开 Forsion(dev:重启 desktop)后:设置 → 插件 → 启用「电脑操作」;"
echo "native helper 会在首次用工具时自动装好;届时按提示在系统设置里授予辅助功能与屏幕录制即可。"

if [ -n "$LEGACY" ]; then
  echo ""
  echo "⚠️  清理了旧形态的独立引擎插件(与 bundle 内嵌的同 id,且优先级更高会把新版遮蔽掉):"
  printf "%b\n" "$LEGACY"
  echo "   要还原的话把目录搬回 $HOME_DIR/tangu/plugins/ 即可。"
fi
