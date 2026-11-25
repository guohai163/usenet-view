const layout = document.querySelector('.layout');
const pane = document.querySelector('[data-active-number]');
const links = document.querySelectorAll('.message-link');

if (layout?.dataset.group) {
  const key = 'cnusenet.read:' + layout.dataset.catalog + ':' + layout.dataset.group;
  const read = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(stored)) stored.forEach(number => read.add(number));
  } catch {
    // Reading and navigation still work when storage is unavailable.
  }

  if (pane?.dataset.explicit === 'true' || (pane && matchMedia('(min-width: 801px)').matches)) {
    read.add(pane.dataset.activeNumber);
    try {
      localStorage.setItem(key, JSON.stringify([...read].slice(-3000)));
    } catch {
      // The current page can still show which article was opened.
    }
  }

  for (const link of links) {
    const hasRead = read.has(link.dataset.number);
    link.classList.toggle('unread', !hasRead);
    link.querySelector('.read-dot').title = hasRead ? '已读' : '未读';
  }

  for (const selected of [document.querySelector('.message-link[aria-current]'), document.querySelector('.group-list a[aria-current]')]) {
    const scroller = selected?.closest('.message-scroll, .directory-scroll');
    if (scroller) {
      const distance = selected.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
      if (distance > 0) scroller.scrollTop += distance;
    }
  }
}

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!['j', 'k'].includes(event.key)) return;
  const link = document.querySelector('[data-shortcut="' + event.key + '"]');
  if (link) {
    event.preventDefault();
    link.click();
  }
});
