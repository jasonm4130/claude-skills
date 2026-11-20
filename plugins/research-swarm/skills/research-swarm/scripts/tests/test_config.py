import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import run  # noqa: E402
import swarmconfig as sc  # noqa: E402
import watch  # noqa: E402

os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
os.environ["GIT_CONFIG_SYSTEM"] = os.devnull


def cli(fn, *a):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn(list(a))
    return code, out.getvalue() + err.getvalue()


class PresetTest(unittest.TestCase):
    def test_presets(self):
        expect = {"small": (3, 1, 2, ["codex"]), "medium": (6, 2, 3, ["codex"]),
                  "large": (12, 3, 3, ["codex", "grok"])}
        for size, (rmax, rounds, designers, reviewers) in expect.items():
            c = sc.make(size)
            self.assertEqual((c["researchers_max"], c["rounds"], c["designers"], c["reviewers"]),
                             (rmax, rounds, designers, reviewers), size)
            self.assertEqual(c["size"], size)
        with self.assertRaises(sc.ConfigError):
            sc.make("huge")

    def test_researchers_follow_angles_bounded_by_max(self):
        c = sc.make("medium")
        self.assertEqual(sc.researchers(c), 6)  # no angles yet: the max
        c["angles"] = ["a", "b", "c", "d"]
        self.assertEqual(sc.researchers(c), 4)
        c["angles"] = list("abcdefghij")
        self.assertEqual(sc.researchers(c), 6)
        sc.set_key(c, "researchers", 2)  # scale down for the next round
        self.assertEqual(sc.researchers(c), 2)
        self.assertEqual(sc.researchers(sc.make("large", {"angles": list("abcdefghij")})), 10)

    def test_verifiers_scale_with_claims(self):
        c = sc.make("small")
        self.assertEqual([sc.verifiers(c, n) for n in (0, 1, 10, 11, 40)], [1, 1, 1, 2, 4])

    def test_reviewers_add_grok_on_request(self):
        c = sc.make("medium")
        self.assertEqual(sc.reviewers(c), ["codex"])
        self.assertEqual(sc.reviewers(c, user_asked_grok=True), ["codex", "grok"])
        self.assertEqual(sc.reviewers(sc.make("large"), True), ["codex", "grok"])

    def test_overrides_and_validation(self):
        sets = sc.parse_sets(["researchers_max=8", 'reviewers=["grok"]', "budget.stop_points=10", "time_box_min=40"])
        c = sc.make("small", sets)
        self.assertEqual(c["researchers_max"], 8)
        self.assertEqual(c["reviewers"], ["grok"])
        self.assertEqual(c["budget"]["stop_points"], 10)
        self.assertEqual(c["rounds"], 1)  # untouched preset value
        for bad in (["nope=1"], ["rounds=0"], ["rounds=two"], ["reviewers=[]"], ["budget.x=1"], ["novalue"]):
            with self.assertRaises(sc.ConfigError, msg=bad):
                sc.make("small", sc.parse_sets(bad))


class BudgetTest(unittest.TestCase):
    def test_budget_math(self):
        b = sc.budget(41, stop_points=20, ceiling_pct=85, points_per_agent_hour=0.6, hours=3, agents=6)
        self.assertEqual(b["limit_pct"], 61)
        self.assertEqual(b["remaining"], 20)
        self.assertEqual(b["max_agents"], 11)       # 20 / (0.6 * 3) = 11.1
        self.assertEqual(b["hours_left"], 5.56)     # 20 / (0.6 * 6)
        self.assertFalse(b["stop"])

    def test_ceiling_wins_and_stop(self):
        b = sc.budget(75, now_pct=80, stop_points=20, ceiling_pct=85, hours=2)
        self.assertEqual(b["limit_pct"], 85)
        self.assertEqual(b["remaining"], 5)
        self.assertEqual(b["max_agents"], 4)        # 5 / (0.6 * 2)
        s = sc.budget(41, now_pct=62)
        self.assertTrue(s["stop"])
        self.assertEqual(sc.budget(41, now_pct=62, hours=1)["max_agents"], 0)

    def test_budget_needs_start(self):
        with self.assertRaises(sc.ConfigError):
            sc.budget(None)
        with self.assertRaises(sc.ConfigError):
            sc.budget(10, points_per_agent_hour=0)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(os.path.realpath(self.tmp.name), "r")

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_writes_config_and_cli_round_trip(self):
        code, out = cli(run.main, "init", self.root, "--size", "small", "--set", "researchers_max=4")
        self.assertEqual(code, 0, out)
        self.assertIn("researchers 4 (max 4, 0 angles)", out)
        path = os.path.join(self.root, "run", "swarm.json")
        with open(path) as f:
            self.assertEqual(json.load(f)["size"], "small")
        code, _ = cli(run.main, "config", "--dir", self.root, "--set", 'angles=["x","y"]', "--set", "budget.start_pct=41")
        self.assertEqual(code, 0)
        code, out = cli(run.main, "size", "--dir", self.root, "--claims", "25", "--grok")
        self.assertIn("researchers 2 (max 4, 2 angles)", out)
        self.assertIn("verifiers 3 for 25 claims", out)
        self.assertIn("reviewers codex+grok", out)
        self.assertEqual(cli(run.main, "roster", "inv-a", "--start", "10:00", "--dir", self.root)[0], 0)
        self.assertEqual(cli(run.main, "roster", "inv-a", "--dir", self.root)[0], 1)
        # watch reads the roster from swarm.json
        board = os.path.join(self.root, "run", "board.md")
        code, out = cli(watch.main, board, path, "--now", "10:30")
        self.assertEqual(code, 1)
        self.assertIn("IDLE inv-a: no entry, started 30 min ago", out)
        # budget reads start_pct from the config
        code, out = cli(run.main, "budget", "--dir", self.root, "--now", "50", "--hours", "2", "--agents", "3")
        self.assertEqual(code, 0, out)
        self.assertIn("stop at 61", out)
        self.assertIn("max concurrent agents for 2.0h: 9", out)
        code, out = cli(run.main, "budget", "--start", "70", "--now", "86")
        self.assertEqual(code, 1)
        self.assertIn("STOP", out)
        self.assertEqual(cli(run.main, "budget")[0], 2)  # no start reading
        self.assertEqual(cli(run.main, "config", "--dir", self.root, "--set", "rounds=0")[0], 2)
        self.assertEqual(cli(run.main, "init", os.path.join(self.root + "2"), "--set", "bogus=1")[0], 1)


if __name__ == "__main__":
    unittest.main()
