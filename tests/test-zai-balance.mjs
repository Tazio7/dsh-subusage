// Z.ai（中国区）账户余额：退订 Coding Plan 后仍要能显示充值余额。
// 契约 2026-11-20 用真实 Key 实测：Bearer 模型 Key 即可读控制台财务中心的
// `GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report`。
import assert from "node:assert/strict";
import { loadHostModule } from "./helpers.mjs";
const { SubUsageService, normalizeZaiBalance } = await loadHostModule();
const Z = "zai-coding-cn";
const QUOTA = { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 12 }, { type: "CREDIT_LIMIT", unit: 6, percentage: 20 }], level: "pro" } };
const BALANCE = { code: 200, msg: "操作成功", success: true, data: { balance: "13.387515800", availableBalance: "13.387515800", giveAmount: "39.467518", totalSpendAmount: "36.080002200", frozenBalance: 0, creditStatus: "NOT_OPEN" } };

// ── 归一化：可用余额优先、字符串与数字都收、冻结余额只在非零时占一行 ──────────────
let out = normalizeZaiBalance(BALANCE);
assert.deepEqual(out.extras, [{ kind: "balance", value: "13.39 CNY" }]);
assert.deepEqual(out.windows, []);
assert.equal(out.coverage, "complete");
assert.equal(normalizeZaiBalance({ data: { availableBalance: 0 } }).extras[0].value, "0 CNY", "0 元是合法余额，不能当成读不到");
assert.equal(normalizeZaiBalance({ data: { balance: "8.5" } }).extras[0].value, "8.5 CNY", "availableBalance 缺失时回落到账面余额");
out = normalizeZaiBalance({ data: { availableBalance: "9.9", frozenBalance: "1.25" } });
assert.deepEqual(out.extras, [{ kind: "balance", value: "9.9 CNY" }, { kind: "note", value: "冻结余额 1.25 CNY" }]);
for (const body of [{}, { data: null }, { data: {} }, { data: { availableBalance: "abc" } }, { data: { availableBalance: null, balance: "" } }]) assert.throws(() => normalizeZaiBalance(body));

// ── 服务层：额度与余额两个端点各自独立降级 ─────────────────────────────────────
function harness(respond) {
	const files = new Map();
	const calls = [];
	const io = {
		readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
		mkdirSync() {},
		writeFileSync(path, value) { files.set(path, value); },
		chmodSync() {},
		renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
	};
	const service = new SubUsageService({ effect() {}, llm: { listProviders: () => [{ id: Z }] } }, {
		io, configPath: "memory/config", now: () => Date.parse("2026-11-20T00:00:00Z"),
		resolveCredentials: async () => ({ value: "fixture-key" }), resolveEnvironment: () => undefined,
		fetch: async (url, options) => {
			calls.push({ url, options });
			const value = await respond(url);
			if (value instanceof Error) throw value;
			if (value?.http) return { ok: false, status: value.http, headers: { get: () => value.retryAfter ?? null } };
			return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) };
		}
	});
	return { service, calls };
}
const isBalance = url => url.endsWith("/api/biz/account/query-customer-account-report");
const refresh = async respond => {
	const h = harness(respond);
	const result = await h.service.refresh({ providerIds: [Z], force: true });
	h.service.dispose?.();
	return { entry: result.entries[0], calls: h.calls };
};

// 有 Coding Plan 也有余额：窗口照常，余额作为附加行，两个端点都带同一把 Key。
let run = await refresh(url => isBalance(url) ? BALANCE : QUOTA);
assert.equal(run.entry.state, "ok");
assert.deepEqual(run.entry.windows.map(w => w.percent), [12, 20]);
assert.deepEqual(run.entry.extras, [{ kind: "plan", value: "pro" }, { kind: "balance", value: "13.39 CNY" }]);
assert.equal(run.calls.length, 2, "额度与余额各请求一次");
for (const call of run.calls) assert.equal(call.options.headers.authorization, "Bearer fixture-key", "两个端点共用模型 Key 的 Bearer");

// 退订后的常态：额度端点 200 但 limits 为空，余额仍可读 → 纯余额药丸，不画 0% 卡片。
run = await refresh(url => isBalance(url) ? BALANCE : { data: { limits: [] } });
assert.equal(run.entry.state, "ok");
assert.deepEqual(run.entry.windows ?? [], []);
assert.equal(run.entry.coverage, "complete");
assert.equal(run.entry.subscribed, false);
assert.deepEqual(run.entry.extras, [{ kind: "balance", value: "13.39 CNY" }, { kind: "plan", value: "未检测到 Coding Plan 套餐，按量计费" }]);

// 额度端点临时失败但余额可读：余额照常显示，标记 partial（不能把故障说成「没订阅」）。
run = await refresh(url => isBalance(url) ? BALANCE : { http: 500 });
assert.equal(run.entry.state, "ok");
assert.deepEqual(run.entry.windows ?? [], []);
assert.equal(run.entry.coverage, "partial");
assert.equal(run.entry.subscribed, undefined, "上游故障不是「确定未订阅」");
assert.deepEqual(run.entry.extras, [{ kind: "balance", value: "13.39 CNY" }, { kind: "note", value: "Coding Plan 额度暂不可读；余额已更新" }]);

// 退订后另一种形态：额度端点 403（Key 有效但已无 Coding Plan 监控权限）。余额已证明 Key 可用，
// 按「只有余额」呈现，不把药丸永久标成「数据不完整」。
run = await refresh(url => isBalance(url) ? BALANCE : { http: 403 });
assert.equal(run.entry.state, "ok");
assert.equal(run.entry.coverage, "complete");
assert.deepEqual(run.entry.windows ?? [], []);
assert.deepEqual(run.entry.extras, [{ kind: "balance", value: "13.39 CNY" }, { kind: "note", value: "Coding Plan 额度接口拒绝访问（Key 无该权限或已退订）；余额已更新" }]);

// 余额端点不可用不影响原有的窗口展示。
run = await refresh(url => isBalance(url) ? { http: 403 } : QUOTA);
assert.equal(run.entry.state, "ok");
assert.deepEqual(run.entry.windows.map(w => w.percent), [12, 20]);
assert.deepEqual(run.entry.extras, [{ kind: "plan", value: "pro" }]);

// 两个端点都失败才报错，并且错误来自额度端点（用户要去看 Coding Plan 凭据，不是余额）。
run = await refresh(url => isBalance(url) ? { http: 403 } : { http: 401 });
assert.equal(run.entry.state, "error");
assert.equal(run.entry.errorCode, "subusage/auth");
console.log("PASS Z.ai CN balance endpoint: independent degradation, balance-only after unsubscribe, no fabricated 0% windows");
