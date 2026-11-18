"use strict";

function createReadingSession(plugin) {
  let queue = Promise.resolve();
  function persist() {
    const save = queue.then(() => plugin.saveData(plugin.settings));
    queue = save.catch(() => {});
    return save;
  }
  function remember(path, title, position = null) {
    const previous = plugin.settings.readingHistory || [];
    const old = previous.find((r) => r.path === path);
    const entry = { path, title, updatedAt: Date.now(), position: position || old?.position || null };
    plugin.settings.readingHistory = [entry, ...previous.filter((r) => r.path !== path)].slice(0, 40);
    return persist();
  }
  function position(path) { return (plugin.settings.readingHistory || []).find((r) => r.path === path)?.position || null; }
  function rekey(oldFolder, newFolder) {
    plugin.settings.readingHistory = (plugin.settings.readingHistory || []).map((r) => {
      if (r.path === oldFolder || r.path.startsWith(oldFolder + "/")) return { ...r, path: newFolder + r.path.slice(oldFolder.length) };
      return r;
    });
    return persist();
  }
  return { remember, position, rekey, flush: () => queue };
}

module.exports = { createReadingSession };
