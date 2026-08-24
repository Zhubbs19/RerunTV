// Plugin-specific settings only. RerunTV composes this section after the
// CHANNEL DISPLAY section supplied automatically by registerChannelType.
window.RCBPlugins.registerPluginSettings('starter-plugin', {
  schemaVersion: 1,
  defaults: { greeting: '' },
  validate(settings) {
    return typeof settings.greeting === 'string' && settings.greeting.length <= 60
      ? true
      : 'greeting must be a string no longer than 60 characters';
  },
  sections: [{
    id: 'greeting',
    label: 'STARTER PLUGIN',
    layout: 'stack',
    render(container, ctx) {
      container.innerHTML = `
        <div class="panel-body">
          <input type="text" data-el="greeting" class="title-row-input" placeholder="Hello, world!" maxlength="60">
        </div>
        <span class="panel-status">Whatever you type here shows on the STARTER CHANNEL (900).</span>
      `;
      const greetingEl = container.querySelector('[data-el="greeting"]');
      greetingEl.value = ctx.settings.greeting || '';
      greetingEl.addEventListener('input', () => ctx.updateSettings({ greeting: greetingEl.value }));
    },
  }],
});
