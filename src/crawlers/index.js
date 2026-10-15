// Chọn crawler theo URL. Thêm nguồn mới (vd Xiaohongshu): tạo file cùng dạng pinterest.js
// (export name, match(url), async* crawl(ctx, url, opts) → {id, url}) rồi thêm vào CRAWLERS.
import * as pinterest from './pinterest.js';

const CRAWLERS = [pinterest];

export function crawlerFor(url) {
    const c = CRAWLERS.find(c => c.match(url));
    if (!c) throw new Error(`Chưa hỗ trợ crawl nguồn này: ${url}`);
    return c;
}
