import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import ledger  # noqa: E402
import swarmlib  # noqa: E402

PAGE = (b"<html><body><h1>Title</h1><p>Agents that summarise one document make "
        b"few mistakes (0.9&ndash;6.4%). Agents that <b>synth</b>esise across many "
        b"documents make 47&#8211;71% &amp; more.</p><p>It&#8217;s &quot;fine&quot;, "
        b"they said.</p><script>var x = 'Agents that hide';</script></body></html>")


class FakeWeb(object):
    def __init__(self, pages):
        self.pages = pages
        self.calls = 0

    def __call__(self, url, timeout=20):
        self.calls += 1
        if url not in self.pages:
            raise OSError("HTTP Error 404: Not Found")
        body = self.pages[url]
        return body, ("application/pdf" if body.startswith(b"%PDF-") else "text/html; charset=utf-8")


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.led = ledger.Ledger(os.path.join(self.d, "ledger", "sources.json"))
        self.web = FakeWeb({"https://ex.org/a": PAGE, "https://ex.org/pdf": b"%PDF-1.7 ..."})
        self.orig = ledger.http_fetch
        ledger.http_fetch = self.web

    def tearDown(self):
        ledger.http_fetch = self.orig
        self.tmp.cleanup()

    def write(self, name, text):
        p = os.path.join(self.d, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    # ---- normalisation
    def test_normalise_handles_escapes_entities_quotes_dashes(self):
        a = swarmlib.normalise("It\\'s \\*not\\* a \u201cfalse\u201d positive \u2013 0.9\u20136.4\\%")
        b = swarmlib.normalise("It&#8217;s *not* a &quot;false&quot; positive - 0.9-6.4%")
        self.assertEqual(a, b)

    def test_ellipsis_pieces_must_be_in_order(self):
        hay = swarmlib.normalise("alpha beta gamma delta epsilon")
        self.assertTrue(swarmlib.excerpt_in("alpha beta ... delta", hay))
        self.assertTrue(swarmlib.excerpt_in("alpha beta \u2026 delta", hay))
        self.assertFalse(swarmlib.excerpt_in("delta ... alpha", hay))

    # ---- add
    def test_add_web_verified_through_inline_tags_and_entities(self):
        e, new = ledger.add(self.led, "https://ex.org/a",
                            "Agents that synthesise across many documents make 47\u201371% & more.")
        self.assertTrue(new)
        self.assertEqual(e["id"], "S1")
        self.assertEqual(e["status"], "VERIFIED", e["reason"])
        self.assertEqual(len(e["sha256"]), 64)
        self.assertTrue(e["fetched_at"])
        self.assertIsNotNone(self.led.page_text("S1"))

    def test_markdown_escaped_excerpt_verifies(self):
        e, _ = ledger.add(self.led, "https://ex.org/a", "few mistakes \\(0.9\u20136.4\\%\\). Agents that synthesise")
        self.assertEqual(e["status"], "VERIFIED", e["reason"])

    def test_script_text_is_not_matched(self):
        e, _ = ledger.add(self.led, "https://ex.org/a", "var x = Agents that hide in scripts")
        self.assertEqual(e["status"], "UNVERIFIED")

    def test_add_web_unverified_when_excerpt_absent(self):
        e, _ = ledger.add(self.led, "https://ex.org/a", "Agents that summarise make 12% mistakes overall")
        self.assertEqual(e["status"], "UNVERIFIED")
        self.assertIn("not found", e["reason"])

    def test_short_web_excerpt_is_unverified(self):
        e, _ = ledger.add(self.led, "https://ex.org/a", "few mistakes")
        self.assertEqual(e["status"], "UNVERIFIED")
        self.assertIn("shorter", e["reason"])

    def test_nofetch_and_pdf(self):
        e, _ = ledger.add(self.led, "https://ex.org/missing", "anything at all goes here ok")
        self.assertEqual(e["status"], "NOFETCH")
        self.assertIn("404", e["reason"])
        p, _ = ledger.add(self.led, "https://ex.org/pdf", "anything at all goes here ok")
        self.assertEqual(p["status"], "UNVERIFIED")
        self.assertIn("pdf", p["reason"])

    def test_duplicate_add_returns_existing_without_refetch(self):
        ledger.add(self.led, "https://ex.org/a", "It's \"fine\", they said.")
        calls = self.web.calls
        e, new = ledger.add(self.led, "https://ex.org/a", "It's \"fine\", they said.")
        self.assertFalse(new)
        self.assertEqual(e["id"], "S1")
        self.assertEqual(self.web.calls, calls)

    def test_local_file_with_line_range_only_matches_inside_range(self):
        p = self.write("t.txt", "line one here\nline two says 37 9\nline three\n")
        e, _ = ledger.add(self.led, p + ":2-2", "37 9")
        self.assertEqual(e["status"], "VERIFIED")
        self.assertEqual(e["lines"], [2, 2])
        e2, _ = ledger.add(self.led, p + ":3", "line one here")
        self.assertEqual(e2["status"], "UNVERIFIED")

    def test_file_url_with_fragment_range(self):
        p = self.write("t2.txt", "a\nb\nthe quote is here\n")
        e, _ = ledger.add(self.led, "file://" + p + "#L3-L3", "the quote is here")
        self.assertEqual(e["status"], "VERIFIED")
        self.assertEqual(e["lines"], [3, 3])

    def test_missing_local_file_is_nofetch(self):
        e, _ = ledger.add(self.led, os.path.join(self.d, "nope.txt"), "x")
        self.assertEqual(e["status"], "NOFETCH")

    def test_concurrent_adds_get_unique_ids(self):
        p = self.write("c.txt", "\n".join("row %d" % i for i in range(40)))
        errs = []

        def worker(k):
            try:
                ledger.add(self.led, p, "row %d" % k)
            except Exception as ex:  # pragma: no cover
                errs.append(ex)

        ts = [threading.Thread(target=worker, args=(k,)) for k in range(12)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errs, [])
        ids = [s["id"] for s in self.led.load()["sources"]]
        self.assertEqual(len(ids), 12)
        self.assertEqual(len(set(ids)), 12)

    # ---- check
    def board_with_sources(self):
        good, _ = ledger.add(self.led, "https://ex.org/a", "Agents that summarise one document make few mistakes")
        bad, _ = ledger.add(self.led, "https://ex.org/a", "this sentence is not on the page at all")
        return good["id"], bad["id"]

    def test_check_passes_clean_board(self):
        g, _ = self.board_with_sources()
        board = (
            "# Board\n### [TAKE] Q01 · inv-a · 10:00\n"
            "### [FACT] Q01 · summarisers are accurate · inv-a · 10:05\n"
            "source: [%s] https://ex.org/a\nquote: \"Agents that summarise one document make few mistakes\"\n"
            "note: D1\n### [CLAIM] Q01 · scope · inv-a · 10:06\nsource: [%s]\nnote: x\n"
            "### [OPEN] Q09 · new · inv-a · 10:07\nnote: y\n" % (g, g))
        problems, counts = ledger.check_board(self.led, board)
        self.assertEqual(problems, [])
        self.assertEqual(counts["by_type"], {"TAKE": 1, "FACT": 1, "CLAIM": 1, "OPEN": 1})
        self.assertEqual(counts["cites"]["VERIFIED"], 2)

    def test_check_fails_missing_unverified_and_unknown_ids(self):
        g, b = self.board_with_sources()
        board = (
            "### [FACT] Q01 · no id · inv-a · 10:05\nsource: https://ex.org/a\nquote: \"x\"\n"
            "### [MEASURE] Q01 · unverified · inv-a · 10:06\nsource: [%s]\n"
            "### [CLAIM] Q01 · unknown · inv-a · 10:07\nsource: [S99]\n"
            "### [FACT] · no qid · inv-a · 10:08\nsource: [%s]\n" % (b, g))
        problems, counts = ledger.check_board(self.led, board)
        text = "\n".join(problems)
        self.assertIn("no ledger id", text)
        self.assertIn("status UNVERIFIED", text)
        self.assertIn("S99, which is not in the ledger", text)
        self.assertIn("needs a question id", text)
        self.assertEqual(counts["cites"]["MISSING"], 1)

    def test_check_flags_quote_not_on_cited_page(self):
        g, _ = self.board_with_sources()
        board = ("### [FACT] Q01 · t · inv-a · 10:05\nsource: [%s]\n"
                 "quote: \"Agents make no mistakes whatsoever ever\"\n" % g)
        problems, _ = ledger.check_board(self.led, board)
        self.assertTrue(any("quote is not in the fetched text" in p for p in problems), problems)

    def test_cli_check_exit_codes(self):
        g, b = self.board_with_sources()
        ok = self.write("ok.md", "### [FACT] Q01 · t · inv-a · 10:05\nsource: [%s]\n" % g)
        bad = self.write("bad.md", "### [FACT] Q01 · t · inv-a · 10:05\nsource: [%s]\n" % b)
        def cli(*a):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return ledger.main(["--ledger", self.led.path] + list(a))
        self.assertEqual(cli("check", ok), 0)
        self.assertEqual(cli("check", bad), 1)
        self.assertEqual(cli("check", os.path.join(self.d, "none.md")), 2)
        self.assertEqual(cli("gate", ok), 0)
        self.assertEqual(cli("gate", bad), 1)

    # ---- gate
    def test_gate_doc(self):
        g, b = self.board_with_sources()
        doc_ok = ("# Report\nSummarisers err rarely [K1] [%s].\n"
                  "A line with 12 numbers but no claim tag passes.\n"
                  "Background claim with no number [K2].\n"
                  "See https://ex.org/a/2026/11 [K3].\n" % g)
        problems, cited = ledger.gate_doc(self.led, doc_ok)
        self.assertEqual(problems, [])
        self.assertEqual(cited, 1)
        doc_bad = ("Error rate is 47%% [K1].\n"
                   "Uses an unverified source [%s].\n"
                   "Cites a ghost [S42].\n" % b)
        problems, _ = ledger.gate_doc(self.led, doc_bad)
        self.assertEqual(len(problems), 3, problems)
        self.assertIn("numeric key-claim line", problems[0])

    def test_template_brief_examples_parse(self):
        tpl = os.path.join(os.path.dirname(os.path.dirname(HERE)), "templates", "BRIEF.md")
        with open(tpl, encoding="utf-8") as f:
            text = f.read()
        block = text.split("```", 2)[1]
        entries = swarmlib.parse_board(block)
        self.assertEqual([e.type for e in entries], ["TAKE", "FACT", "MEASURE", "FAIL", "CLAIM", "OPEN"])
        for e in entries:
            self.assertEqual(e.problems(), [], e.body)
            self.assertEqual(e.agent, "inv-a")
        self.assertEqual(entries[1].cites, ["S3"])
        self.assertEqual(entries[4].cites, ["S3", "S4"])

    def test_ledger_file_is_valid_json_after_writes(self):
        self.board_with_sources()
        with open(self.led.path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual([s["id"] for s in data["sources"]], ["S1", "S2"])


if __name__ == "__main__":
    unittest.main()
