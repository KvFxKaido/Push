"use strict";
/**
 * Freshness transitions for typed context memory records.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateMemoryForChangedFiles = invalidateMemoryForChangedFiles;
exports.expireBranchScopedMemory = expireBranchScopedMemory;
exports.supersedeVerificationMemory = supersedeVerificationMemory;
var context_memory_store_1 = require("./context-memory-store");
function normalizePath(path) {
    return path
        .trim()
        .replace(/^\/workspace\//i, '')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .toLowerCase();
}
function normalizeCommand(command) {
    return command.trim().replace(/\s+/g, ' ');
}
function matchesScope(record, scope) {
    if (record.scope.repoFullName !== scope.repoFullName)
        return false;
    if (scope.branch && record.scope.branch && record.scope.branch !== scope.branch)
        return false;
    if (scope.chatId && record.scope.chatId && record.scope.chatId !== scope.chatId)
        return false;
    return true;
}
function setFreshness(store, record, freshness, reason, timestamp) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (record.freshness === freshness)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, store.update(record.id, {
                            freshness: freshness,
                            invalidatedAt: timestamp,
                            invalidationReason: reason,
                        })];
                case 1:
                    _a.sent();
                    return [2 /*return*/, true];
            }
        });
    });
}
function collectDescendantIds(records, seedIds) {
    var _a;
    var descendantIds = new Set();
    var queue = __spreadArray([], seedIds, true);
    while (queue.length > 0) {
        var currentId = queue.shift();
        for (var _i = 0, records_1 = records; _i < records_1.length; _i++) {
            var record = records_1[_i];
            if (descendantIds.has(record.id) || seedIds.has(record.id))
                continue;
            if (!((_a = record.derivedFrom) === null || _a === void 0 ? void 0 : _a.includes(currentId)))
                continue;
            descendantIds.add(record.id);
            queue.push(record.id);
        }
    }
    return descendantIds;
}
function invalidateMemoryForChangedFiles(input) {
    return __awaiter(this, void 0, void 0, function () {
        var normalizedPaths, store, timestamp, scopedRecords, directlyAffectedIds, _i, scopedRecords_1, record, relatedFiles, descendantIds, allAffectedIds, reason, changedCount, _a, scopedRecords_2, record;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    normalizedPaths = new Set(input.changedPaths
                        .map(normalizePath)
                        .filter(Boolean));
                    if (normalizedPaths.size === 0)
                        return [2 /*return*/, 0];
                    store = (_b = input.store) !== null && _b !== void 0 ? _b : (0, context_memory_store_1.getDefaultMemoryStore)();
                    timestamp = (_c = input.timestamp) !== null && _c !== void 0 ? _c : Date.now();
                    return [4 /*yield*/, store.list(function (record) { return matchesScope(record, input.scope); })];
                case 1:
                    scopedRecords = _f.sent();
                    directlyAffectedIds = new Set();
                    for (_i = 0, scopedRecords_1 = scopedRecords; _i < scopedRecords_1.length; _i++) {
                        record = scopedRecords_1[_i];
                        if (record.freshness === 'expired')
                            continue;
                        relatedFiles = (_d = record.relatedFiles) !== null && _d !== void 0 ? _d : [];
                        if (relatedFiles.some(function (path) { return normalizedPaths.has(normalizePath(path)); })) {
                            directlyAffectedIds.add(record.id);
                        }
                    }
                    if (directlyAffectedIds.size === 0)
                        return [2 /*return*/, 0];
                    descendantIds = collectDescendantIds(scopedRecords, directlyAffectedIds);
                    allAffectedIds = new Set(__spreadArray(__spreadArray([], directlyAffectedIds, true), descendantIds, true));
                    reason = (_e = input.reason) !== null && _e !== void 0 ? _e : "Files changed: ".concat(__spreadArray([], normalizedPaths, true).slice(0, 3).join(', '));
                    changedCount = 0;
                    _a = 0, scopedRecords_2 = scopedRecords;
                    _f.label = 2;
                case 2:
                    if (!(_a < scopedRecords_2.length)) return [3 /*break*/, 5];
                    record = scopedRecords_2[_a];
                    if (!allAffectedIds.has(record.id))
                        return [3 /*break*/, 4];
                    return [4 /*yield*/, setFreshness(store, record, 'stale', reason, timestamp)];
                case 3:
                    if (_f.sent()) {
                        changedCount++;
                    }
                    _f.label = 4;
                case 4:
                    _a++;
                    return [3 /*break*/, 2];
                case 5: return [2 /*return*/, changedCount];
            }
        });
    });
}
function expireBranchScopedMemory(input) {
    return __awaiter(this, void 0, void 0, function () {
        var store, timestamp, branchScopedRecords, changedCount, _i, branchScopedRecords_1, record;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    store = (_a = input.store) !== null && _a !== void 0 ? _a : (0, context_memory_store_1.getDefaultMemoryStore)();
                    timestamp = (_b = input.timestamp) !== null && _b !== void 0 ? _b : Date.now();
                    return [4 /*yield*/, store.list(function (record) {
                            return record.scope.repoFullName === input.repoFullName
                                && record.scope.branch === input.branch;
                        })];
                case 1:
                    branchScopedRecords = _c.sent();
                    changedCount = 0;
                    _i = 0, branchScopedRecords_1 = branchScopedRecords;
                    _c.label = 2;
                case 2:
                    if (!(_i < branchScopedRecords_1.length)) return [3 /*break*/, 5];
                    record = branchScopedRecords_1[_i];
                    return [4 /*yield*/, setFreshness(store, record, 'expired', "Branch changed away from ".concat(input.branch), timestamp)];
                case 3:
                    if (_c.sent()) {
                        changedCount++;
                    }
                    _c.label = 4;
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5: 
                    return [2 /*return*/, changedCount];
            }
        });
    });
}
function supersedeVerificationMemory(input) {
    return __awaiter(this, void 0, void 0, function () {
        var store, timestamp, normalizedCommand, checkTag, commandTag, candidates, changedCount, _i, candidates_1, record, tags, matchesCheck, matchesCommand;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    store = (_a = input.store) !== null && _a !== void 0 ? _a : (0, context_memory_store_1.getDefaultMemoryStore)();
                    timestamp = (_b = input.timestamp) !== null && _b !== void 0 ? _b : Date.now();
                    normalizedCommand = input.command ? normalizeCommand(input.command) : null;
                    checkTag = "check:".concat(input.checkId);
                    commandTag = normalizedCommand ? "command:".concat(normalizedCommand) : null;
                    return [4 /*yield*/, store.list(function (record) {
                            return record.kind === 'verification_result'
                                && matchesScope(record, input.scope)
                                && record.freshness !== 'expired';
                        })];
                case 1:
                    candidates = _d.sent();
                    changedCount = 0;
                    _i = 0, candidates_1 = candidates;
                    _d.label = 2;
                case 2:
                    if (!(_i < candidates_1.length)) return [3 /*break*/, 5];
                    record = candidates_1[_i];
                    tags = new Set((_c = record.tags) !== null && _c !== void 0 ? _c : []);
                    matchesCheck = tags.has(checkTag) || record.source.label === "Verification: ".concat(input.checkId);
                    matchesCommand = commandTag ? tags.has(commandTag) : false;
                    if (!matchesCheck && !matchesCommand)
                        return [3 /*break*/, 4];
                    return [4 /*yield*/, setFreshness(store, record, 'stale', "Superseded by newer verification for ".concat(input.checkId), timestamp)];
                case 3:
                    if (_d.sent()) {
                        changedCount++;
                    }
                    _d.label = 4;
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5: return [2 /*return*/, changedCount];
            }
        });
    });
}
