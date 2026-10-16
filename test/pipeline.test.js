import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {IdStore, parseSchedule, pickSlot, planDay, shuffle} from '../src/pipeline.js';
import {extractVideos} from '../src/crawlers/pinterest.js';
import {crawlerFor} from '../src/crawlers/index.js';
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
    const a = new IdStore(file);
    a.add('1'); a.add('1'); a.add('2');
    const b = new IdStore(file);
    assert.ok(b.has('1') && b.has('2'));
    assert.equal(b.size, 2);
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
    assert.throws(() => crawlerFor('https://www.xiaohongshu.com/explore'), /Chưa hỗ trợ/);
});
