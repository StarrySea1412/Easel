"""Ranking quality checks use isolated synthetic writing/coding memories."""
from easel.memory_retrieval import rank


def entry(key, text):
    return {'id': key, 'text': text}


def test_normalizes_width_case_and_spacing_without_semantic_claims():
    rows = rank([entry('a', 'Use GPT responses for streaming')], 'ＧＰＴ ＲＥＳＰＯＮＳＥＳ')
    assert rows[0][0]['id'] == 'a' and rows[0][2] == 2
    assert not rank([entry('a', '封面先展示成品')], 'unrelated cooking')
    assert not rank([entry('a', '封面先展示成品')], '!!!')


def test_relevant_short_entry_beats_keyword_stuffed_long_entry():
    concise = entry('z', '封面标题要短')
    stuffed = entry('a', '封面标题 ' + '背景资料 ' * 400)
    assert rank([stuffed, concise], '封面标题')[0][0] == concise


def test_rare_query_term_beats_more_common_overlap():
    rows = [entry('a', '摄影教程 灯光配置'), entry('z', '摄影教程 逆光')]
    rows.extend(entry(str(i), '摄影教程 灯光配置 普通参考') for i in range(10))
    assert rank(rows, '摄影教程 灯光配置 逆光')[0][0]['id'] == 'z'


def test_empty_query_and_tied_scores_are_stable():
    rows = [entry('b', '摄影教程'), entry('a', '摄影教程')]
    for query in ('', '  ', '摄影'):
        assert [row[0]['id'] for row in rank(rows, query)] == ['a', 'b']
        assert rank(rows, query) == rank(list(reversed(rows)), query)
