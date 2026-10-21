/// Runs one transcription at a time; the others wait in arrival order.
actor TranscriptionQueue {
    private var running = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// Jobs waiting behind the running one.
    var waiting: Int { waiters.count }
    var isBusy: Bool { running || !waiters.isEmpty }

    func run<T: Sendable>(_ job: @Sendable () async throws -> T) async throws -> T {
        if running {
            // `release` hands the slot over, so `running` stays true.
            await withCheckedContinuation { waiters.append($0) }
        } else {
            running = true
        }
        defer { release() }
        return try await job()
    }

    private func release() {
        if waiters.isEmpty {
            running = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}
