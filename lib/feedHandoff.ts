/** A short dwell filters reversals without waiting for the whole snap animation. */
export function createFeedHandoff(commit: (id: string) => void, delay = 80) {
  let candidate: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; candidate = null; };
  const flush = () => {
    const id = candidate;
    cancel();
    if (id) commit(id);
  };
  return {
    propose(id: string | null) {
      if (id === candidate) return;
      cancel();
      candidate = id;
      if (id) timer = setTimeout(flush, delay);
    },
    flush,
    cancel,
  };
}
