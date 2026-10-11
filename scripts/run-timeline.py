#!/usr/bin/env python3
"""把一次 agent 运行重建成逐步时间线:每一轮的思考原文、工具调用、结果开头和耗时。

Forsion 的反馈导出(tangu-feedback-*.json)里只有最后的消息,没有思考原文,也没有每一轮花了多久;
这些在本机引擎库 <home>/tangu/state.db 的 agent_run_events 里。诊断「Computer Use 为什么没做成」
要看的正是模型每一步以为自己看到了什么(反馈 55b984eb 就是这么查出来的)。只读打开;截图不落库,这里看不到。

用法: python3 scripts/run-timeline.py <会话 id 或 run id> [--home ~/.forsion]     # dev 实例是 ~/.forsion-dev
"""
import argparse, json, os, sqlite3

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('id', help='会话 id 或 run id')
ap.add_argument('--home', default='~/.forsion')
args = ap.parse_args()

db = sqlite3.connect('file:' + os.path.join(os.path.expanduser(args.home), 'tangu', 'state.db') + '?mode=ro', uri=True)
runs = db.execute('select id, status, model_id, created_at, updated_at from agent_runs where id = ? or session_id = ? order by created_at', (args.id, args.id)).fetchall()
if not runs:
    raise SystemExit(f'没有找到会话或 run {args.id}(库:{args.home}/tangu/state.db)')

for run_id, status, model, created, updated in runs:
    print(f'\n##### run {run_id} · {model} · {status} · {created} → {updated}')
    thinking, totals = [], {'llmMs': 0, 'uploadMs': 0, 'reasoningTokens': 0, 'toolMs': 0, 'turns': 0}

    def flush():
        text = ''.join(thinking).strip()
        thinking.clear()
        if text:
            print('  [思考] ' + text.replace('\n', '\n         '))

    for kind, payload, at in db.execute('select type, payload, created_at from agent_run_events where run_id = ? order by seq', (run_id,)):
        try:
            p = json.loads(payload) if payload else {}
        except ValueError:
            continue
        if kind == 'reasoning':
            thinking.append(p.get('delta') or p.get('text') or '')
        elif kind == 'tool_call':
            flush()
            print(f"\n=== {at} 调用 {p.get('name')} {json.dumps(p.get('arguments') or p.get('args'), ensure_ascii=False)[:500]}")
        elif kind == 'tool_result':
            flush()
            totals['toolMs'] += p.get('elapsedMs') or 0
            print(f"--- 结果{'(报错)' if p.get('isError') else ''} {p.get('elapsedMs')}ms: {str(p.get('result'))[:240]!r}")
        elif kind == 'usage':
            flush()
            totals['turns'] += 1
            for key in ('llmMs', 'uploadMs', 'reasoningTokens'):
                totals[key] += p.get(key) or 0
            print(f"  (第 {p.get('iteration')} 轮:模型 {p.get('llmMs')}ms,其中上传 {p.get('uploadMs')}ms / {p.get('requestBytes')} 字节;思考 {p.get('reasoningTokens')} token)")
    flush()
    print(f"\n合计 {totals['turns']} 轮:模型 {totals['llmMs'] / 1000:.0f}s(其中上传 {totals['uploadMs'] / 1000:.0f}s),工具 {totals['toolMs'] / 1000:.0f}s,思考 {totals['reasoningTokens']} token")
