import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {IdStore, Pipeline, parseSchedule, pickSlot, planDay, shuffle} from '../src/pipeline.js';
import {parseBeacons, needRefresh, refreshLinks, loadLinks} from '../src/affLinks.js';
import {parseCount, collectReels, pickReels, pickProduct, buildComment, loadHistory, saveHistory, commentReels} from '../src/fbComment.js';
import {extractVideos} from '../src/crawlers/pinterest.js';
import {crawlerFor} from '../src/crawlers/index.js';
import {extractVideoUrl} from '../src/crawlers/xiaohongshu.js';
import {pickHumanSession, parseMinutes} from '../src/human.js';

test('extractVideos lấy id + videoUrl, bỏ event không có video', () => {
    const json = {resource: {options: {events: [
        {object_id_str: '111', event_data: {videoUrl: 'https://v1.pinimg.com/videos/a.m3u8'}},
        {object_id_str: '222', event_data: {}},
        {event_data: {videoUrl: 'https://x/no-id.mp4'}},
    ]}}};
    assert.deepEqual(extractVideos(json), [{id: '111', url: 'https://v1.pinimg.com/videos/a.m3u8'}]);
    assert.deepEqual(extractVideos({resource_response: {error: {}}}), []);
    // body form "data=" là chuỗi JSON, event_data cũng là chuỗi, id dạng số
    const data = JSON.stringify({options: {events: [{object_id: 333, event_data: JSON.stringify({videoUrl: 'https://v/b.mp4'})}]}});
    assert.deepEqual(extractVideos(new URLSearchParams(`data=${encodeURIComponent(data)}`).get('data')),
        [{id: '333', url: 'https://v/b.mp4'}]);
});

test('IdStore lưu id bền vững, không trùng', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-')), 'ids.txt');
    fs.writeFileSync(file, 'old\n'); // dòng cũ chỉ có id
    const a = new IdStore(file);
    a.add('1', 'Pinterest'); a.add('1', 'Pinterest'); a.add('2', 'Xiaohongshu');
    const b = new IdStore(file);
    assert.ok(b.has('old') && b.has('1') && b.has('2'));
    assert.equal(b.size, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Pinterest\told\nPinterest\t1\nXiaohongshu\t2\n'); // dòng cũ được migrate
});

test('parseSchedule đọc khung giờ, giờ đơn, khung qua nửa đêm, báo lỗi sai định dạng', () => {
    assert.deepEqual(parseSchedule('20:00-21:30, 08:00-09:00; 12:15'),
        [{start: 480, end: 540}, {start: 735, end: 735}, {start: 1200, end: 1290}]);
    assert.deepEqual(parseSchedule('23:30-00:30'), [{start: 1410, end: 1470}]);
    assert.throws(() => parseSchedule('25:00-26:00'));
});

test('pickSlot chọn phút random trong khung, mỗi khung 1 lần, sang ngày mai khi hết', () => {
    const slots = parseSchedule('08:00-09:00, 20:00-21:00');
    const at = (h, m, d = 14) => new Date(2026, 9, d, h, m).getTime();

    // 07:00 → khung 08-09, rand=0.5 → 08:30
    let s = pickSlot(slots, at(7, 0), 0, () => 0.5);
    assert.equal(s.start, at(8, 0));
    assert.equal(s.at, at(8, 30));

    // 08:40 đang trong khung → random trong phần còn lại [08:40, 09:00)
    s = pickSlot(slots, at(8, 40), 0, () => 0.5);
    assert.equal(s.at, at(8, 50));

    // khung 08-09 đã dùng → nhảy sang 20-21
    s = pickSlot(slots, at(8, 45), at(8, 0), () => 0);
    assert.equal(s.start, at(20, 0));

    // 21:30 hết khung hôm nay → 08:00 hôm sau
    s = pickSlot(slots, at(21, 30), at(20, 0), () => 0);
    assert.equal(s.start, at(8, 0, 15));

    // khoảng cách tối thiểu đẩy mốc sớm nhất tới 20:30 → random từ 20:30 trong khung 20-21
    s = pickSlot(slots, at(20, 30), at(8, 0), () => 0);
    assert.equal(s.at, at(20, 30));

    // random luôn nằm trong khung
    for (let i = 0; i < 200; i++) {
        const r = pickSlot(slots, at(7, 0));
        assert.ok(r.at >= at(8, 0) && r.at < at(9, 0));
    }
});

test('planDay lên lịch hết ngày, tăng dần, bỏ khung đã dùng', () => {
    const slots = parseSchedule('08:00-09:00, 20:00-21:00');
    const at = (h, m, d = 14) => new Date(2026, 9, d, h, m).getTime();
    const p = planDay(slots, at(8, 30), 0, () => 0);
    assert.deepEqual(p.map(s => s.at), [at(8, 30), at(20, 0)]);
    assert.deepEqual(planDay(slots, at(8, 30), at(8, 0), () => 0).map(s => s.start), [at(20, 0)]);
    // hết khung hôm nay → lên cả ngày mai
    assert.deepEqual(planDay(slots, at(21, 30), at(20, 0), () => 0).map(s => s.start), [at(8, 0, 15), at(20, 0, 15)]);
});



test('version: newer + sameShell', async () => {
    const {newer, sameShell} = await import('../src/version.js');
    assert.ok(newer('1.0.10', '1.0.9'));
    assert.ok(!newer('1.0.0', '1.0.0'));
    assert.ok(!newer('0.9.9', '1.0.0'));
    const a = {dependencies: {playwright: '^1'}, devDependencies: {electron: '^41'}};
    assert.ok(sameShell(a, {dependencies: {playwright: '^1'}}, '41.10.7'));
    assert.ok(!sameShell(a, {dependencies: {playwright: '^1'}}, '42.0.0'));
    assert.ok(!sameShell(a, {dependencies: {playwright: '^2'}}, '41.10.7'));
});

test('transform: tuỳ chọn kết hợp + zoom che hết viền đen khi xoay', async () => {
    const {buildArgs, minZoom, tfEnabled, tfTag} = await import('../src/transform.js');
    const main = {audio: true, duration: 10};
    const all = {tfRotate: true, tfColor: true, tfFps: true, tfAudio: true};
    for (const r of [0, 0.5, 0.999]) {
        const g = buildArgs({input: 'a.mp4', output: 'o.mp4', main, opts: all, rand: () => r}).join(' ');
        const rad = Math.abs(Number(/rotate=(-?[\d.]+)/.exec(g)[1]));
        assert.ok(rad >= Math.PI / 180 - 1e-4 && rad <= 2 * Math.PI / 180 + 1e-4);
        const [, w, h] = /\[base\]scale=(\d+):(\d+)/.exec(g).map(Number);
        assert.ok(w / 1080 >= minZoom(rad) && h / 1920 >= minZoom(rad));
        assert.match(g, /eq=contrast=.*setpts=PTS\/[\d.]+,fps=2[45],setsar=1\[v\]/);
        assert.match(g, /asetrate=\d+,aresample=44100\[a\]/);
    }
    // PiP có tiếng + pitch + xoay: trộn 2 tiếng, -t bù theo tốc độ, ép fps=30, PiP đè lên sau khi xoay
    const s = buildArgs({input: 'a.mp4', output: 'o.mp4', main, pip: {file: 'p.mp4', audio: true},
        opts: {tfAudio: true, tfRotate: true, tfPip: true}, rand: () => 0}).join(' ');
    assert.match(s, /-stream_loop -1 -i p\.mp4/);
    assert.match(s, /\[base\]scale=\d+:\d+,rotate=.*fps=30.*\[m\];\[1:v\]scale=\d+:-2.*\[m\]\[pip\]overlay=W-w-40:160:shortest=1\[v\]/);
    assert.match(s, /\[0:a\]\[1:a\]amix=inputs=2.*asetrate=/);
    assert.match(s, /-t 10\.204 /); // 10s / 0.98
    // chỉ PiP, video gốc không tiếng, PiP không tiếng → -an
    const p = buildArgs({input: 'a.mp4', output: 'o.mp4', main: {audio: false, duration: 5}, pip: {file: 'p.mp4', audio: false},
        opts: {tfPip: true}}).join(' ');
    assert.match(p, /\[1:v\]scale=.*overlay=W-w-40:160/);
    assert.match(p, / -an .*-c:v libx264 -preset fast -crf 20/);
    assert.ok(!tfEnabled({}) && tfEnabled({tfColor: true}) && tfEnabled({tfPip: true}));
    assert.equal(tfTag({tfRotate: true, tfAudio: true, tfPip: true}), 'xoay-pitch-pip');
});

test('randomOpts: chọn ≥1 hiệu ứng trong các ô đã tick', async () => {
    const {randomOpts, tfTag} = await import('../src/transform.js');
    const off = {tfRotate: false, tfColor: true, tfFps: false, tfAudio: true};
    assert.equal(randomOpts(off), off); // tắt random → giữ nguyên
    const o = {...off, tfRandom: true};
    for (const r of [0, 0.3, 0.7, 0.999]) {
        const x = randomOpts(o, () => r);
        const tags = tfTag(x).split('-');
        assert.ok(tags.length >= 1 && tags.every(t => ['mau', 'pitch'].includes(t)), tfTag(x));
    }
    assert.equal(tfTag(randomOpts(o, () => 0)), 'mau-pitch'); // rand < 0.5 → lấy hết
    // không tick ô nào → random trong tất cả
    assert.equal(tfTag(randomOpts({tfRandom: true, reactionPath: 'package.json'}, () => 0)), 'xoay-mau-fps-pitch-pip');
    // không có reaction → không bao giờ chọn PiP
    assert.equal(tfTag(randomOpts({tfRandom: true}, () => 0)), 'xoay-mau-fps-pitch');
    assert.equal(tfTag(randomOpts({tfRandom: true, tfPip: true}, () => 0)), 'xoay-mau-fps-pitch');
});

test('shuffle: giữ đủ phần tử, đổi thứ tự theo rand, không sửa mảng gốc', () => {
    const src = ['a', 'b', 'c', 'd'];
    const out = shuffle(src, () => 0);
    assert.deepEqual(out, ['b', 'c', 'd', 'a']);
    assert.deepEqual([...out].sort(), src);
    assert.deepEqual(src, ['a', 'b', 'c', 'd']);
});

test('pickHumanSession: lo–hi phút, chừa 2 phút trước giờ đăng', () => {
    const M = 60_000, day = new Date(2026, 0, 1, 10, 0).getTime();
    assert.equal(pickHumanSession(day, day + 3 * M), null);
    assert.equal(pickHumanSession(day, day + 120 * M, [3, 12], () => 0), day + 3 * M);
    assert.equal(pickHumanSession(day, day + 120 * M, [3, 12], () => 1), day + 12 * M);
    assert.equal(pickHumanSession(day, day + 8 * M, [3, 12], () => 1), day + 6 * M);
    assert.equal(pickHumanSession(day, day + 120 * M, [5, 5], () => 0.7), day + 5 * M);
});

test('parseMinutes đọc "3-12" / "5", báo lỗi khi sai', () => {
    assert.deepEqual(parseMinutes('3-12'), [3, 12]);
    assert.deepEqual(parseMinutes(' 5 '), [5, 5]);
    for (const bad of ['', '12-3', 'abc', '0-5']) assert.throws(() => parseMinutes(bad));
});

test('crawlerFor chọn crawler theo host, nguồn lạ thì báo lỗi', () => {
    assert.equal(crawlerFor('https://www.pinterest.com/search/videos/?q=a').name, 'Pinterest');
    assert.equal(crawlerFor('https://vn.pinterest.com/pin/1/').name, 'Pinterest');
    assert.equal(crawlerFor('https://www.rednote.com/search_result?keyword=a').name, 'Xiaohongshu');
    assert.equal(crawlerFor('https://www.xiaohongshu.com/explore').name, 'Xiaohongshu');
    assert.throws(() => crawlerFor('https://www.youtube.com/watch?v=1'), /Chưa hỗ trợ/);
});

test('extractVideoUrl lấy data.items[0].note_card.video.media.stream.h264[0].master_url', () => {
    assert.equal(extractVideoUrl({data: {items: [{note_card: {video: {media: {stream: {h265: [{master_url: 'https://x/h5.mp4'}], h264: [{master_url: 'https://x/v.mp4'}]}}}}}]}}), 'https://x/v.mp4');
    assert.equal(extractVideoUrl({data: {items: [{note_card: {video: {media: {stream: {h264: [{master_url: 'https://x/h.mp4'}]}}}}}]}}), 'https://x/h.mp4');
    assert.equal(extractVideoUrl({data: {items: []}}), null);
});

// ---------- FEAT-003: comment link aff ----------
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-aff-'));
const btn = (href, title, name) => `<a class="MuiButtonBase-root MuiButton-root MuiButton-contained" tabindex="0"${href ? ` href="${href}"` : ''} aria-label="${title}">`
    + `<div class="mr-2"><img alt="link" src="x.webp"></div><div class="w-full"><div class="text-lg-normal">${title}</div>`
    + `${name ? `<div class="text-sm-normal">${name}</div>` : ''}</div><span class="MuiTouchRipple-root"></span></a>`;

test('TC-1 parseBeacons: mỗi nút → {link, name}', () => {
    const html = `<html><body><a href="https://beacons.ai/">logo</a>${btn('https://s.shopee.vn/9pfaSCmmvv', 'Súp Thưởng', 'Súp Thưởng Cho Mèo S2PET 15g')}`
        + `${btn('https://s.shopee.vn/a', 'Cát', 'Cát vệ sinh &amp; khử mùi')}${btn('https://s.shopee.vn/b', 'Pate', 'Pate mèo')}</body></html>`;
    assert.deepEqual(parseBeacons(html), [
        {link: 'https://s.shopee.vn/9pfaSCmmvv', name: 'Súp Thưởng Cho Mèo S2PET 15g'},
        {link: 'https://s.shopee.vn/a', name: 'Cát vệ sinh & khử mùi'},
        {link: 'https://s.shopee.vn/b', name: 'Pate mèo'},
    ]);
});

test('TC-2 parseBeacons: bỏ nút thiếu name/href, bỏ trùng link', () => {
    const html = btn('https://s.shopee.vn/a', 'A', '') + btn('', 'B', 'Tên B') + btn('https://s.shopee.vn/c', 'C', 'Tên C')
        + btn('https://s.shopee.vn/c', 'C2', 'Tên C lặp');
    assert.deepEqual(parseBeacons(html), [{link: 'https://s.shopee.vn/c', name: 'Tên C'}]);
    assert.deepEqual(parseBeacons(''), []);
});

test('TC-3/TC-5 needRefresh: <24h false, >24h / không có file / file hỏng true', () => {
    const file = path.join(tmpDir(), 'link.update');
    const now = Date.now(), H = 3_600_000;
    assert.equal(needRefresh(file, now), true);
    const write = (ago, items = [{link: 'L', name: 'N'}]) => fs.writeFileSync(file, JSON.stringify({updatedAt: new Date(now - ago).toISOString(), items}));
    write(23 * H);
    assert.equal(needRefresh(file, now), false);
    write(25 * H);
    assert.equal(needRefresh(file, now), true);
    write(H, []);
    assert.equal(needRefresh(file, now), true);
    fs.writeFileSync(file, '{hỏng');
    assert.equal(needRefresh(file, now), true);
    assert.deepEqual(loadLinks(path.dirname(file)), []);
});

test('TC-4 refreshLinks: lỗi hoặc 0 link → giữ file cũ; có link → ghi file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'link.update');
    const old = JSON.stringify({updatedAt: '2020-01-01T00:00:00.000Z', items: [{link: 'old', name: 'cũ'}]});
    fs.writeFileSync(file, old);
    const ctx = (content, gotoErr) => ({newPage: async () => ({
        goto: async () => { if (gotoErr) throw new Error(gotoErr); },
        waitForSelector: async () => {}, content: async () => content, close: async () => {},
    })});
    assert.equal(await refreshLinks(ctx('', 'timeout'), dir), null);
    assert.equal(await refreshLinks(ctx('<html>trống</html>'), dir), null);
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    const items = await refreshLinks(ctx(btn('https://s.shopee.vn/x', 'X', 'Tên X')), dir);
    assert.deepEqual(items, [{link: 'https://s.shopee.vn/x', name: 'Tên X'}]);
    assert.deepEqual(loadLinks(dir), items);
    assert.equal(needRefresh(file), false);
});

const ids = n => Array.from({length: n}, (_, i) => `r${i + 1}`);
const P = (...links) => links.map(l => ({link: l, name: `SP ${l}`}));

test('TC-6 pickReels: 30 reel, N=5 → ~70% từ 10 reel đầu, không trùng', () => {
    for (const r of [0, 0.5, 0.99]) {
        const out = pickReels(ids(30), 5, {}, P('A'), 0.7, 10, () => r);
        assert.equal(new Set(out).size, 5);
        const fresh = out.filter(id => ids(10).includes(id)).length;
        assert.ok(fresh >= 3 && fresh <= 4, `mới ${fresh}`);
    }
});

test('TC-7 pickReels: nhóm thiếu thì bù từ nhóm kia', () => {
    const out = pickReels(ids(12), 10, {}, P('A'));
    assert.equal(new Set(out).size, 10);
    assert.ok(out.includes('r11') && out.includes('r12'));
    // nhóm mới chỉ còn r1 khả dụng → bù từ nhóm cũ
    const history = Object.fromEntries(ids(10).slice(1).map(id => [id, ['A']]));
    const out2 = pickReels(ids(30), 5, history, P('A'));
    assert.equal(out2.length, 5);
    assert.ok(out2.includes('r1') && out2.filter(id => !ids(10).includes(id)).length === 4);
});

test('TC-8 pickReels: N lớn hơn số reel khả dụng → chỉ chọn số khả dụng; 0 reel → rỗng', () => {
    assert.deepEqual(pickReels(['a', 'b'], 5, {}, P('A')).sort(), ['a', 'b']);
    assert.deepEqual(pickReels([], 5, {}, P('A')), []);
    assert.deepEqual(pickReels(['a'], 5, {}, []), []);
});

test('TC-9 parseCount: sai → 2-5, đảo khoảng, số đơn', () => {
    assert.deepEqual(parseCount('abc'), [2, 5]);
    assert.deepEqual(parseCount(''), [2, 5]);
    assert.deepEqual(parseCount('0-3'), [2, 5]);
    assert.deepEqual(parseCount('5-2'), [2, 5]);
    assert.deepEqual(parseCount(' 3 '), [3, 3]);
    assert.deepEqual(parseCount('2-5'), [2, 5]);
});

test('TC-10 collectReels: cuộn tối đa 3 lần, đủ reel thì dừng sớm, bỏ trùng', async () => {
    const fake = () => {
        const page = {scrolls: 0, mouse: {wheel: async () => { page.scrolls++; }}};
        page.$$eval = async () => [...Array.from({length: (page.scrolls + 1) * 2}, (_, i) => `/reel/${i + 1}/?s=tab`), '/reel/1', '/photo/9'];
        return page;
    };
    const p1 = fake();
    assert.deepEqual(await collectReels(p1, 100, 3, 0), ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.equal(p1.scrolls, 3);
    const p2 = fake();
    assert.equal((await collectReels(p2, 4, 3, 0)).length, 4);
    assert.equal(p2.scrolls, 1);
});

test('TC-11/TC-12 pickProduct + reel khả dụng theo lịch sử reel–SP', () => {
    assert.deepEqual(pickProduct('X', P('A', 'B'), {X: ['A']}), P('B')[0]);
    assert.equal(pickProduct('X', P('A', 'B'), {X: ['A', 'B']}), null);
    assert.deepEqual(pickReels(['X', 'Y'], 2, {X: ['A', 'B']}, P('A', 'B')), ['Y']);
});

test('TC-13 pickProduct: cùng lượt ưu tiên SP khác nhau', () => {
    const used = new Set();
    const got = ['r1', 'r2', 'r3'].map(id => {
        const p = pickProduct(id, P('A', 'B', 'C'), {}, used, () => 0);
        used.add(p.link);
        return p.link;
    });
    assert.deepEqual(got, ['A', 'B', 'C']);
});

test('TC-14 buildComment: mẫu {name} 👉 {link}, thiếu {link} thì nối cuối', () => {
    const item = {link: 'https://s.shopee.vn/x', name: 'Súp $& mèo'};
    assert.equal(buildComment('{name} 👉 {link}', item), 'Súp $& mèo 👉 https://s.shopee.vn/x');
    assert.equal(buildComment('', item), 'Súp $& mèo 👉 https://s.shopee.vn/x');
    assert.equal(buildComment('Mua {name}', item), 'Mua Súp $& mèo https://s.shopee.vn/x');
});

const fakeCtx = () => {
    const ctx = {opened: 0, newPage: async () => {
        ctx.opened++;
        return {goto: async () => {}, url: () => 'https://www.facebook.com/x', close: async () => {}, keyboard: {press: async () => {}}};
    }};
    return ctx;
};
const runCfg = dataDir => ({dataDir, fbProfileUrl: 'https://www.facebook.com/x', fbCommentCount: '4', fbCommentTemplate: '{name} 👉 {link}'});

test('TC-15 lịch sử: file hỏng → rỗng; comment OK → ghi {reelId: [link]}', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'commented_reels.json'), '[hỏng');
    assert.deepEqual(loadHistory(dir), {});
    const texts = [];
    await commentReels(fakeCtx(), {...runCfg(dir), fbCommentCount: '1'}, P('A'), {
        collect: async () => ['111'], comment: async (_, id, text) => texts.push(text), wait: async () => {}, stepMs: 0,
    });
    assert.deepEqual(texts, ['SP A 👉 A']);
    assert.deepEqual(loadHistory(dir), {111: ['A']});
    saveHistory(dir, {1: ['x']});
    assert.deepEqual(loadHistory(dir), {1: ['x']});
});

test('TC-16 reel lỗi → bỏ qua, các reel sau vẫn chạy, 1 tin Telegram nêu reel lỗi', async () => {
    const dir = tmpDir(), called = [], msgs = [];
    const res = await commentReels(fakeCtx(), runCfg(dir), P('A', 'B', 'C', 'D'), {
        collect: async () => ['1', '2', '3', '4'],
        comment: async (_, id) => { called.push(id); if (id === '2') throw new Error('không thấy ô bình luận'); },
        notify: async t => msgs.push(t), wait: async () => {}, stepMs: 0,
    });
    assert.deepEqual(called.sort(), ['1', '2', '3', '4']);
    assert.deepEqual(res.done.sort(), ['1', '3', '4']);
    assert.ok(!('2' in loadHistory(dir)));
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Reel 2: không thấy ô bình luận/);
});

test('TC-17 không lỗi → không gửi Telegram', async () => {
    const msgs = [];
    const res = await commentReels(fakeCtx(), runCfg(tmpDir()), P('A', 'B'), {
        collect: async () => ['1', '2'], comment: async () => {}, notify: async t => msgs.push(t), wait: async () => {}, stepMs: 0,
    });
    assert.equal(res.done.length, 2);
    assert.equal(msgs.length, 0);
});

test('TC-18 link.update rỗng → không mở trang / reel nào', async () => {
    const ctx = fakeCtx();
    let commented = 0;
    const res = await commentReels(ctx, runCfg(tmpDir()), [], {comment: async () => commented++, stepMs: 0});
    assert.deepEqual(res, {done: [], failed: []});
    assert.equal(ctx.opened, 0);
    assert.equal(commented, 0);
});

test('TC-19 lịch comment: tắt → không có khung; bật → 1 lượt / khung', () => {
    const base = {scheduleEnabled: false, humanEnabled: false, fbEnabled: true, fbCommentTimes: '10:00-11:00, 19:00-20:00'};
    assert.deepEqual(new Pipeline({...base, fbCommentEnabled: false}, {}).commentSlots, []);
    const slots = new Pipeline({...base, fbCommentEnabled: true}, {}).commentSlots;
    assert.equal(slots.length, 2);
    assert.equal(planDay(slots, new Date(2026, 0, 1, 8, 0).getTime()).length, 2);
    assert.throws(() => new Pipeline({...base, fbCommentEnabled: true, fbCommentTimes: ''}, {}), /chưa tick/);
});
