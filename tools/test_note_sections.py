import unittest

from normalize_note_sections import headings, normalize, prose_lines


class NoteSectionsTest(unittest.TestCase):
    def test_long_notes_and_personal_child(self):
        text = '---\ntitle: A\n---\n> 原文 PDF\n## 整体综述\n综述\n## Notes\n### 方法\n方法 $x$\n```md\n## 代码里的标题\n```\n### 我的理解与问题\n个人思考\n## 路径\n[[Other]]\n'
        result = normalize(text)
        self.assertEqual([h['title'] for h in headings(result) if h['level'] == 2], ['整体综述', '论文细节', '阅读随记', '路径'])
        personal = result.split('## 阅读随记')[1].split('## 路径')[0]
        self.assertIn('个人思考', personal)
        self.assertNotIn('方法 $x$', personal)
        self.assertIn('```md\n## 代码里的标题\n```', result)
        self.assertEqual(prose_lines(text), prose_lines(result))
        self.assertEqual(normalize(result), result)

    def test_no_personal_notes_remains_empty(self):
        text = '---\nreading: 已读\n---\n## 整体综述\n概括\n## 方法\n方法\n### 细节\n数字 10\n## 路径\n导航\n'
        result = normalize(text)
        self.assertIn('### 方法\n方法\n#### 细节', result)
        self.assertFalse(result.split('## 阅读随记')[1].split('## 路径')[0].strip())
        self.assertTrue(result.startswith('---\nreading: 已读\n---\n'))

    def test_top_level_personal_sections_are_preserved(self):
        text = '---\ntitle: A\n---\n## 整体概括\n概括\n## 实验\n证据\n## 我的批注与研究问题\n问题\n## 个人理解\n判断\n'
        result = normalize(text)
        self.assertIn('### 我的批注与研究问题\n问题', result)
        self.assertIn('判断', result.split('## 阅读随记')[1])
        self.assertEqual(prose_lines(text), prose_lines(result))

    def test_crlf_and_rich_markdown(self):
        text = '---\r\ntitle: A\r\n---\r\n## 整体综述\r\n概述\r\n## 方法\r\n| A | B |\r\n|---|---|\r\n$$\r\nx=1\r\n$$\r\n![图](image.png)\r\n## Notes\r\n旧记录\r\n'
        result = normalize(text)
        self.assertEqual(prose_lines(text), prose_lines(result))
        self.assertNotIn('\n', result.replace('\r\n', ''))
        self.assertIn('### Notes\r\n旧记录', result)

    def test_reject_invalid_frontmatter_or_heading_depth(self):
        with self.assertRaises(ValueError):
            normalize('## 方法\n没有属性\n')
        with self.assertRaises(ValueError):
            normalize('---\ntitle: A\n---\n## 方法\n###### 六级标题\n正文\n')


if __name__ == '__main__':
    unittest.main()
