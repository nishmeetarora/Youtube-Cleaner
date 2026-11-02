# YouTube Cleaner

A personal Chrome extension that keeps YouTube's recommendations but drops the junk:

- **Shorts are gone everywhere**: Home, search, the sidebar, the menu and channel tabs. A Shorts link opens in the normal player.
- **Bait, slop and empty entertainment are filtered** from Home and the Up next sidebar by a cheap LLM (DeepSeek V4.1 Flash by default). Taste is left to YouTube; the filter only asks how much you'd learn from a video. Sports highlights, episodes and playthroughs go; a story or analysis about them stays.
- **Nothing jumps.** Cards stay blurred ("Judging…") until they're judged, and are revealed in reading order, so a hidden video never moves one you can already see. Hidden cards are removed and the grid closes up with no gaps.
- **A control panel in YouTube's menu**, under Home: on/off, a strictness slider over a histogram of this page's scores (the red bins are what's being hidden), quick toggles, and a "Hidden here" list with Show buttons. Every change applies to the page instantly.
- **Clickbait titles get a second look.** A video that scores low on its title is judged again with its description, tags and chapters before it can be hidden.
- **Recently hidden** on the settings page lists what was filtered and why, with Show and Trust channel buttons.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
3. The settings page opens. Pick a provider, paste your API key, and click **Test connection**.
4. Reload YouTube.

Clicking the extension's toolbar icon reopens the settings page.

## Strictness

Each video gets a signal score from 0 to 10. A video is hidden when it scores below the strictness threshold.

| Strictness | Hides below | What goes |
|---|---|---|
| Only the worst | 1 | Blatant slop: drama, reaction, pranks, content farms |
| Slop | 2 | All slop, including hype and clip farms |
| Slop, bait and empty entertainment (default) | 3 | Also clickbait with little in it, and highlights, episodes and playthroughs with nothing to learn |
| Strict | 4 | Also light videos: real but thin |
| Very strict | 5 | Only solid explanation, analysis and craft |

Music (tracks, live sets, mixes) is always shown unless you turn that off.

Tested on 123 videos from a real Home feed (all close calls) and 46 top results for slop-heavy searches. At the default it hid 2 of the 123 and 96% of the bait sample; one notch looser hid none of the 123 and 89%. On a later Home page of 68 videos it hid 4: race highlights, a results clip, a match replay and an anime parody episode, while keeping stories and analysis about the same sport. See `test/signal.js`.

## How it works

| Piece | File | Job |
|---|---|---|
| Page hook | `src/page/hook.js` | Runs before YouTube's scripts. Wraps `fetch` for `/youtubei/v1/browse`, `next`, `search` and `guide`, and catches the inline `ytInitialData`. Drops Shorts from the data, sends each feed's videos for judging, and turns the judging blur on before the first paint. |
| Content script | `src/content/main.js` | Marks every card: blurred while judged, shown, or hidden. Fetches details for the second look, since YouTube only answers those from its own origin. |
| Panel | `src/content/panel.js` | The control panel in YouTube's menu, in a shadow root. |
| Background | `src/background/` | Batches videos, calls the model, caches scores for 60 days, keeps the hidden log and usage stats. |
| Settings | `options/` | Provider and key, strictness, feeds, music, Shorts, the hidden log, usage. |

Scores are cached per video, so a video YouTube recommends again is decided instantly. A video seen for the first time
stays blurred for a few seconds, longer if its title needs a second look. Filtered videos are hidden on the page rather
than removed from YouTube's data, which is what lets the slider bring them back without a reload.

## Development

```bash
node dev/make-fixtures.js
```

```bash
node dev/test.js
```

`make-fixtures.js` saves real, anonymous YouTube responses (search, a watch page, a channel, the guide) to
`dev/fixtures/`. `test.js` checks the hook against them, runs the hook inside a simulated page, and runs the background
worker with a fake model. Two pages run the real UI with a fake `chrome.*` API (`dev/chrome-shim.js`); serve the folder
(the `settings-preview` entry in `.claude/launch.json`) and open:

- `/dev/mock-youtube.html`: a rough YouTube Home with the real hook, content script, panel and CSS, and a fake model
  that answers with delays. `?dark` for dark mode, `?nokey` for no API key.
- `/dev/options-preview.html?test`: the settings page.

The `test/` folder holds the accuracy experiments that shaped the design. They read `.env` (see `.env.example`) and
write to `test/data/`, which is git-ignored because it holds your own feed.

## License

MIT. See `LICENSE`.
