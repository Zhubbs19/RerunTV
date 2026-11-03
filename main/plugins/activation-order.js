// The order main-process plugins activate in at boot. Pure (no Electron), so
// it is unit-tested directly; loadMainPlugins() in plugins.js is the only
// caller.
//
// A plugin can declare manifest `"dependsOn": ["other-plugin-id"]` to be
// activated after the plugins it depends on — e.g. an audio-piping channel
// plugin depending on ffmpeg-transcode having already published
// ctx.services.ffmpegPath by the time they run. An isolated plugin is handed
// a snapshot of ctx.services when it is forked, so "after" means its
// dependencies have FINISHED activating, not merely started.

// Stable Kahn's-algorithm-style pass: repeatedly peel off any not-yet-placed
// plugin whose deps are all already placed. A plugin with a missing/disabled/
// circular dependency is still appended at the end (rather than dropped) so
// its own activate() gets a chance to run and surface a clear error, instead
// of it silently vanishing from the list.
function orderByDependencies(plugins) {
  const placed = new Set();
  const ordered = [];
  let remaining = plugins.slice();
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    remaining = remaining.filter((plugin) => {
      if (plugin.dependsOn.every((depId) => placed.has(depId))) {
        ordered.push(plugin);
        placed.add(plugin.id);
        progress = true;
        return false;
      }
      return true;
    });
  }
  ordered.push(...remaining);
  return ordered;
}

// Runs `run(plugin)` for every plugin, at most `limit` at a time, starting
// each one as soon as every plugin it dependsOn has finished — so plugins
// with nothing in common start together instead of each waiting for the
// last one's process to come up (the whole chain used to hold the window
// back for ~100 ms per isolated plugin). A dependency outside `plugins`
// (not installed, disabled, awaiting approval) is not waited for; it was
// never going to finish. Ties go to list order, so feeding this
// orderByDependencies()'s result keeps the old order wherever a choice
// exists. A cycle can never become ready: once nothing else is running, its
// first member starts anyway, the same "run it so it can report" choice
// orderByDependencies makes. `run` should handle its own errors; a
// rejection is still treated as finished so its dependents aren't stranded.
function runInDependencyOrder(plugins, run, limit = Infinity) {
  const ids = new Set(plugins.map((plugin) => plugin.id));
  const finished = new Set();
  const waiting = plugins.slice();
  let running = 0;
  return new Promise((resolve) => {
    const pump = () => {
      while (running < limit && waiting.length) {
        let index = waiting.findIndex((plugin) => plugin.dependsOn.every((dep) => !ids.has(dep) || finished.has(dep)));
        if (index === -1) {
          if (running) break;
          index = 0;
        }
        const [plugin] = waiting.splice(index, 1);
        running += 1;
        Promise.resolve()
          .then(() => run(plugin))
          .catch(() => {})
          .then(() => {
            running -= 1;
            finished.add(plugin.id);
            pump();
          });
      }
      if (!waiting.length && !running) resolve();
    };
    pump();
  });
}

module.exports = { orderByDependencies, runInDependencyOrder };
