// @ts-check
// Tests the PURE helper block extracted from fanout.mjs. fanout.mjs cannot be
// imported (top-level return → SyntaxError in node:test), so we read it as text,
// slice the // >>> PURE ... // <<< PURE block, and eval it with new Function to get
// the actual shipped helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "fanout.mjs"), "utf8");
const block = src.split("// >>> PURE")[1]?.split("// <<< PURE")[0];
assert.ok(block, "fanout.mjs must contain a // >>> PURE ... // <<< PURE block");
const PURE = new Function(
  block +
    "\nreturn { partitionWaves, validateArgs, shouldEscalate, tallyMeta, researchPrompt, verifyPrompt, researchProblems, isPlaceholderHost, depsSatisfied };"
)();

test("partitionWaves: empty deps -> wave 1, non-empty deps -> wave 2", () => {
  const angles = [
    { id: "a", deps: [] },
    { id: "b", deps: [] },
    { id: "c", deps: ["a"] },
  ];
  const { wave1, wave2 } = PURE.partitionWaves(angles);
  assert.deepEqual(wave1.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(wave2.map((x) => x.id), ["c"]);
});

test("partitionWaves: missing deps treated as wave 1", () => {
  const { wave1, wave2 } = PURE.partitionWaves([{ id: "a" }]);
  assert.deepEqual(wave1.map((x) => x.id), ["a"]);
  assert.equal(wave2.length, 0);
});

test("validateArgs: rejects missing topic", () => {
  assert.throws(() => PURE.validateArgs({ angles: [{ id: "a", question: "q" }] }), /topic/);
});

test("validateArgs: rejects empty angles", () => {
  assert.throws(() => PURE.validateArgs({ topic: "t", angles: [] }), /angles/);
});

test("validateArgs: defaults mode=deep and angle.model=sonnet", () => {
  const out = PURE.validateArgs({ topic: "t", angles: [{ id: "a", question: "q" }] });
  assert.equal(out.mode, "deep");
  assert.equal(out.angles[0].model, "sonnet");
  assert.equal(out.angles[0].kind, "core");
  assert.deepEqual(out.angles[0].deps, []);
  assert.equal(out.verify.escalateOn, "low");
});

test("validateArgs: honors a valid verify.escalateOn, ignores invalid", () => {
  const ok = PURE.validateArgs({ topic: "t", angles: [{ question: "q" }], verify: { escalateOn: "medium" } });
  assert.equal(ok.verify.escalateOn, "medium");
  const bad = PURE.validateArgs({ topic: "t", angles: [{ question: "q" }], verify: { escalateOn: "bogus" } });
  assert.equal(bad.verify.escalateOn, "low");
});

test("verifyPrompt: lists findings and handles empty findings", () => {
  const withFindings = PURE.verifyPrompt(
    { id: "a", question: "Q" },
    { findings: [{ claim: "C1", sourceUrl: "http://x", sourceTitle: "T1", sourceDate: "2026" }] }
  );
  assert.match(withFindings, /C1/);
  assert.match(withFindings, /independent/i);
  const empty = PURE.verifyPrompt({ id: "a", question: "Q" }, {});
  assert.match(empty, /angleId="a"/);
});

test("shouldEscalate: true only when reliability is low", () => {
  // Field name is overallReliability — VERIFY_SCHEMA requires and returns it (see C3 test below).
  assert.equal(PURE.shouldEscalate({ overallReliability: "low" }, "low"), true);
  assert.equal(PURE.shouldEscalate({ overallReliability: "medium" }, "low"), false);
  assert.equal(PURE.shouldEscalate({ overallReliability: "high" }, "low"), false);
  assert.equal(PURE.shouldEscalate(null, "low"), false);
});

test("shouldEscalate: threshold semantics — escalateOn=medium covers low and medium, not high", () => {
  assert.equal(PURE.shouldEscalate({ overallReliability: "low" }, "medium"), true);
  assert.equal(PURE.shouldEscalate({ overallReliability: "medium" }, "medium"), true);
  assert.equal(PURE.shouldEscalate({ overallReliability: "high" }, "medium"), false);
});

test("tallyMeta: counts completed, failed, escalated", () => {
  const results = [
    { angleId: "a", escalated: false },
    { angleId: "b", escalated: true },
    null,
  ];
  const m = PURE.tallyMeta("deep", 2, results);
  assert.equal(m.mode, "deep");
  assert.equal(m.wavesRun, 2);
  assert.equal(m.anglesCompleted, 2);
  assert.equal(m.anglesFailed, 1);
  assert.equal(m.escalations, 1);
});

test("researchPrompt: deep vs scout wording, and wave context", () => {
  const deep = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", null);
  assert.match(deep, /DEPTH MODE/);
  const scout = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "scout", null);
  assert.match(scout, /BREADTH MODE/);
  const withCtx = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", "PRIOR");
  assert.match(withCtx, /WAVE-1 FINDINGS/);
  assert.match(withCtx, /PRIOR/);
});

test("validateArgs: parses a JSON string (runtime delivers args as a string)", () => {
  const out = PURE.validateArgs(JSON.stringify({ topic: "t", angles: [{ question: "q" }] }));
  assert.equal(out.topic, "t");
  assert.equal(out.mode, "deep");
  assert.equal(out.angles[0].question, "q");
});

test("validateArgs: throws on an invalid JSON string", () => {
  assert.throws(() => PURE.validateArgs("{not json"), /JSON/);
});

const { researchProblems, depsSatisfied, tallyMeta } = PURE;

const good = {
  angleId: "a1", kind: "core",
  summary: "Cloudflare's workerd runs untrusted code in V8 isolates rather than containers.",
  findings: [{ claim: "Rust adoption in Cloudflare Workers grew via workerd's V8 isolates.",
               sourceUrl: "https://blog.cloudflare.com/workerd", sourceTitle: "workerd", sourceDate: "2024-01-01" }],
};

test("researchProblems: a real result has no problems", () => {
  assert.deepEqual(researchProblems(good), []);
});

test("researchProblems: zero findings is a FAILED angle, not an empty success", () => {
  // Schema-valid. Reported as completed research today. The synthesis then treats "nothing" as
  // evidence of nothing, rather than as a worker that failed.
  assert.ok(researchProblems({ ...good, findings: [] }).some((p) => /no findings/i.test(p)));
});

test("researchProblems: an unusable SUMMARY fails the angle — wave 2 is built from it", () => {
  // Dep satisfaction keys off !failed, and the wave-2 digest is built ENTIRELY from research.summary.
  // A root with real findings and an empty summary is "successful", satisfies its dependents, and
  // dispatches them with a heading and nothing under it — so they research a question with a blank
  // premise and return a well-formed answer to it.
  for (const summary of ["", "   ", undefined, "TODO", "n/a", "short"]) {
    assert.ok(researchProblems({ ...good, summary }).some((p) => /summary/i.test(p)),
      `summary ${JSON.stringify(summary)} must fail the angle`);
  }
});

test("researchProblems: placeholder URLs are the fingerprint of a fabricated citation", () => {
  for (const url of ["https://example.com", "http://example.org/x", "https://localhost:3000/a",
                     "https://127.0.0.1/a", "http://test.com/a", "https://"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).length > 0, `${url} must be rejected`);
  }
});

test("researchProblems: a non-http source was never fetched", () => {
  for (const url of ["internal-knowledge", "ftp://x/y", "file:///etc/passwd", "not a url"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /url/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: userinfo cannot smuggle a placeholder host past the check", () => {
  // A hand-rolled split on "/" reads the host of `https://evil@example.com/x` as "evil@example.com",
  // which is not in the blocklist — so the placeholder walks straight through. URL.hostname does not.
  for (const url of ["https://evil@example.com/x", "https://a:b@localhost/y", "https://x@127.0.0.1/z"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /placeholder/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: DNS variants of a placeholder host are the same fabricated citation", () => {
  // Two equality-check bypasses, both trivial:
  //   - `example.com.` is a fully-qualified name. It resolves identically and is NOT === "example.com".
  //   - `sub.example.com` is a placeholder with a label bolted on.
  for (const url of ["https://example.com./x", "https://sub.example.com/x", "https://docs.example.org/y",
                     "https://a.b.test.com/z", "https://EXAMPLE.COM/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /placeholder/i.test(p)), `${url} must be rejected`);
  }
  // …but a real host that merely CONTAINS a placeholder name is not one. Do not over-reject.
  for (const url of ["https://example.community/x", "https://notexample.com/x", "https://myexample.com/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.deepEqual(researchProblems(r), [], `${url} is a legitimate host`);
  }
});

test("researchProblems: a bare IP address is never a research citation", () => {
  // A real source is a named website. A finding citing an IP literal is either fabricated or pointing
  // the verifier somewhere it has no business going — and the verifier is INSTRUCTED to fetch these.
  // 169.254.169.254 is the cloud instance-metadata endpoint; the old blocklist covered only 127.0.0.1,
  // so an angle could aim the verifier's WebFetch straight at it.
  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://192.168.1.1/x",
                     "http://10.0.0.1/x", "http://172.16.0.1/x", "https://93.184.216.34/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /url|host/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: reserved TLDs are guaranteed-unresolvable, so guaranteed-fabricated", () => {
  // RFC 2606 / 6761 reserve these so they can NEVER resolve to a real site. `example.invalid` sailed
  // past a blocklist that only knew about `example.com`.
  for (const url of ["https://example.invalid/fake", "https://anything.test/x", "https://foo.local/x",
                     "https://bar.localhost/x", "https://baz.example/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /url|host/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: host parsing works WITHOUT a URL constructor (issue #41 — the Workflow sandbox has none)", () => {
  // THE root-cause bug. The sealed Workflow runtime has no global URL (probed: `typeof URL` is
  // "undefined", `new URL()` throws ReferenceError). So host came back null for EVERY finding and
  // 100% of real research was false-rejected as "not a fetched http(s) URL". This went uncaught
  // because the node test harness DOES have URL — so we rebuild the helpers with URL shadowed to
  // undefined, reproducing the sandbox, and assert real citations pass and the security checks hold.
  const sandbox = new Function(
    "const URL = undefined;\n" + block + "\nreturn { researchProblems };"
  )();
  assert.deepEqual(sandbox.researchProblems(good), [],
    "a real https citation must pass in a runtime with no URL constructor");
  // Every security property must still hold with URL unavailable — same rejections, no constructor.
  for (const url of ["https://evil@example.com/x", "https://example.com./x", "https://EXAMPLE.COM/x",
                     "http://169.254.169.254/x", "http://[::1]/", "https://example.invalid/fake",
                     "ftp://x/y", "internal-knowledge", "https://"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(sandbox.researchProblems(r).length > 0, `${url} must still be rejected without URL`);
  }
  // …and a real host that merely contains a placeholder substring is still not over-rejected.
  const legit = { ...good, findings: [{ ...good.findings[0], sourceUrl: "https://example.community/x" }] };
  assert.deepEqual(sandbox.researchProblems(legit), [], "example.community is a real host, even without URL");
});

test("researchProblems: placeholder and stub claims are rejected", () => {
  for (const claim of ["TODO", "TBD", "placeholder", "Lorem ipsum dolor sit", "Example claim here", "short"]) {
    const r = { ...good, findings: [{ ...good.findings[0], claim }] };
    assert.ok(researchProblems(r).length > 0, `claim ${JSON.stringify(claim)} must be rejected`);
  }
});

test("researchProblems: a placeholder marker is a placeholder wherever it appears in the claim", () => {
  // startsWith() only catches a marker at position 0. The unambiguous markers must match anywhere —
  // "This is a placeholder claim which must not be synthesized." was accepted as usable research.
  for (const claim of ["This is a placeholder claim which must not be synthesized.",
                       "The finding here is lorem ipsum dolor sit amet, consectetur.",
                       "Some example claim goes here, to be replaced with the real one."]) {
    const r = { ...good, findings: [{ ...good.findings[0], claim }] };
    assert.ok(researchProblems(r).length > 0, `claim ${JSON.stringify(claim)} must be rejected`);
  }
  // …but the SHORT tokens (todo/tbd/n-a) stay prefix-only, deliberately. Matched anywhere they would
  // reject perfectly good findings — "the vendor has not announced pricing; it is TBD" IS a research
  // result, and a claim about TODO comments is a claim. Over-rejecting real research to catch a
  // placeholder is the worse trade: the retry burns a model call and then FAILS the angle.
  for (const claim of ["Rust's todo!() macro panics at runtime rather than failing to compile.",
                       "The codebase carries 42 TODO comments, mostly in the parser module.",
                       "Cloudflare has not announced pricing for the tier; it remains TBD as of 2025."]) {
    const r = { ...good, findings: [{ ...good.findings[0], claim }] };
    assert.deepEqual(researchProblems(r), [], `claim ${JSON.stringify(claim)} is legitimate`);
  }
});

test("researchProblems: a citation needs a title and a date, not just a URL", () => {
  // RESEARCH_SCHEMA types these as strings; "" is a string. The workflow contract promises every claim
  // carries a URL + title + date, and the synthesis renders them — so an empty one is a broken citation.
  for (const over of [{ sourceTitle: "" }, { sourceDate: "" }, { sourceTitle: "   " }]) {
    const r = { ...good, findings: [{ ...good.findings[0], ...over }] };
    assert.ok(researchProblems(r).some((p) => /title|date/i.test(p)),
      `${JSON.stringify(over)} must be rejected`);
  }
});

test("researchProblems: a null/garbage result is rejected, not thrown on", () => {
  assert.ok(researchProblems(null).length > 0);
  assert.ok(researchProblems({}).length > 0);
  assert.ok(researchProblems({ findings: "not an array" }).length > 0);
});

test("researchProblems: a result must be BOUND to the angle it was dispatched for", () => {
  // `reports` emits research.angleId, while deps, failedAngles and meta all key off the DISPATCHED
  // angle.id. A worker that returns someone else's angleId therefore misattributes coverage: angle a2
  // appears answered twice, a1 is never answered, and nothing anywhere says so.
  const a1 = { id: "a1", kind: "core" };
  assert.deepEqual(researchProblems(good, a1), [], "the matching case still passes");
  const mismatch = researchProblems({ ...good, angleId: "a2" }, a1);
  assert.ok(mismatch.some((p) => /dispatched for/i.test(p)), "a foreign angleId must fail the angle");
  const wrongKind = researchProblems(good, { id: "a1", kind: "follow-up" });
  assert.ok(wrongKind.some((p) => /kind/i.test(p)));
});

test("depsSatisfied: an angle with no deps is always runnable", () => {
  assert.equal(depsSatisfied({ id: "b", deps: [] }, new Set()), true);
  assert.equal(depsSatisfied({ id: "b" }, new Set()), true);
});

test("depsSatisfied: an angle runs only when EVERY dep succeeded", () => {
  assert.equal(depsSatisfied({ id: "c", deps: ["a"] }, new Set(["a"])), true);
  assert.equal(depsSatisfied({ id: "c", deps: ["a", "b"] }, new Set(["a", "b"])), true);
  // The dep exists precisely because the angle is not well-posed without it. Running anyway means
  // researching a question built on a digest that is missing the thing it depended on.
  assert.equal(depsSatisfied({ id: "c", deps: ["a"] }, new Set()), false);
  assert.equal(depsSatisfied({ id: "c", deps: ["a", "b"] }, new Set(["a"])), false);
});

test("tallyMeta counts failures from the flag, not from truthiness", () => {
  const settled = [
    { angle: { id: "a" }, escalated: true },
    { angle: { id: "b" }, failed: true, reason: "unusable research" },
    { angle: { id: "c" }, failed: true, reason: "dep-failed: b" },
  ];
  const m = tallyMeta("deep", 2, settled);
  // A failure record is a TRUTHY OBJECT. Counting completions with filter(Boolean) reports
  // anglesFailed: 0 while failedAngles lists two — a meta block that contradicts itself.
  assert.equal(m.anglesCompleted, 1);
  assert.equal(m.anglesFailed, 2);
  assert.equal(m.escalations, 1);
});

const { shouldEscalate, validateArgs } = PURE;

test("shouldEscalate reads the field the verifier ACTUALLY returns", () => {
  // VERIFY_SCHEMA requires `overallReliability`. Reading `reliability` makes rank[undefined] undefined,
  // so the typeof guard fails and this returned false for EVERY input — tier-2 escalation has never
  // fired once, in any deep dive.
  const v = (overallReliability) => ({ angleId: "a", overallReliability, flags: [] });
  assert.equal(shouldEscalate(v("low"), "low"), true, "a LOW verifier at threshold low MUST escalate");
  assert.equal(shouldEscalate(v("medium"), "low"), false);
  assert.equal(shouldEscalate(v("medium"), "medium"), true);
  assert.equal(shouldEscalate(v("high"), "medium"), false);
  assert.equal(shouldEscalate(v("high"), "high"), true);
  assert.equal(shouldEscalate(null, "low"), false);
  assert.equal(shouldEscalate(v("garbage"), "low"), false, "an unknown reliability must not escalate");
});

test("validateArgs rejects a dependency graph the two-wave runner cannot honour", () => {
  const base = { topic: "t", mode: "deep", verify: { escalateOn: "low" } };
  const angle = (id, deps) => ({ id, question: "q", kind: "core", model: "sonnet", deps });

  assert.throws(() => validateArgs({ ...base, angles: [angle("a", []), angle("a", [])] }), /duplicate/i,
    "duplicate ids make okIds ambiguous");
  assert.throws(() => validateArgs({ ...base, angles: [angle("a", ["nope"])] }), /unknown dep|does not exist/i,
    "a dep on a nonexistent angle is unsatisfiable — it would be skipped forever, silently");
  assert.throws(() => validateArgs({ ...base, angles: [angle("a", ["a"])] }), /itself|self/i);

  // a -> b -> c is an ordinary-looking DAG that this scheduler CANNOT run. partitionWaves puts every
  // angle with deps into wave 2, and okIds only ever holds wave-1 successes — so c is reported
  // "dep-failed: b" even when b succeeded perfectly. A confident lie. Reject it at validation instead.
  assert.throws(
    () => validateArgs({ ...base, angles: [angle("a", []), angle("b", ["a"]), angle("c", ["b"])] }),
    /root|two waves|non-root/i,
    "a dep on a non-root angle needs a third wave, which does not exist",
  );

  // The valid shape — roots plus one dependent wave — still passes.
  assert.ok(validateArgs({ ...base, angles: [angle("a", []), angle("b", ["a"])] }));
  assert.ok(validateArgs({ ...base, angles: [angle("a", []), angle("b", []), angle("c", ["a", "b"])] }));
});
