import json, html, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.environ.get('REVIEW_DIR', '/tmp/bunryu-message-review')  # catalog.json, manifest.json, shots/ -> report/
OUT = f'{S}/report'
os.makedirs(f'{OUT}/shots', exist_ok=True)
catalog = json.load(open(f'{S}/catalog.json'))
manifest = json.load(open(f'{S}/manifest.json'))
esc = lambda s: html.escape(s, quote=True)

# Real-stack captures get hand-written entries (no fixture involved).
real_text = {
    'real-shared': dict(
        section='Shared encodes', title='Shared encode running (reference, real capture)',
        when='Healthy: the shared encode row is OK with its bitrate, CPU and memory, and “N outs · N reads” says how many outputs read it. The encode is not counted among the outputs, but its CPU and RAM are in the System usage sums.',
        clears=''),
    'real-flood': dict(
        section='Output warnings', title='FFmpeg reported: … timestamp discontinuity (real capture)',
        when='Captured from the test stack with its flood switch on, so the wording is FFmpeg’s own, not a fixture. Every output reading the same faulty input warns at once, which is how you tell an input timing fault from one bad destination. The pipeline itself shows no alert for it, by design.',
        clears='30 s after the last such line (the stack was flooded for about 15 s here).'),
    'real-shared-waiting': dict(
        section='Shared encodes', title='Waiting for Shared encode 720p · T1 (real capture)',
        when='Two outputs of one pipeline use the same video encode and audio track, so they share one encode. Right after they start, the shared encode row says “Output is waiting to start or retry.” and each output waiting on it says “Waiting for <encode name>”. Warning, not an error.',
        clears='When the shared encode is up and its readers connect (a few seconds).'),
    'real-shared-failed': dict(
        section='Shared encodes', title='Shared encode failed: <reason> (real capture, encode killed with SIGKILL)',
        when='The shared encode’s FFmpeg exited. The encode row turns red (“1 error since last start. exit=SIGKILL”) and the outputs that read it show “Shared encode <name> failed: <reason>”. The states last a few seconds because the encode restarts by itself, so the Overview and Status shots below were taken at slightly different moments (the Overview still showed the outputs as OK).',
        clears='When the encode has restarted and the outputs reconnect.'),
}

prefix = {
    'Banners and top bar': 'B', 'Input status': 'I', 'Input alerts': 'IA', 'SRT relay': 'R',
    'SRT relay alerts': 'RA', 'Output status': 'O', 'Output warnings': 'W', 'Shared encodes': 'SE',
    'Status page': 'S', 'Pipeline list (sidebar)': 'P', 'Output advice': 'A',
}
order = ['Banners and top bar', 'Input status', 'Input alerts', 'SRT relay', 'SRT relay alerts',
         'Output status', 'Output warnings', 'Shared encodes', 'Status page', 'Pipeline list (sidebar)',
         'Output advice']
intro = {
    'Banners and top bar': 'Shown on every page, above the content. Banners stack if several apply. The host alerts (CPU, memory, disk) are computed by the server; the banners and the top bar’s colours both read them.',
    'Input status': 'The input’s own state. Overview → Inputs table (Issues column), the left half of the pipeline dot, and the input dot on the Status page.',
    'Input alerts': 'Alerts raised about the live input. They are merged into the input’s status, so they colour the dot and count in the Issues view. Each has a hint on the Overview and in the pipeline-list tooltip.',
    'SRT relay': 'Only for SRT inputs that come through the Goryu relay. Overview → SRT Relay table, which is only listed once the relay has seen the pipeline. Each row has an Input half (encoder → relay) and an Output half (relay → SRS).',
    'SRT relay alerts': 'Per-interval alerts computed every 5 s from the relay’s counters. Each has a severity (warning, or error for heavy drops, loss or a bitrate collapse), stays for 30 s after it was last raised, and raises the relay’s Input half (Forward to SRS for the forwarding alert) to that severity, so it colours the dots and counts in Issues. See change N3.',
    'Output status': 'One row per output in Overview → Outputs, one dot per output on the Status page.',
    'Output warnings': 'An output that is running but reports a warning. Only one warning is shown at a time, in this order of importance: destination socket, memory, timestamp/decode, falling behind.',
    'Shared encodes': 'Outputs of one pipeline that need the same encode share one FFmpeg encode. Overview → Shared encodes table.',
    'Status page': 'The Status view: a card per pipeline with a dot per output, the Rejected publishers card, and the Recent problems list.',
    'Pipeline list (sidebar)': 'The two-half dot next to each pipeline in the sidebar.',
    'Output advice': 'Tips about how an output is configured, and the note that an output was stopped after repeated failures. Each is one yellow line on the output card (pipeline page). On the Status page and the Overview the output gets a yellow outline round its dot (a stopped one is a grey dot with the outline) and the line in its hover text or Issues column. They change no colour, no count and are not a Problem.',
}
captions = {
    'banner': 'Banner at the top of the page', 'topbar': 'Top bar',
    'ov-inputs': 'Overview → Inputs table', 'ov-outputs': 'Overview → Outputs table',
    'ov-relay': 'Overview → SRT Relay table', 'ov-shared': 'Overview → Shared encodes table',
    'status-card': 'Status page → pipeline card', 'status-top': 'Status page → top',
    'sidebar-dot': 'Pipeline list → hover on the dot', 'out-card': 'Pipeline page → output card',
    'out-hint': 'Pipeline page → hover on the ⓘ next to the error',
    'status-problems': 'Status page → Recent problems', 'sidebar-rejected': 'Overview → sidebar, below the pipelines',
}
def caption(kind, entry_id):
    if kind.startswith('status-dot'):
        d = kind.split(':')[1]
        if d == 'input':
            return 'Status page → hover on the input dot'
        return f'Status page → hover on output dot {int(d) + 1}'
    return captions.get(kind, kind)

error_ids = {'banner-server', 'banner-srs', 'topbar-error', 'topbar-pressure', 'relay-alert-dropped-error', 'relay-alert-loss-error', 'relay-alert-bitrate-error', 'in-probe-error', 'relay-no-legs', 'relay-leg-quality-error',
             'relay-conflict-srs', 'relay-conflict-local', 'relay-reconnecting', 'out-failed', 'out-no-bitrate-error',
             'real-shared-failed'}
tip_sections = {'Output advice'}
def severity(e):
    if e['id'] in error_ids: return 'error'
    if e['id'] in ('in-ok', 'relay-ok', 'out-ok', 'in-off-idle'): return 'ok'
    if e['section'] in tip_sections: return 'tip'
    if e['id'] in ('status-rejected',): return 'error'
    if e['id'] in ('status-problems', 'out-many', 'side-mixed'): return 'info'
    return 'warning'

entries = []
for e in catalog:
    if e['id'].startswith('real-'):
        t = real_text[e['id']]
        e = {**e, **t}
    if e['id'] == 'real-shared-waiting' or e['id'] not in manifest and e['id'] != 'real-shared-waiting':
        pass
    entries.append(e)
# real-shared-waiting has no catalog entry (it was renamed in the manifest).
entries.append({'id': 'real-shared-waiting', 'shots': [], **real_text['real-shared-waiting']})

by_section = {}
for e in entries:
    by_section.setdefault(e['section'].replace('Real', 'Shared encodes') if e['section'] == 'Real' else e['section'], []).append(e)
# the real-flood entry belongs to Output warnings (already set); flood goes after timestamps.

def where(kinds):
    names = []
    for k in kinds:
        c = caption(k, '')
        c = c.split(' → ')[0] if False else c
        if c not in names: names.append(c)
    return names

codes = {}
cards = []
toc = []
for sec in order:
    items = by_section.get(sec, [])
    # real entries sort: shared waiting before failed
    if sec == 'Shared encodes':
        items.sort(key=lambda e: 0 if e['id'] == 'real-shared-waiting' else 1)
    if not items: continue
    toc.append((sec, prefix[sec]))
    cards.append(f'<section class="sec" id="sec-{prefix[sec].lower()}"><h2>{esc(sec)}</h2><p class="secintro">{esc(intro[sec])}</p>')
    for i, e in enumerate(items, 1):
        code = f'{prefix[sec]}{i}'
        codes[e['id']] = code
        sev = severity(e)
        shots = manifest.get(e['id'], [])
        figs = []
        for s in shots:
            src = f'{S}/shots/{s["file"]}'
            if not os.path.exists(src): continue
            shutil.copy(src, f'{OUT}/shots/{s["file"]}')
            cls = ' tall' if s['kind'] == 'status-problems' else ''
            figs.append(f'<figure class="shot{cls}"><img loading="lazy" src="shots/{s["file"]}" alt="{esc(e["title"])} — {esc(caption(s["kind"], e["id"]))}"><figcaption>{esc(caption(s["kind"], e["id"]))}</figcaption></figure>')
        clears = f'<div class="row"><dt>Clears</dt><dd>{esc(e["clears"])}</dd></div>' if e.get('clears') else ''
        sev_label = {'error': 'Error', 'warning': 'Warning', 'tip': 'Tip', 'ok': 'Reference', 'info': 'Info'}[sev]
        cards.append(f'''<article class="card sev-{sev}" id="{code}" data-code="{code}" data-title="{esc(e["title"])}">
  <header><span class="code">{code}</span><span class="chip chip-{sev}">{sev_label}</span><h3>{esc(e["title"])}</h3></header>
  <div class="body">
    <dl class="facts"><div class="row"><dt>When it shows</dt><dd>{esc(e["when"])}</dd></div>{clears}</dl>
    <div class="shots">{''.join(figs)}</div>
  </div>
  <div class="review" role="group" aria-label="Your decision for {code}">
    <label class="opt"><input type="radio" name="d-{code}" value="ok"> Keep as is</label>
    <label class="opt"><input type="radio" name="d-{code}" value="change"> Change</label>
    <label class="opt"><input type="radio" name="d-{code}" value="question"> Question</label>
    <input class="note" type="text" id="n-{code}" placeholder="Note (optional)" aria-label="Note for {code}">
  </div>
</article>''')
    cards.append('</section>')

# A later round of review can list what was decided and done in $REVIEW_DIR/changes.json: a list of
# {code, title, decision, status ("Done" or "Kept"), text, refs: [catalogue ids]}. Without the file
# the report has no such section.
changes_path = f'{S}/changes.json'
changes = [(c['code'], c['title'], c['decision'], c['status'], c['text'], c.get('refs', []))
           for c in (json.load(open(changes_path)) if os.path.exists(changes_path) else [])]
obs_html = ['<section class="sec" id="sec-n"><h2>What changed since your review</h2><p class="secintro">Your decisions on the earlier “Worth a look” items and what was done. The screenshots below were retaken from the changed dashboard, so some entries read differently from the first version of this report.</p>']
for code, title, decision, status, text, refs in changes:
    links = ' '.join(f'<a class="ref" href="#{codes[r]}">{codes[r]}</a>' for r in refs if r in codes)
    obs_html.append(f'''<article class="change" id="{code}">
  <header><span class="code">{code}</span><span class="chip chip-{'ok' if status == 'Done' else 'info'}">{status}</span><h3>{esc(title)}</h3></header>
  <p class="decided">Your decision: {decision}</p>
  <p>{esc(text)}</p>{('<p class="refs">See ' + links + '</p>') if links else ''}
</article>''')
obs_html.append('</section>')
if not changes:
    obs_html = []

toc_html = ('<a href="#sec-n">What changed</a>' if changes else '') + ''.join(f'<a href="#sec-{p.lower()}">{esc(s)}</a>' for s, p in toc)
n_items = sum(1 for e in entries)

page = open(f'{HERE}/report_template.html').read()
page = page.replace('{{TOC}}', toc_html).replace('{{OBS}}', ''.join(obs_html)).replace('{{CARDS}}', ''.join(cards)).replace('{{COUNT}}', str(n_items)).replace('{{OBSCOUNT}}', str(len(changes)))
open(f'{OUT}/index.html', 'w').write(page)
print('entries', n_items, 'obs', len(changes), 'images', len(os.listdir(f'{OUT}/shots')))
json.dump(codes, open(f'{S}/codes.json', 'w'), indent=1)

# Publishing only the page does not upload shots/, so also write a copy with every image inlined
# (a few MB); that is the file to publish.
import base64
def inline(m):
    with open(f'{OUT}/shots/{m.group(1)}', 'rb') as f:
        return 'src="data:image/png;base64,' + base64.b64encode(f.read()).decode() + '"'
with open(f'{OUT}/index-inline.html', 'w') as f:
    f.write(re.sub(r'src="shots/([^"]+)"', inline, page))
print('wrote', f'{OUT}/index-inline.html')
