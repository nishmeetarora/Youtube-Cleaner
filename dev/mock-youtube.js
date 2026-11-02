// Fills dev/mock-youtube.html with demo cards and sends them to the content script the way the page hook does.
(function () {
  'use strict';
  const PAGES = [
    [
      ['Race Highlights | Grand Prix of Elsewhere', 'Motorsport (demo)', '8:08'],
      ['Why Cities Got So Expensive', 'Urban Explainers (demo)', '14:10'],
      ['Space Saga Abridged: Episode 48 - Parody Crew', 'Parody Crew (demo)', '10:24'],
      ['Lecture 3: How Transformers Work', 'University Lectures (demo)', '52:31'],
      ['Reacting to the CRAZIEST influencer drama', 'Drama Daily (demo)', '18:02'],
      ['Midnight Drive (Official Audio)', 'Synth Band (demo)', '4:03'],
      ['The Forgotten History of the Silk Road', 'History Desk (demo)', '21:37'],
      ['Player A vs Player B | Maximum effort', 'Badminton TV (demo)', '8:07'],
      ['Things nobody teaches new drivers', 'Driving School (demo)', '11:01'],
      ['I Spent 24 Hours in an Abandoned Mall', 'Stunt House (demo)', '21:40'],
      ['Is Our Universe Inside a Black Hole?', 'Space Talk (demo)', '8:31'],
      ['The Numbers Behind a Startup Collapse', 'Finance Desk (demo)', '17:50'],
    ],
    [
      ['How Did This State Get So Much Debt?', 'Policy Explained (demo)', '11:09'],
      ['Team X is the World Champion!', 'Motorsport (demo)', '5:01'],
      ['Ambient Rain Mix for Focus', 'Calm Sounds (demo)', '2:00:00'],
      ['The Strange Economics of Cloud Computing', 'Tech Deep Dives (demo)', '23:02'],
      ['Exposed: The Influencer Who Faked Everything', 'Drama Daily (demo)', '15:40'],
      ['Casually Explained: Magnets', 'Comedy Science (demo)', '4:20'],
    ],
  ];
  let n = 0;
  const contents = document.getElementById('contents');

  function addPage(page, fresh) {
    const videos = [];
    for (const [title, channel, duration] of page) {
      n++;
      const id = `demovid${String(n).padStart(4, '0')}`;
      videos.push({ id, title, channel, duration, views: `${(n * 37) % 900}K`, age: `${n} days ago` });
      const card = document.createElement('ytd-rich-item-renderer');
      card.innerHTML = `<div id="content"><a class="thumb" style="--h:${(n * 47) % 360}" href="/watch?v=${id}"><span class="dur"></span></a>
        <div class="details"><span class="avatar"></span><div><h3><a href="/watch?v=${id}"></a></h3>
        <div class="metadata-row"><a></a></div><div class="metadata-row"><span></span></div></div></div></div>`;
      card.querySelector('.dur').textContent = duration;
      card.querySelector('h3 a').textContent = title;
      card.querySelector('.metadata-row a').textContent = channel;
      card.querySelector('.metadata-row span').textContent = `${videos.at(-1).views} views · ${videos.at(-1).age}`;
      contents.appendChild(card);
    }
    window.postMessage({ __ytc: 'page', kind: 'videos', surface: 'home', fresh, videos, client: '' }, location.origin);
  }

  addPage(PAGES[0], true);
  document.getElementById('more').addEventListener('click', () => addPage(PAGES[1], false));
})();
