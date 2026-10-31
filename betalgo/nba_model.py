"""NBA game-winner model: 538-style Elo tuned walk-forward on 2022-2025, tested on 2026, rated through today.
usage: python3 nba_model.py [HOME AWAY ...]   (team abbreviations, e.g. NO SAC)"""
import sys, glob
import numpy as np, pandas as pd
from sklearn.metrics import log_loss

t = pd.concat([pd.read_csv(f) for f in sorted(glob.glob('data/nba_team_box_*.csv'))], ignore_index=True)
t = t[t.season_type.isin([2, 3])]
t['game_date'] = pd.to_datetime(t.game_date)
h = t[t.team_home_away == 'home'].set_index('game_id')
a = t[t.team_home_away == 'away'].set_index('game_id')
g = h[['season', 'game_date', 'team_abbreviation', 'team_score']].join(
    a[['team_abbreviation', 'team_score']], rsuffix='_a', how='inner')
g.columns = ['season', 'date', 'home', 'hs', 'away', 'as_']
g = g.dropna().sort_values('date')
g['y'] = (g.hs > g.as_).astype(int)


def elo(K, HCA, carry):
    r, last, p = {}, {}, []
    for x in g.itertuples():
        for tm in (x.home, x.away):
            if tm not in r:
                r[tm] = 1500.0
            elif last.get(tm) != x.season:
                r[tm] = carry * r[tm] + (1 - carry) * 1505
            last[tm] = x.season
        d = r[x.home] + HCA - r[x.away]
        e = 1 / (1 + 10 ** (-d / 400))
        p.append(e)
        wd = d if x.y else -d
        delta = K * ((abs(x.hs - x.as_) + 3) ** 0.8 / (7.5 + 0.006 * wd)) * (x.y - e)
        r[x.home] += delta
        r[x.away] -= delta
    return np.array(p), r


tune, test = g.season.between(2022, 2025).values, (g.season == 2026).values
best = min(((log_loss(g.y[tune], elo(K, H, c)[0][tune]), K, H, c)
            for K in (15, 20, 25) for H in (50, 70, 90) for c in (0.6, 0.75)))
_, K, HCA, C = best
p, R = elo(K, HCA, C)
print(f'Elo K={K} HCA={HCA} carry={C} | 2025-26 test: log loss {log_loss(g.y[test], p[test]):.3f} '
      f'(coin 0.693), acc {((p[test] > .5) == g.y[test]).mean():.3f}, n={test.sum()}')
args = sys.argv[1:]
for hm, aw in zip(args[::2], args[1::2]):
    d = R[hm] + HCA - R[aw]
    ph = 1 / (1 + 10 ** (-d / 400))
    print(f'{aw} @ {hm}: P({hm}) {ph:.3f}  P({aw}) {1 - ph:.3f}')
