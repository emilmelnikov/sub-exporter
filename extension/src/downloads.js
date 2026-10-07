import { toCsv, csvFilename } from "./csv.js";

// Keep ownership through the Save As dialog, download events, and the final
// search. Late callbacks can only finish their own job, never a newer download.
export function createCsvDownloader({ downloads = chrome.downloads, onState = () => {} } = {}) {
  let active = null;

  function finish(job, state) {
    if (active !== job) return;
    active = null;
    if (job.url) URL.revokeObjectURL(job.url);
    onState(job.owner, state);
  }

  downloads.onChanged.addListener((delta) => {
    if (active?.id === delta.id && ["complete", "interrupted"].includes(delta.state?.current)) finish(active, delta.state.current);
  });

  return {
    get busy() { return active !== null; },
    async start(owner) {
      if (!owner || active) return;
      const job = { owner, id: null, url: null };
      active = job;
      onState(owner, "saving");
      try {
        job.url = URL.createObjectURL(new Blob([toCsv(owner.rows, owner.options)], { type: "text/csv;charset=utf-8" }));
        job.id = await downloads.download({
          url: job.url, filename: csvFilename(owner.job.platform, owner.job.creator), saveAs: true,
        });
      } catch {
        finish(job, "interrupted");
        return;
      }
      try {
        // A small download can finish before its ID is returned, so its event
        // could have arrived too early to match the job.
        const [item] = await downloads.search({ id: job.id });
        if (["complete", "interrupted"].includes(item?.state)) finish(job, item.state);
      } catch { /* A failed status lookup does not interrupt the download. Keep listening. */ }
    },
  };
}
