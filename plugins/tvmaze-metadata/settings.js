window.RCBPlugins.registerPluginSettings('tvmaze-metadata', {
  schemaVersion: 1,
  defaults: { episodeTitles: true, seriesNames: true },
  sections: [{
    id: 'about',
    label: 'TVMAZE EPISODES',
    render(container) {
      const intro = document.createElement('p');
      intro.className = 'panel-status';
      intro.textContent = 'Each channel’s TITLES page gains a TVMAZE button that looks up a TV episode by its show and its season and episode (S02E01 in the file name, or its series details). It fills in empty titles, synopses and series names, and records when and on which network the episode first aired. No account or key is needed; nothing is looked up until you press the button.';
      const credit = document.createElement('p');
      credit.className = 'panel-status';
      credit.textContent = 'Episode data from TVmaze.com, shared under CC BY-SA.';
      container.append(intro, credit);
    },
  }, {
    id: 'matching',
    label: 'MATCHING',
    fields: [
      {
        key: 'episodeTitles',
        type: 'toggle',
        label: 'Fill in episode titles',
        synonyms: 'episode name title',
        help: 'Gives a file with no title its episode’s name.',
      },
      {
        key: 'seriesNames',
        type: 'toggle',
        label: 'Fill in series names',
        synonyms: 'show name series season episode',
        help: 'Gives a file with no series its show’s name, season and episode, which the guide uses to group a show.',
      },
    ],
  }],
});
