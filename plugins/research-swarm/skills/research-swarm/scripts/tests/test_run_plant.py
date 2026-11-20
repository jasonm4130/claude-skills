import contextlib
import io
import json
import os
import random
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import ledger  # noqa: E402
import plant  # noqa: E402
import run  # noqa: E402

# Spawned git must not read the host's config (signing, hooks, identity).
os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
os.environ["GIT_CONFIG_SYSTEM"] = os.devnull


def quiet(fn, *a):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*a)


def git(cwd, *args):
    return subprocess.run(["git", "-C", cwd] + list(args), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True)


class RunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = os.path.realpath(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_layout_and_tag(self):
        root = os.path.join(self.d, "r1")
        msg = run.init(root)
        self.assertIn("phase/init", msg)
        for rel in ("run/board.md", "run/BRIEF.md", "run/DESIGN-BRIEF.md", "run/review/GATE-PROMPT.md",
                    "run/review/log.md", "run/ledger", "run/kb", "run-private/rubric.md"):
            self.assertTrue(os.path.exists(os.path.join(root, rel)), rel)
        mode = stat.S_IMODE(os.stat(os.path.join(root, "run-private")).st_mode)
        self.assertEqual(mode, 0o700)
        self.assertEqual(git(root, "remote").stdout.strip(), "")
        self.assertIn("phase/init", git(root, "tag").stdout)
        self.assertEqual(git(root, "status", "--porcelain").stdout.strip(), "")

    def test_init_refuses_nonempty_and_nested(self):
        root = os.path.join(self.d, "r2")
        run.init(root)
        with self.assertRaises(run.Refused):
            run.init(root)
        with self.assertRaises(run.Refused) as cm:
            run.init(os.path.join(root, "run", "inner"))
        self.assertIn("inside another git work tree", str(cm.exception))

    def test_phase_commits_tags_and_refuses_remote_dup_and_open_findings(self):
        root = os.path.join(self.d, "r3")
        run.init(root)
        with open(os.path.join(root, "run", "board.md"), "a") as f:
            f.write("### [TAKE] Q01 · inv-a · 10:00\n")
        self.assertIn("phase/research-1", run.phase(run.find_root(os.path.join(root, "run", "kb")), "research-1"))
        self.assertEqual(git(root, "status", "--porcelain").stdout.strip(), "")
        with open(os.path.join(root, "run", "state.md")) as f:
            self.assertIn("phase research-1 tagged", f.read())
        with self.assertRaises(run.Refused):
            run.phase(root, "research-1")
        with self.assertRaises(run.Refused):
            run.phase(root, "Bad Name")
        # open review finding blocks the phase
        with open(os.path.join(root, "run", "review", "log.md"), "a") as f:
            f.write("\n## Gate x\n### F1 · a.md:1\nx\nDisposition: TODO\n")
        with self.assertRaises(run.Refused) as cm:
            run.phase(root, "write")
        self.assertIn("undispositioned", str(cm.exception))
        log = os.path.join(root, "run", "review", "log.md")
        with open(log) as f:
            text = f.read()
        with open(log, "w") as f:
            f.write(text.replace("Disposition: TODO", "Disposition: ACCEPTED - fixed"))
        self.assertIn("phase/write", run.phase(root, "write"))
        # a remote blocks every later phase
        git(root, "remote", "add", "origin", "https://example.invalid/x.git")
        with self.assertRaises(run.Refused) as cm:
            run.phase(root, "final")
        self.assertIn("remote", str(cm.exception))

    def test_cli(self):
        root = os.path.join(self.d, "r4")
        self.assertEqual(quiet(run.main, ["init", root]), 0)
        self.assertEqual(quiet(run.main, ["init", root]), 1)
        self.assertEqual(quiet(run.main, ["phase", "outline", "--dir", root]), 0)
        self.assertEqual(quiet(run.main, ["status", "--dir", self.d]), 1)  # not a run dir
        self.assertEqual(quiet(run.main, []), 2)


DOC = """# Report

Agents that synthesise make errors in 47% of cases [S1].

Some prose without figures.

Fan-out of 5 researchers over 3 rounds cost $165 per run.

More prose here.

Released 2026-11-20 at 10:30, version 1.2.3, see https://ex.org/a/12 and Q07 [S12].

| col | 250 | 1,200 |
"""

PAGE = ("Intro sentence here for context only. Agents that summarise one document make few "
        "mistakes in practice. Agents that synthesise across many documents make far more mistakes "
        "overall. A closing sentence follows the finding here.")


class PlantTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_number_candidates_skip_protected_tokens(self):
        toks = [t for (_, _, t) in plant.number_candidates(DOC.split("\n"))]
        self.assertEqual(sorted(toks), sorted(["47", "5", "3", "165", "250", "1,200"]))

    def test_alter_number_is_plausible_and_different(self):
        rng = random.Random(4)
        for tok in ("47", "5", "3", "165", "1,200", "0.85", "99"):
            for _ in range(20):
                new = plant.alter_number(tok, rng, pct=(tok == "99"))
                self.assertNotEqual(new, tok)
                v, n = float(tok.replace(",", "")), float(new.replace(",", ""))
                self.assertLessEqual(abs(n - v), max(2, 0.26 * v), (tok, new))
                if tok == "99":
                    self.assertLessEqual(n, 100)

    def test_plant_preserves_line_count_and_records_key(self):
        out, plants = plant.plant(DOC, 3, random.Random(1), ["number"])
        self.assertEqual(len(plants), 3)
        self.assertEqual(out.count("\n"), DOC.count("\n"))
        a, b = DOC.split("\n"), out.split("\n")
        changed = [i + 1 for i in range(len(a)) if a[i] != b[i]]
        self.assertEqual(sorted(changed), sorted(p["line"] for p in plants))
        lines_planted = sorted(p["line"] for p in plants)
        self.assertTrue(all(y - x > 2 for x, y in zip(lines_planted, lines_planted[1:])))
        for p in plants:
            self.assertEqual(b[p["line"] - 1], p["planted_line"])
            self.assertNotIn("2026-11-20", p["original"])
        self.assertIn("1.2.3", out)
        self.assertIn("[S12]", out)

    def test_excerpt_swap_uses_neighbouring_sentence_from_cached_page(self):
        led = ledger.Ledger(os.path.join(self.d, "ledger", "sources.json"))
        p = os.path.join(self.d, "page.txt")
        with open(p, "w") as f:
            f.write(PAGE)
        e, _ = ledger.add(led, p, "Agents that synthesise across many documents make far more mistakes overall.")
        self.assertEqual(e["status"], "VERIFIED")
        board = ("### [FACT] Q01 · synthesis errs · inv-a · 10:00\nsource: [S1]\n"
                 "quote: \"Agents that synthesise across many documents make far more mistakes overall.\"\n"
                 "note: D1\n")
        out, plants = plant.plant(board, 1, random.Random(0), ["excerpt"], led.path)
        self.assertEqual(len(plants), 1)
        pl = plants[0]
        self.assertEqual(pl["kind"], "excerpt")
        self.assertEqual(pl["line"], 3)
        self.assertIn(pl["planted"], PAGE)
        self.assertNotEqual(pl["planted"], pl["original"])
        # the swapped quote is real text from the page, so the ledger check still passes
        problems, _ = ledger.check_board(led, out)
        self.assertEqual(problems, [])

    def test_score_matches_by_line_or_value_and_lists_hits(self):
        plants = [
            {"id": "P1", "kind": "number", "line": 3, "original": "47", "planted": "56"},
            {"id": "P2", "kind": "number", "line": 4, "original": "165", "planted": "198"},
            {"id": "P3", "kind": "excerpt", "line": 9, "original": "x" * 30,
             "planted": "Agents that summarise one document make few mistakes in practice."},
        ]
        findings = [
            {"n": 1, "text": "report.md:3 - 56% is wrong, source says 47%", "line": 3, "evidence": ""},
            {"n": 2, "text": "report.md:40 - unrelated", "line": 40, "evidence": ""},
            {"n": 3, "text": "quote mismatch", "line": None,
             "evidence": "agents that summarise one document make few mistakes in practice is about summarising"},
        ]
        results, hits = plant.score(findings, plants)
        self.assertEqual([r["caught_by"] for r in results], [[1], [], [3]])
        self.assertEqual(hits, [1, 3])
        # a finding that names no value credits only the nearest plant
        vague = [{"n": 1, "text": "report.md:4 - looks off", "line": 4, "evidence": ""}]
        results, _ = plant.score(vague, plants)
        self.assertEqual([r["caught_by"] for r in results], [[], [1], []])

    def test_cli_plant_and_score(self):
        src = os.path.join(self.d, "doc.md")
        out = os.path.join(self.d, "doc.planted.md")
        key = os.path.join(self.d, "run-private", "planted.json")
        with open(src, "w") as f:
            f.write(DOC)
        self.assertEqual(quiet(plant.main, ["plant", src, "--out", out, "--private", key,
                                            "--n", "2", "--seed", "7", "--kinds", "number"]), 0)
        with open(key) as f:
            k = json.load(f)
        self.assertEqual(len(k["plants"]), 2)
        line = k["plants"][0]["line"]
        fnd = os.path.join(self.d, "findings.md")
        with open(fnd, "w") as f:
            f.write("VERDICT: REJECT\n\n1. doc.md:%d - number does not match source\n" % line)
        self.assertEqual(quiet(plant.main, ["score", fnd, "--private", key]), 0)
        with open(key) as f:
            k = json.load(f)
        self.assertEqual(k["scores"][-1]["caught"], 1)
        self.assertEqual(k["scores"][-1]["total"], 2)
        empty = os.path.join(self.d, "empty.md")
        with open(empty, "w") as f:
            f.write("nothing numeric here\n")
        self.assertEqual(quiet(plant.main, ["plant", empty, "--out", out, "--private", key]), 1)


if __name__ == "__main__":
    unittest.main()
