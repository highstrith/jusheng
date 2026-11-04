"""Render the evidence-led report and reproduce every scenario calculation."""
import csv
import html
import json
import re
from decimal import Decimal, ROUND_CEILING
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PDF = ROOT / 'output/pdf/framepick-market-feasibility-20261102.pdf'
DATA = json.loads((HERE / 'report-data.json').read_text())
SOURCES = {source['id']: source for source in DATA['sources']}
D = lambda value: Decimal(str(value))
BASE = {'refund': D('.03'), 'creator': D('.70'), 'fee': D('.006'), 'media': D('.20'), 'ops': D('.10'), 'partner': D('0')}


def contribution(price, **overrides):
    p = D(price)
    a = {**BASE, **{key: D(value) for key, value in overrides.items()}}
    net = p * (1 - a['refund'])
    return net * (1 - a['creator'] - a['partner']) - p * a['fee'] - a['media'] - a['ops']


def ceiling(value):
    return int(value.to_integral_value(rounding=ROUND_CEILING))


def money(value):
    return f'{value:.3f}'


def model_tables():
    unit = {
        'headers': ['每初始订单均值（元）', '3元票', '5元票'],
        'rows': [], 'widths': [.54, .23, .23]
    }
    rows = [
        ('初始票价', lambda p: p),
        ('扣3%退款后的成交额', lambda p: p * D('.97')),
        ('其中创作者70%预期分成', lambda p: p * D('.97') * D('.70')),
        ('平台分配余额（未扣成本）', lambda p: p * D('.97') * D('.30')),
        ('支付费用假设', lambda p: p * D('.006')),
        ('媒资成本假设', lambda p: D('.20')),
        ('变动客服与履约假设', lambda p: D('.10')),
        ('贡献余额C（非净利润）', lambda p: contribution(p)),
    ]
    for title, fn in rows:
        unit['rows'].append([title, money(fn(D(3))), money(fn(D(5)))])
    sensitivity = {'headers': ['场景（均为假设）', '3元贡献', '5元贡献'], 'rows': [], 'widths': [.54, .23, .23]}
    scenarios = [
        ('基础：作者70%', {}),
        ('作者80%，其他不变', {'creator': '.80'}),
        ('作者70%＋合作方10%', {'partner': '.10'}),
        ('作者80%＋合作方10%', {'creator': '.80', 'partner': '.10'}),
        ('媒资成本升至0.60元', {'media': '.60'}),
    ]
    csv_rows = []
    for title, overrides in scenarios:
        sensitivity['rows'].append([title, money(contribution(3, **overrides)), money(contribution(5, **overrides))])
        for price in [3, 5]:
            a = {**BASE, **{key: D(value) for key, value in overrides.items()}}
            c = contribution(price, **overrides)
            csv_rows.append({'scenario': title, 'ticket_cny': price, **a, 'contribution_cny_per_initial_order': c,
                             'orders_to_cover_5000': ceiling(D(5000) / c) if c > 0 else 'not feasible',
                             'orders_to_cover_20000': ceiling(D(20000) / c) if c > 0 else 'not feasible'})
    funnel = {'headers': ['月合格去重访客', '购买转化／部数', '初始订单', '5元GMV', '贡献余额'], 'rows': [], 'widths': [.23, .25, .15, .18, .19]}
    for visitors, conversion, titles in [(1000, '.02', '1.5'), (10000, '.03', '2'), (50000, '.05', '2')]:
        orders = D(visitors) * D(conversion) * D(titles)
        funnel['rows'].append([f'{visitors:,}', f'{D(conversion)*100:.0f}% / {titles}部', f'{int(orders):,}', f'{orders*5:,.0f}元', f'{orders*contribution(5):,.2f}元'])
    assert contribution(3) == D('.555') and contribution(5) == D('1.125')
    assert ceiling(D(5000) / contribution(3)) == 9010
    assert ceiling(D(5000) / contribution(5)) == 4445
    assert ceiling(D(20000) / contribution(3)) == 36037
    assert ceiling(D(20000) / contribution(5)) == 17778
    assert ceiling(D(10000)/(D(5)*D('.97')*D('.7'))) == 2946
    assert ceiling(D(10000)/(D(3)*D('.97')*D('.7'))) == 4910
    assert contribution(3, creator='.8', partner='.1') == D('-.027')
    with (HERE / 'scenario-calculations.csv').open('w', encoding='utf-8-sig', newline='') as output:
        writer = csv.DictWriter(output, fieldnames=list(csv_rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(csv_rows)
    return {'unit': unit, 'sensitivity': sensitivity, 'funnel': funnel}


TABLES = model_tables()
for page in DATA['pages']:
    if 'table_key' in page:
        page['table'] = TABLES[page['table_key']]


def write_markdown():
    lines = [f"# {DATA['title']}：{DATA['subtitle']}", '', f"研究截止：{DATA['date']}。{DATA['scope']}。", '', f"**结论：{DATA['decision']}**", '']
    for page in DATA['pages']:
        lines += ['## ' + page['title'], '']
        if page.get('lead'):
            lines += ['**' + page['lead'] + '**', '']
        for paragraph in page.get('paragraphs', []):
            lines += [paragraph, '']
        if table := page.get('table'):
            lines.append('| ' + ' | '.join(table['headers']) + ' |')
            lines.append('| ' + ' | '.join(['---'] * len(table['headers'])) + ' |')
            for row in table['rows']:
                lines.append('| ' + ' | '.join(row) + ' |')
            lines.append('')
        for paragraph in page.get('paragraphs_after', []):
            lines += [paragraph, '']
        if page.get('note'):
            lines += ['> ' + page['note'], '']
    lines += ['## 来源与方法', '', '核验截止为2026-11-02。正文引用编号对应以下原始页面；动态价格和平台政策应在签约／上线前重核。未实施真实用户访谈或付费交易。', '']
    for source in DATA['sources']:
        lines += [f"- [{source['id']}] [{source['title']}]({source['url']})。{source['date']}。{source['note']}"]
    lines += ['', '## 复现与文件', '', '- `report-data.json`：原始报告内容与来源。', '- `scenario-calculations.csv`：测算明细，所有比例均为情景参数。', '- `build_report.py`：生成Markdown、PDF并校验计算。', '- PDF不自动替代后续监管、合同或真实成交验证。', '']
    def expand_reference(match):
        group = match.group(1)
        if '-' in group:
            first, last = group.split('-')
            ids = [f'S{number:02d}' for number in range(int(first[1:]), int(last[1:]) + 1)]
        else:
            ids = group.split(',')
        return '、'.join(f'[{key}]({SOURCES[key]["url"]})' for key in ids)
    # Source-list links are already complete. Expand only the body citations.
    body, references = '\n'.join(lines).split('## 来源与方法', 1)
    body = re.sub(r'\[(S\d{2}(?:[-,]S\d{2})*)\]', expand_reference, body)
    (HERE / 'report.md').write_text(body + '## 来源与方法' + references, encoding='utf-8')


FONT = '/Library/Fonts/Arial Unicode.ttf'
pdfmetrics.registerFont(TTFont('ReportCJK', FONT))
INK = colors.HexColor('#182537')
MUTED = colors.HexColor('#536477')
BLUE = colors.HexColor('#245C88')
GOLD = colors.HexColor('#AC7930')
WIDTH = A4[0] - 88
styles = {
    'body': ParagraphStyle('body', fontName='ReportCJK', fontSize=10.2, leading=17.2, textColor=INK, wordWrap='CJK', spaceAfter=8, alignment=TA_LEFT),
    'heading': ParagraphStyle('heading', fontName='ReportCJK', fontSize=18, leading=25, textColor=INK, wordWrap='CJK', spaceAfter=14),
    'lead': ParagraphStyle('lead', fontName='ReportCJK', fontSize=11, leading=18, textColor=BLUE, wordWrap='CJK', spaceAfter=12),
    'note': ParagraphStyle('note', fontName='ReportCJK', fontSize=8.7, leading=14, textColor=MUTED, wordWrap='CJK', spaceBefore=4, spaceAfter=8),
    'cell': ParagraphStyle('cell', fontName='ReportCJK', fontSize=9.2, leading=15, textColor=INK, wordWrap='CJK'),
    'header': ParagraphStyle('header', fontName='ReportCJK', fontSize=9.2, leading=15, textColor=colors.white, wordWrap='CJK'),
}


def marked(text):
    text = html.escape(text)
    def reference(match):
        key = match.group(0)
        if key not in SOURCES:
            raise ValueError('Missing reference ' + key)
        return '<link href="' + html.escape(SOURCES[key]['url'], quote=True) + '" color="#245C88">' + key + '</link>'
    return re.sub(r'\bS\d{2}\b', reference, text)


def para(text, style='body'):
    return Paragraph(marked(text), styles[style])


def table_flow(table):
    cells = [[para(cell, 'header') for cell in table['headers']]]
    cells += [[para(str(cell), 'cell') for cell in row] for row in table['rows']]
    assert abs(sum(table['widths']) - 1) < .0001
    result = Table(cells, colWidths=[WIDTH * fraction for fraction in table['widths']], repeatRows=1, hAlign='LEFT')
    result.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.HexColor('#F0F4F8'), colors.white]),
        ('LINEBELOW', (0, 1), (-1, -1), .4, colors.HexColor('#D9E0E8')),
    ]))
    return result


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFont('ReportCJK', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(44, A4[1] - 28, 'FRAMEPICK  /  Market feasibility')
    canvas.drawRightString(A4[0] - 44, A4[1] - 28, DATA['date'])
    canvas.setStrokeColor(colors.HexColor('#D9E0E8'))
    canvas.line(44, 37, A4[0] - 44, 37)
    canvas.drawString(44, 24, '事实、判断与假设分层 / 场景测算不是营收预测')
    canvas.drawRightString(A4[0] - 44, 24, str(doc.page))
    canvas.restoreState()


def build_pdf():
    PDF.parent.mkdir(parents=True, exist_ok=True)
    story = [Spacer(1, 64)]
    cover_title = ParagraphStyle('cover-title', parent=styles['heading'], fontSize=28, leading=39, spaceAfter=22)
    cover_sub = ParagraphStyle('cover-sub', parent=styles['heading'], fontSize=20, leading=30, textColor=BLUE, spaceAfter=22)
    story += [Paragraph(DATA['title'], cover_title), Paragraph(DATA['subtitle'], cover_sub), para(DATA['scope'], 'note'), Spacer(1, 25)]
    decision = Table([[para('研究结论', 'lead')], [para(DATA['decision'], 'lead')]], colWidths=[WIDTH])
    decision.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#EAF1F7')), ('BOX', (0, 0), (-1, -1), .7, colors.HexColor('#B8CCDC')), ('LEFTPADDING', (0, 0), (-1, -1), 16), ('RIGHTPADDING', (0, 0), (-1, -1), 16), ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    story += [decision, Spacer(1, 30), para('三项优先验证：可售优质成片、普通观众真实付费与复购、可履责的国内上线路径。'), para('报告保留线上影院愿景，但把是否值得扩张交给交易、供给和成本数据。当前没有付费需求已被证实的结论。'), Spacer(1, 24), para('研究截止：2026年11月2日。基于公开资料与当前项目记录；未进行用户访谈或实际支付。全部单片测算参数明示，来源与限制列于末页。', 'note'), PageBreak()]
    for page in DATA['pages']:
        story.append(para(page['title'], 'heading'))
        if page.get('lead'):
            story.append(para(page['lead'], 'lead'))
        for paragraph in page.get('paragraphs', []):
            story.append(para(paragraph))
        if page.get('table'):
            story += [table_flow(page['table']), Spacer(1, 12)]
        for paragraph in page.get('paragraphs_after', []):
            story.append(para(paragraph))
        if page.get('note'):
            story.append(para(page['note'], 'note'))
        story.append(PageBreak())
    for index, group in enumerate([DATA['sources'][:10], DATA['sources'][10:]]):
        story.append(para('来源与证据边界 ' + str(index + 1) + '/2', 'heading'))
        story.append(para('编号对应正文。标题可点击打开原始来源；日期不明的动态页面以本次读取日标注。', 'note'))
        for source in group:
            title = f"[{source['id']}] {source['title']}"
            title_link = '<link href="' + html.escape(source['url'], quote=True) + '" color="#245C88">' + html.escape(title) + '</link>'
            story.append(KeepTogether([Paragraph(title_link, styles['body']), para(source['date'] + '。' + source['note'], 'note')]))
        if index == 0:
            story.append(PageBreak())
    document = SimpleDocTemplate(str(PDF), pagesize=A4, leftMargin=44, rightMargin=44, topMargin=49, bottomMargin=49, title=DATA['title'] + ' - ' + DATA['subtitle'], author='Framepick / project research', pageCompression=1)
    document.build(story, onFirstPage=decorate, onLaterPages=decorate)


if __name__ == '__main__':
    write_markdown()
    build_pdf()
    from pypdf import PdfReader
    reader = PdfReader(PDF)
    texts = [page.extract_text() or '' for page in reader.pages]
    assert all(len(text.strip()) > 80 for text in texts), 'Unexpected empty page'
    all_text = '\n'.join(texts)
    for required in ['授权期内', '1.125', '0.555', '90天', 'S19']:
        assert required in all_text, required
    annotations = sum(len(page.get('/Annots', [])) for page in reader.pages)
    assert annotations >= len(SOURCES), 'Missing source hyperlinks'
    print(json.dumps({'pdf': str(PDF), 'pages': len(reader.pages), 'characters': len(all_text), 'links': annotations, 'calculations_verified': True}, ensure_ascii=False))
