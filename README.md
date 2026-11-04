# YouTube Cleaner

A personal Chrome extension that puts an IQ slider on YouTube, like IQ Slider does for X:

- **An IQ slider.** A cheap LLM (DeepSeek V4.1 Flash by default) rates the intellectual level of every video on Home and in the Up next sidebar, shown as an IQ from 70 to 150. Videos below your bar are hidden. Raise it and you get only the dense stuff; lower it and only slop goes. The format sets the ceiling: commentary on events < a story < an explanation < working with ideas < expert depth, so a race debrief sits well below an essay on Marx or a philosophy lecture.
- **Topic weights.** Twenty topic chips (Science, AI, History, Ideas, Sports, Drama…). Tap one for **more** (its bar drops by 16 IQ, so more of it gets through) or **less** (always hidden).
- **The IQ on every thumbnail**, in the top-right corner. Blue means IQ 126 or more; ♪ marks music, which always shows unless you turn that off.
- **Shorts are gone everywhere**: Home, search, the sidebar, the menu and channel tabs. A Shorts link opens in the normal player.
- **Nothing jumps.** Cards stay blurred ("Judging…") until they're judged, and are revealed in reading order, so a hidden video never moves one you can already see. Hidden cards are removed and the grid closes up with no gaps.
- **A control panel that takes over YouTube's left menu**: the menu gets wider and keeps only Home above the panel (Subscriptions, You and Explore are hidden; one switch brings them back). On/off, a big IQ readout with this page's hidden count, the IQ slider over a histogram of this page's videos (the red bars are what's being hidden; click a bar to start there), the topic chips, a "Hidden here" list with Show buttons, and options. Every change applies to the page instantly.
- **Clickbait titles get a second look.** A video whose title alone puts it just under your bar is judged again with its description, tags and chapters before it's hidden.
- **Recently hidden** on the settings page lists what was filtered and why, with Show and Trust channel buttons.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
3. The settings page opens. Pick a provider, paste your API key, and click **Test connection**.
4. Reload YouTube.

Clicking the extension's toolbar icon reopens the settings page.

## The IQ scale

Each video gets a depth score from 0 to 10, shown as IQ = 70 + 8 × score. A video is hidden when it scores below the
slider, or below the slider minus 2 (16 IQ) for a topic marked **more**.

| IQ | Score | What sits there |
|---|---|---|
| 70-78 | 0-1 | Slop: drama, reaction, pranks, stunts, compilations, content farms, get-rich-quick hype |
| 86 | 2 | Entertainment with nothing to learn: highlights, match replays, anime, playthroughs, vlogs |
| 94 | 3 | Commentary and light: sports debriefs, gadget and car reviews, creator stories, listicles, self-help |
| 102 | 4 | Popular stories: company sagas, scandals, true crime, history told as a story, how-tos |
| 110 | 5 | Solid explanation: how or why something works, investigative documentaries |
| 118-126 | 6-7 | Ideas and depth: philosophy, psychology, science concepts, essays that build an argument |
| 134-142 | 8-9 | Deep: expert lectures, rigorous long conversations, technical deep dives |
| 150 | 10 | Exceptional |

Ideas count as much as facts: an essay that really explores a philosophical idea can sit at 118-134 with no data. A
motivational take dressed up with philosophers' names stays at 94.

The default bar is **IQ 110**. Every topic starts neutral, except Drama, which starts on less.

Tested with `test/iq.js` on 123 videos from a real Home feed, a later Home page of 68, 43 top results for slop-heavy
searches, and ten videos from a later feed with an ordering the user gave (ideas over sports commentary). All eight
ordering checks hold: Alex O'Connor on philosophy at 126, Thiel/Marx and Pessoa at 118, explainers at 110, company
stories at 102-110, an F1 driver debrief at 94. The whole bait sample is at 94 or lower. On the later Home page, IQ 110
hid 40%, IQ 118 hid 75% and IQ 126 hid 90%.

## How it works

| Piece | File | Job |
|---|---|---|
| Page hook | `src/page/hook.js` | Runs before YouTube's scripts. Wraps `fetch` for `/youtubei/v1/browse`, `next`, `search` and `guide`, and catches the inline `ytInitialData`. Drops Shorts from the data, sends each feed's videos for judging, and turns the judging blur on before the first paint. |
| Content script | `src/content/main.js` | Marks every card: blurred while judged, shown with its IQ, or hidden. Asks for a second look at videos just under the bar, and fetches their details, since YouTube only answers those from its own origin. |
| Panel | `src/content/panel.js` | The control panel in YouTube's menu, in a shadow root. `content.css` widens the menu and hides the rest of it. |
| Background | `src/background/` | Batches videos, calls the model (first passes before second looks), caches scores for 60 days, keeps the hidden log and usage stats. |
| Settings | `options/` | Provider and key, minimum IQ, topics, feeds, badges, music, Shorts, the hidden log, usage. |

Scores are cached per video, so a video YouTube recommends again is decided instantly. A video seen for the first time
stays blurred for a few seconds, longer if its title puts it just under the bar and it needs a second look. When you
raise the slider, videos it pushes just under the bar get their second look once the slider rests, and come back if
their description lifts them. Filtered videos are hidden on the page rather than removed from YouTube's data, which is
what lets the slider and the topics bring them back without a reload.

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
  that answers with delays and lifts a couple of videos on their second look. `?dark` for dark mode, `?nokey` for no
  API key, `?slow` for a slow second look.
- `/dev/options-preview.html?test`: the settings page.

The `test/` folder holds the accuracy experiments that shaped the design; `node test/iq.js` checks the current prompt. They read `.env` (see `.env.example`) and
write to `test/data/`, which is git-ignored because it holds your own feed.

## License

MIT. See `LICENSE`.
