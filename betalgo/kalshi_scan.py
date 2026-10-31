"""Scan open Kalshi NBA game markets, price them with the Elo model, paper-log two strategies, grade settled ones.
A = model alone: buy YES when model fair - (ask + taker fee) >= MIN_EDGE.
B = model + market: same, but fair = average(model, Kalshi de-vigged mid) so the market must agree.
usage: python3 kalshi_scan.py        (writes/updates paper_log.csv)"""
import csv, json, math, os, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

API = 'https://api.elections.kalshi.com/trade-api/v2/markets'
LOG = 'paper_log.csv'
MIN_EDGE = 0.02
# Kalshi ticker abbreviation -> ESPN abbreviation used by nba_model.py
FIX = {'GSW': 'GS', 'NOP': 'NO', 'SAS': 'SA', 'NYK': 'NY', 'UTA': 'UTAH', 'WAS': 'WSH', 'PHO': 'PHX'}


def get(params):
    for i in range(4):
        with urllib.request.urlopen(f'{API}?{params}', timeout=20) as r:
            d = json.load(r)
        if 'markets' in d:
            return d['markets']
        time.sleep(2 ** i)
    raise SystemExit(f'Kalshi error: {d}')


def started(m):
    # occurrence_datetime is roughly the scheduled end; tip-off is ~3h earlier
    end = datetime.fromisoformat(m['occurrence_datetime'].replace('Z', '+00:00'))
    return end - timedelta(hours=3) <= datetime.now(timezone.utc) + timedelta(minutes=10)


def fee(p):
    return math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100


def model_probs(pairs):
    args = [x for hm, aw in pairs for x in (hm, aw)]
    out = subprocess.run([sys.executable, '-I', 'nba_model.py', *args], capture_output=True, text=True).stdout
    res = {}
    for line in out.splitlines():
        if ' @ ' in line:
            aw, rest = line.split(' @ ')
            hm = rest.split(':')[0]
            res[(hm, aw)] = float(line.split(f'P({hm}) ')[1].split()[0])
    return res


def scan():
    events = {}
    for m in get('series_ticker=KXNBAGAME&status=open&limit=200'):
        events.setdefault(m['event_ticker'], []).append(m)
    pairs, rows = [], []
    for ev, ms in events.items():
        if len(ms) != 2 or started(ms[0]):
            continue
        code = ev.split('-')[1][7:]                      # e.g. MIALAL -> away MIA, home LAL
        aw, hm = FIX.get(code[:3], code[:3]), FIX.get(code[3:], code[3:])
        pairs.append((hm, aw))
        rows.append((ev, hm, aw, ms))
    P = model_probs(pairs)
    logged = set()
    if os.path.exists(LOG):
        logged = {(r['ticker'], r['strategy']) for r in csv.DictReader(open(LOG))}
    new = []
    for ev, hm, aw, ms in rows:
        if (hm, aw) not in P:
            print('no rating for', ev); continue
        mids = {m['ticker']: (float(m['yes_bid_dollars'] or 0) + float(m['yes_ask_dollars'] or 1)) / 2 for m in ms}
        tot = sum(mids.values())
        for m in ms:
            team = FIX.get(m['ticker'].split('-')[-1], m['ticker'].split('-')[-1])
            pm = P[(hm, aw)] if team == hm else 1 - P[(hm, aw)]
            ask = float(m['yes_ask_dollars'] or 0)
            if not 0.03 <= ask <= 0.97:
                continue
            cost = ask + fee(ask)
            fair = {'A': pm, 'B': (pm + mids[m['ticker']] / tot) / 2}
            for s, f in fair.items():
                edge = f - cost
                print(f"{s} {m['ticker']:32s} model {pm:.3f} fair {f:.3f} ask {ask:.2f} cost {cost:.2f} edge {edge:+.3f}")
                if edge >= MIN_EDGE and (m['ticker'], s) not in logged:
                    new.append({'ticker': m['ticker'], 'strategy': s, 'team': team, 'fair': round(f, 3),
                                'ask': ask, 'cost': cost, 'edge': round(edge, 3), 'result': '', 'pnl': ''})
    write(new, append=True)
    print(f'logged {len(new)} new paper trades')


def write(rows, append):
    exists = os.path.exists(LOG)
    old = list(csv.DictReader(open(LOG))) if exists and append else []
    keys = ['ticker', 'strategy', 'team', 'fair', 'ask', 'cost', 'edge', 'result', 'pnl']
    with open(LOG, 'w', newline='') as f:
        w = csv.DictWriter(f, keys); w.writeheader(); w.writerows(old + rows)


def grade():
    if not os.path.exists(LOG):
        return
    rows = list(csv.DictReader(open(LOG)))
    for r in rows:
        if r['result']:
            continue
        with urllib.request.urlopen(f"{API}/{r['ticker']}", timeout=20) as x:
            m = json.load(x)['market']
        if m.get('result') in ('yes', 'no'):
            r['result'] = m['result']
            r['pnl'] = round((1 if m['result'] == 'yes' else 0) - float(r['cost']), 2)
    write(rows, append=False)
    for s in 'AB':
        done = [r for r in rows if r['strategy'] == s and r['result']]
        if done:
            pnl = sum(float(r['pnl']) for r in done); stake = sum(float(r['cost']) for r in done)
            print(f'strategy {s}: {len(done)} graded, {sum(r["result"] == "yes" for r in done)} won, '
                  f'P&L ${pnl:+.2f} per 1 contract each, ROI {pnl / stake:+.1%}')


if __name__ == '__main__':
    grade()
    scan()
