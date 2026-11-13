import AppKit

/// 整轮叠层的执行者(Tangu,协议 20,非上游):把 OverlayTurnModel(纯状态机)的输出落到边缘光和示意光标上。
///
/// 所有入口都在主线程(bridge 用 DispatchQueue.main.async 按顺序投过来:act 开始 → 画光标 → act 结束)。
/// 计时只有一个:下一个档位可能变化的时刻(在想 / 45 s 超时 / 结束后 1 s / 淡出完)。一轮放完就什么都不剩。
@MainActor
final class AgentOverlayTurn {
    static let shared = AgentOverlayTurn()

    private enum Visual: Equatable {
        case none
        case acting
        case thinking
        /// 已结束,等 1 s 再淡出:保持原样。
        case holding
        case fading
    }

    private var model = OverlayTurnModel()
    private var applied: Visual = .none
    private var deadlineTask: Task<Void, Never>?
    private var deadlineGeneration: UInt = 0

    /// 这一轮正在进行(带 runId 且还没结束)。
    var turnActive: Bool {
        let now = OverlayClock.now()
        switch model.phase(at: now) {
        case .acting, .thinking: return true
        case .idle, .ending: return false
        }
    }

    var currentRunId: String? { model.active ? model.runId : nil }

    /// 每条 act 一进来调一次(actBatch 每一步各一次)。options.enabled = false(「操作可视化」关了)→ 什么都不画,
    /// 已经亮着的也立刻收掉。
    func actStarted(windowId: UInt32, options: OverlayActOptions) {
        let now = OverlayClock.now()
        guard options.enabled else {
            disableAll()
            return
        }
        let inTurn = model.actStarted(runId: options.runId, at: now)
        // 换了主题色,从这个动作起生效。
        AgentCursor.shared.renderer.palette = options.palette
        AgentHighlight.shared.model.palette = options.palette
        AgentCursor.shared.holdForTurn = inTurn
        AgentHighlight.shared.show(windowId: windowId, turn: inTurn, now: now)
        if !inTurn { applied = .none }
        reconcile(now: now)
    }

    func actEnded() {
        let now = OverlayClock.now()
        model.actEnded(at: now)
        reconcile(now: now)
    }

    /// overlayTurn end。runId 对不上、或没给 runId 而这一轮有 runId → 不做事。
    func requestEnd(runId: String?) {
        let now = OverlayClock.now()
        guard model.requestEnd(runId: runId, at: now) else { return }
        reconcile(now: now)
    }

    private func disableAll() {
        cancelDeadline()
        model = OverlayTurnModel()
        applied = .none
        AgentCursor.shared.holdForTurn = false
        AgentHighlight.shared.hide()
        AgentCursor.shared.hideNow()
    }

    private func cancelDeadline() {
        deadlineGeneration &+= 1
        deadlineTask?.cancel()
        deadlineTask = nil
    }

    private func reconcile(now: Double) {
        cancelDeadline()
        guard model.active else { return }
        model.advance(to: now)
        let visual: Visual
        switch model.phase(at: now) {
        case .acting: visual = .acting
        case .thinking: visual = .thinking
        case .ending(let fadeAt): visual = now >= fadeAt ? .fading : .holding
        case .idle:
            model.settle(at: now)
            AgentCursor.shared.holdForTurn = false
            if applied != .fading {
                AgentHighlight.shared.fadeOut(now: now)
                AgentCursor.shared.fadeOut(now: now)
            }
            applied = .none
            return
        }
        if visual != applied {
            switch visual {
            case .acting:
                AgentHighlight.shared.setLevel(HighlightScene.actingLevel, duration: HighlightScene.riseDuration, now: now)
                AgentCursor.shared.setThinking(false, now: now)
            case .thinking:
                AgentHighlight.shared.setLevel(HighlightScene.thinkingLevel, duration: HighlightScene.dimDuration, now: now)
                AgentCursor.shared.setThinking(true, now: now)
            case .holding, .none:
                break
            case .fading:
                AgentCursor.shared.holdForTurn = false
                AgentHighlight.shared.fadeOut(now: now)
                AgentCursor.shared.fadeOut(now: now)
            }
            applied = visual
        }
        guard let deadline = model.nextDeadline(after: now) else { return }
        let generation = deadlineGeneration
        deadlineTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline - now) + 0.01))
            guard !Task.isCancelled, let self, generation == self.deadlineGeneration else { return }
            self.reconcile(now: OverlayClock.now())
        }
    }
}
