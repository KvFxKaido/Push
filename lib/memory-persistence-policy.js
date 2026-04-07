"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_PERSISTENCE_POLICY = void 0;
exports.getRecordPolicy = getRecordPolicy;
exports.isExpired = isExpired;
exports.shouldPersist = shouldPersist;
var DEFAULT_TTL_DAYS = 7;
exports.MEMORY_PERSISTENCE_POLICY = {
    finding: { persist: true, ttlDays: 30, truncateDetail: true },
    fact: { persist: true, ttlDays: 30, truncateDetail: true },
    decision: { persist: true, ttlDays: 30, truncateDetail: true },
    task_outcome: { persist: true, ttlDays: 7, truncateDetail: true },
    verification_result: { persist: true, ttlDays: 3, truncateDetail: true },
    file_change: { persist: false },
    symbol_trace: { persist: true, ttlDays: 14, truncateDetail: true },
    dependency_trace: { persist: true, ttlDays: 14, truncateDetail: true },
};
function getRecordPolicy(kind) {
    return exports.MEMORY_PERSISTENCE_POLICY[kind] || { persist: false };
}
function isExpired(record, now) {
    if (now === void 0) { now = Date.now(); }
    var policy = getRecordPolicy(record.kind);
    if (!policy.ttlDays)
        return false;
    var ttlMs = policy.ttlDays * 24 * 60 * 60 * 1000;
    return now - record.source.createdAt > ttlMs;
}
function shouldPersist(record) {
    var policy = getRecordPolicy(record.kind);
    return policy.persist && !isExpired(record);
}
