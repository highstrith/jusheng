"""Unit tests for the discovery scanner's pure helpers (no network, no browser)."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import importlib.util  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    'framepick_discovery_scan',
    Path(__file__).resolve().parents[1] / 'scripts' / 'framepick-discovery-scan.py',
)
scan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan)


class Duration(unittest.TestCase):
    def test_parses_minutes_and_hours(self):
        self.assertEqual(scan.to_seconds('07:45'), 465)
        self.assertEqual(scan.to_seconds('1:02:03'), 3723)
        self.assertEqual(scan.to_seconds(750), 750)

    def test_rejects_nonsense(self):
        for value in ['', None, '待核实', '12', '1:2', 0, -5]:
            self.assertIsNone(scan.to_seconds(value), value)

    def test_normalises_runtime_text(self):
        self.assertEqual(scan.to_runtime('465'), '07:45')
        self.assertEqual(scan.to_runtime('3723'), '1:02:03')
        self.assertEqual(scan.to_runtime('bad'), '')


class Evidence(unittest.TestCase):
    def test_word_boundary_avoids_false_positives(self):
        proved, _ = scan.ai_evidence('他说 wait a moment，email 稍后回', '')
        self.assertFalse(proved, 'said/wait/email 里的 ai 不能当证据')

    def test_accepts_explicit_production_statement(self):
        for text in ['本片由 AI 生成', 'AIGC 短片', '用 可灵 制作', 'AI短片《雨城撤离》']:
            proved, note = scan.ai_evidence(text, '')
            self.assertTrue(proved, text)
            self.assertIn('原页出现', note)

    def test_tags_count_as_uploader_metadata(self):
        proved, _ = scan.ai_evidence('一部短片', 'AIGC,AI动画')
        self.assertTrue(proved)


class Candidate(unittest.TestCase):
    def item(self, **overrides):
        base = {
            'bvid': 'BV1xx411c7mD', 'title': '<em class="keyword">AI</em> 短片《测试》',
            'author': '测试作者', 'duration': '12:30', 'play': 1024,
            'description': '本片由 AI 生成，讲述一次远行。', 'tag': 'AIGC,科幻',
            'pubdate': 1793600000,
        }
        base.update(overrides)
        return base

    def test_maps_api_fields(self):
        candidate = scan.build_candidate(self.item(), 'AI 短片')
        self.assertEqual(candidate['title'], 'AI 短片《测试》')
        self.assertEqual(candidate['url'], 'https://www.bilibili.com/video/BV1xx411c7mD')
        self.assertEqual(candidate['runtime'], '12:30')
        self.assertEqual(candidate['source'], 'bilibili')
        self.assertTrue(candidate['aiEvidence'])
        self.assertEqual(candidate['popularity'], {'metric': '播放', 'value': '1024'})
        self.assertIn('AI 短片', candidate['note'])

    def test_missing_identity_or_duration_is_dropped(self):
        self.assertIsNone(scan.build_candidate(self.item(bvid='')))
        self.assertIsNone(scan.build_candidate(self.item(author='')))
        self.assertIsNone(scan.build_candidate(self.item(duration='')))

    def test_output_feeds_the_screening_cli(self):
        """The JSON must carry the fields the Node screener reads."""
        candidate = scan.build_candidate(self.item())
        for key in ['title', 'author', 'source', 'url', 'runtime', 'aiEvidence', 'aiEvidenceNote', 'evidence']:
            self.assertIn(key, candidate)
        self.assertIsInstance(json.dumps(candidate, ensure_ascii=False), str)


if __name__ == '__main__':
    unittest.main()
