// "New things to try": a short, hand-kept list of what recent versions added
// that you would not stumble on, each with a TAKE ME THERE button that opens
// the right settings page and flashes the setting. Shown under the post-update
// card and in HELP › WHAT'S NEW. Edit this list when a version ships something
// worth pointing at; `setting` is a .setting-row data-setting value (optional).

export const HIGHLIGHTS = [
  { id: 'layout-editor', title: 'A rebuilt on-screen layout editor', text: 'Press O while watching to drag the logo and every card over the real picture, with snapping, undo and a clean view (H).', tab: 'guide', subtab: 'guideonscreen' },
  { id: 'simple-advanced', title: 'Simple and Advanced settings', text: 'Simple shows the everyday controls; switch to Advanced in the sidebar for everything. Search finds both.', tab: 'channels' },
  { id: 'splicer', title: 'Cut and combine recordings', text: 'The Video Splicer is built in: split a recording into episodes, ads and bumpers, then join clips.', tab: 'library', subtab: 'librarysplicer' },
  { id: 'second-screen', title: 'TV on a second screen', text: 'Pick the screen and speakers RerunTV uses, with TV mode, screen edges and volume levelling per file.', tab: 'display', subtab: 'picture' },
  { id: 'keys', title: 'Choose your own keys', text: 'Reassign the shortcuts for live TV, with the hint bar following.', tab: 'audio', subtab: 'keys' },
  { id: 'reset', title: 'Reset a settings panel', text: 'Every busy panel ends with a button that puts it back to its defaults, and Undo brings your choices back.', tab: 'audio', subtab: 'system', setting: 'startup-channel' },
  { id: 'settings-bundle', title: 'Carry your settings to another machine', text: 'Export just your look and options, with no channels, and import them elsewhere.', tab: 'audio', subtab: 'backups' },
  { id: 'logo-size', title: 'Logo bug sizing that fits any screen', text: 'One default size, scaled to 1080p or 4K automatically, anchored to the picture so it never sits on black bars.', tab: 'guide', subtab: 'guideonscreen', setting: 'logo-default-size' },
  { id: 'bars', title: 'Remove baked-in black bars', text: 'Finds letterbox bars inside the video itself and frames just the picture.', tab: 'display', subtab: 'picture', setting: 'aspect-bars' },
  { id: 'guide-columns', title: 'Guide columns of 15, 30 or 60 minutes', text: 'Shorter columns suit short shows and music videos.', tab: 'guide', subtab: 'guidegrid', setting: 'guide-slot-minutes' },
  { id: 'volume', title: 'Volume that remembers and fades', text: 'Each channel can keep its own volume, new channels fade in, and the sleep timer fades out.', tab: 'audio', subtab: 'system', setting: 'remember-channel-volume' },
  { id: 'recent', title: 'Recent channels and start over', text: 'Shift+Backspace lists the last channels you watched; J restarts the show on screen.', tab: 'help', subtab: 'shortcuts' },
  { id: 'cabinet', title: 'The music cabinet', text: 'On the music channel press OK, then CABINET: a CD rack or record crate of every album, with covers, favourites and search by artist.', tab: 'plugins', subtab: 'installed' },
  { id: 'leveler-consistent', title: 'A steadier volume leveler', text: 'CONSISTENT brings every show and ad down to one level, cuts loud ads deeper, and holds a file back until it has been measured.', tab: 'display', subtab: 'sound', setting: 'audio-leveler' },
  { id: 'pc-shutdown', title: 'Shut down the PC from the couch', text: 'Switch it on under SYSTEM › POWER: SHUT DOWN PC joins the TV menu and the companion remote, with a 20-second countdown you can cancel, and power-off can take the PC down with it.', tab: 'audio', subtab: 'system', setting: 'pc-shutdown-enabled' },
  { id: 'presets', title: 'Channel presets', text: 'Build a whole channel from a preset such as MUSIC VIDEOS or CHRISTMAS TV, or make your own: what plays, when, and which ads, with no file paths.', tab: 'library', subtab: 'librarypresets' },
  { id: 'plugin-permissions', title: 'Plugin permissions in plain words', text: 'Each plugin’s page says what it can reach, which sites it connects to, and what it has done since start. Plugins you install yourself now work too.', tab: 'plugins', subtab: 'installed' },
];

// Opens the page a highlight points at. `showSetup` brings the setup screen up
// first when the TV is showing.
export async function goToHighlight(highlight, showSetup) {
  if (typeof showSetup === 'function') await showSetup();
  document.querySelector(`.setup-tab-btn[data-tab="${highlight.tab}"]`)?.click();
  if (highlight.subtab) {
    document.querySelector(`.setup-tab-panel[data-tab-panel="${highlight.tab}"] .setup-subtab-btn[data-subtab="${highlight.subtab}"]`)?.click();
  }
  if (!highlight.setting) return;
  requestAnimationFrame(() => {
    const row = document.querySelector(`.setting-row[data-setting="${highlight.setting}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('search-target-flash');
    void row.offsetWidth;
    row.classList.add('search-target-flash');
    setTimeout(() => row.classList.remove('search-target-flash'), 1400);
  });
}

// Fills `container` with the list. onGo runs before navigating (the post-update
// card closes itself there).
export function renderHighlights(container, { onGo, showSetup } = {}) {
  container.innerHTML = '';
  HIGHLIGHTS.forEach((highlight) => {
    const row = document.createElement('div');
    row.className = 'highlight-row';
    const text = document.createElement('div');
    text.className = 'highlight-text';
    const title = document.createElement('strong');
    title.textContent = highlight.title;
    const body = document.createElement('span');
    body.textContent = highlight.text;
    text.append(title, body);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = 'TAKE ME THERE';
    button.addEventListener('click', async () => {
      if (onGo) await onGo(highlight);
      await goToHighlight(highlight, showSetup);
    });
    row.append(text, button);
    container.appendChild(row);
  });
}
