"use strict";
/**
 * In-memory storage for typed `MemoryRecord`s.
 *
 * Phase 1/2 scope: pure in-memory. Records live for the life of the process
 * session. The store shape is deliberately compatible with later durable
 * backends so callers do not need to change when persistence is added.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInMemoryStore = createInMemoryStore;
exports.getDefaultMemoryStore = getDefaultMemoryStore;
exports.setDefaultMemoryStore = setDefaultMemoryStore;
function createInMemoryStore() {
    var records = new Map();
    return {
        write: function (record) {
            records.set(record.id, record);
        },
        writeMany: function (batch) {
            for (var _i = 0, batch_1 = batch; _i < batch_1.length; _i++) {
                var record = batch_1[_i];
                records.set(record.id, record);
            }
        },
        get: function (id) {
            return records.get(id);
        },
        list: function (predicate) {
            var result = [];
            for (var _i = 0, _a = records.values(); _i < _a.length; _i++) {
                var record = _a[_i];
                if (!predicate || predicate(record))
                    result.push(record);
            }
            return result;
        },
        update: function (id, patch) {
            var existing = records.get(id);
            if (!existing)
                return undefined;
            var merged = __assign(__assign({}, existing), patch);
            records.set(id, merged);
            return merged;
        },
        remove: function (id) {
            records.delete(id);
        },
        clear: function () {
            records.clear();
        },
        clearByRepo: function (repoFullName) {
            for (var _i = 0, _a = records.entries(); _i < _a.length; _i++) {
                var _b = _a[_i], id = _b[0], record = _b[1];
                if (record.scope.repoFullName === repoFullName) {
                    records.delete(id);
                }
            }
        },
        clearByBranch: function (repoFullName, branch) {
            for (var _i = 0, _a = records.entries(); _i < _a.length; _i++) {
                var _b = _a[_i], id = _b[0], record = _b[1];
                if (record.scope.repoFullName === repoFullName && record.scope.branch === branch) {
                    records.delete(id);
                }
            }
        },
        size: function () {
            return records.size;
        },
    };
}
var defaultStore = null;
function getDefaultMemoryStore() {
    if (!defaultStore) {
        defaultStore = createInMemoryStore();
    }
    return defaultStore;
}
function setDefaultMemoryStore(store) {
    defaultStore = store;
}
