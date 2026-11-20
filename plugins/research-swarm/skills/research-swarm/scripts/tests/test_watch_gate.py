import contextlib
import io
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import gate  # noqa: E402
import watch  # noqa: E402

BOARD = """# Board
### [TAKE] Q01 · inv-a · 10:00
### [TAKE] Q02 · inv-b · 10:01
### [TAKE] Q02 · inv-c · 10:02
### [TAKE] Q03 · inv-c · 10:02
### [FACT] Q01 · found · inv-a · 10:10
source: [S1]
### [FAIL] Q02 · dropping, inv-b was first · inv-c · 10:03
### [FACT] Q03 · wrong agent delivers · inv-b · 10:20
source: [S2]
"""


def quiet(fn, *a):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*a)


class WatchTest(unittest.TestCase):
    def test_idle_and_undelivered(self):
        roster = watch.read_roster("inv-a 09:58\ninv-b\ninv-c 09:59  # comment\ninv-d 10:25\n# x\n")
        idle, undel = watch.scan(BOARD, roster, "10:30", 10, 20)
        text = "\n".join(idle + undel)
        self.assertIn("IDLE inv-a: last entry 20 min ago", text)
        self.assertNotIn("IDLE inv-b", text)  # last entry 10:20
        self.assertIn("IDLE inv-c: last entry 27 min ago", text)
        self.assertNotIn("inv-d", text)  # started 5 min ago, no entry yet
        # Q01 delivered; Q02 first TAKE is inv-b, never delivered by inv-b; Q03 delivered by someone else only
        self.assertNotIn("UNDELIVERED Q01", text)
        self.assertIn("UNDELIVERED Q02: taken by inv-b", text)
        self.assertIn("UNDELIVERED Q03: taken by inv-c", text)

    def test_agent_with_no_start_and_no_entry(self):
        idle, _ = watch.scan(BOARD, [("ghost", None)], "10:05", 10, 20)
        self.assertEqual(idle, ["IDLE ghost: no entry and no start time in roster"])

    def test_midnight_wrap(self):
        board = "### [TAKE] Q01 · inv-a · 23:55\n"
        idle, undel = watch.scan(board, [("inv-a", None)], "00:10", 10, 20)
        self.assertEqual(idle, ["IDLE inv-a: last entry 15 min ago"])
        self.assertEqual(undel, [])

    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            b = os.path.join(d, "board.md")
            r = os.path.join(d, "roster.txt")
            with open(b, "w") as f:
                f.write(BOARD)
            with open(r, "w") as f:
                f.write("inv-b 10:00\n")
            self.assertEqual(quiet(watch.main, [b, r, "--now", "10:25", "--undelivered", "60"]), 0)
            self.assertEqual(quiet(watch.main, [b, r, "--now", "10:45"]), 1)
            self.assertEqual(quiet(watch.main, [b, r, "--now", "25:00"]), 2)
            self.assertEqual(quiet(watch.main, [b, os.path.join(d, "none"), "--now", "10:00"]), 2)


REJECT = """Some preamble the model wrote.

VERDICT: REJECT

1. run/out/report.md:14 - the 47% figure is 47-71% in the source
   evidence: "make 47-71%" in run/ledger/pages/S2.txt
2. run/out/report.md:30 - decision D2 does not follow from K4
evidence: K4 is about latency, not cost
"""

PASS = "VERDICT: PASS\n\n1. run/out/report.md:3 - typo in heading\n"


class GateTest(unittest.TestCase):
    def test_parse_reject(self):
        v, f, err = gate.parse_reply(REJECT)
        self.assertIsNone(err)
        self.assertEqual(v, "REJECT")
        self.assertEqual([x["n"] for x in f], [1, 2])
        self.assertEqual((f[0]["file"], f[0]["line"]), ("run/out/report.md", 14))
        self.assertIn("make 47-71%", f[0]["evidence"])
        self.assertIn("latency", f[1]["evidence"])

    def test_numbered_preamble_is_not_a_finding(self):
        text = "I checked:\n1. the ledger\n2. the outline\n\nVERDICT: REJECT\n\n1. doc.md:4 - wrong number\n"
        v, f, _ = gate.parse_reply(text)
        self.assertEqual(v, "REJECT")
        self.assertEqual([(x["n"], x["line"]) for x in f], [(1, 4)])

    def test_parse_pass_with_minor_findings(self):
        v, f, _ = gate.parse_reply(PASS)
        self.assertEqual(v, "PASS")
        self.assertEqual(len(f), 1)

    def test_unparseable_cases(self):
        for text in ("no verdict here\n1. a.md:1 - x\n",
                     "VERDICT: PASS|REJECT\n",           # echoed template
                     "VERDICT: PASS\nVERDICT: REJECT\n1. a.md:1 - x\n",
                     "VERDICT: REJECT\nno findings at all\n",
                     "verdict: pass\n"):
            v, _, err = gate.parse_reply(text)
            self.assertIsNone(v, text)
            self.assertTrue(err)

    def test_log_and_check_log_flow(self):
        with tempfile.TemporaryDirectory() as d:
            reply = os.path.join(d, "reply.md")
            log = os.path.join(d, "review", "log.md")
            with open(reply, "w") as f:
                f.write(REJECT)
            self.assertEqual(quiet(gate.main, ["parse", reply, "--log", log, "--reviewer", "codex"]), 1)
            with open(log) as f:
                text = f.read()
            self.assertEqual(text.count("Disposition: TODO"), 2)
            self.assertIn("· codex · REJECT ·", text)
            self.assertEqual(len(gate.open_findings(text)), 2)
            self.assertEqual(quiet(gate.main, ["check-log", log]), 1)

            text = text.replace("Disposition: TODO", "Disposition: ACCEPTED - fixed the range", 1)
            text = text.replace("Disposition: TODO", "Disposition: REJECTED", 1)
            probs = gate.open_findings(text)
            self.assertEqual(len(probs), 1)
            self.assertIn("needs a reason", probs[0])
            text = text.replace("Disposition: REJECTED", "Disposition: REJECTED - K4 covers both, see S7")
            self.assertEqual(gate.open_findings(text), [])
            with open(log, "w") as f:
                f.write(text)
            self.assertEqual(quiet(gate.main, ["check-log", log]), 0)

    def test_missing_disposition_and_plant(self):
        log = "## Gate x\n\n### F1 · a.md:1\ntext\n### F2 · a.md:2\nDisposition: PLANT\n### F3 · a.md:3\nDisposition: maybe\n"
        probs = gate.open_findings(log)
        self.assertEqual(len(probs), 2)
        self.assertIn("F1", probs[0])
        self.assertIn("F3", probs[1])

    def test_parse_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "r.md")
            for text, code in ((PASS, 0), (REJECT, 1), ("nothing", gate.UNPARSEABLE)):
                with open(p, "w") as f:
                    f.write(text)
                self.assertEqual(quiet(gate.main, ["parse", p]), code)


if __name__ == "__main__":
    unittest.main()
