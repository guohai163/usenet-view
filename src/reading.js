export const articleColumns = {
  subject: { label: '主题', value: 'lower(subject) COLLATE "C"', defaultDirection: 'asc' },
  author: { label: '作者', value: 'lower(author) COLLATE "C"', defaultDirection: 'asc' },
  date: { label: '日期', value: "coalesce(posted_at, '-infinity'::timestamptz)", defaultDirection: 'desc' },
  number: { label: '编号', value: 'number', defaultDirection: 'desc' },
};

export function searchText(input) {
  return (input ?? '').replaceAll('\0', '').trim().slice(0, 160);
}

export function articleFilters(params) {
  const requested = params.get('sort');
  const sort = Object.hasOwn(articleColumns, requested) ? requested : 'number';
  const requestedDirection = params.get('order');
  const direction = ['asc', 'desc'].includes(requestedDirection)
    ? requestedDirection : articleColumns[sort].defaultDirection;
  return { sort, direction, search: searchText(params.get('find')) };
}
